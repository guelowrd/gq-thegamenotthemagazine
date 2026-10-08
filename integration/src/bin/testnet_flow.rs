//! End-to-end on the public testnet with two in-process wallets (same account shape as Bread):
//! champion posts a prize note, challenger posts a challenge note and settles with a LOSING answer
//! (the stake is forfeited to the champion as a public P2ID), then a second challenger wins and
//! CLAIMS prize + stake in one transaction.
//!
//!   cargo run --release --bin gq_faucet deploy        # once
//!   cargo run --release --bin testnet_flow
//!
//! Prints every transaction id (https://testnet.midenscan.com/tx/<id>).

use std::{sync::Arc, time::Duration};

use anyhow::{Context, Result};
use integration::{
    faucet_api::{request_fee_tokens, TESTNET_FAUCET_API},
    felt,
    funding::ensure_accounts_funded,
    helpers::{create_basic_wallet_account, setup_client, wait_for_commit, AccountCreationConfig},
    rules::{pack_answers, Answer, City, ROUNDS},
    scripts::{challenge_script, prize_script},
    storage::{ChallengeStorage, GqGameData},
    GQ_TAG,
};
use miden_client::{
    account::{Account, AccountId, AccountType},
    asset::FungibleAsset,
    keystore::FilesystemKeyStore,
    note::{Note, NoteAssets, NoteRecipient, NoteScript, NoteStorage, NoteTag, NoteType, PartialNoteMetadata},
    rng::draw_word,
    transaction::TransactionRequestBuilder,
    Client, Word,
};

type C = Client<FilesystemKeyStore>;

const STAKE: u64 = 1_000_000; // 1 GQ
const PRIZE: u64 = 3_000_000; // 3 GQ
const LIFETIME_BLOCKS: u32 = 2_000;
const CITIES: [City; ROUNDS] = [
    City { idx: 0, lat: 13885, lon: 18235, cos: 66 },
    City { idx: 1, lat: 6709, lon: 13683, cos: 92 },
    City { idx: 2, lat: 12569, lon: 31969, cos: 81 },
    City { idx: 3, lat: 5607, lon: 19842, cos: 83 },
];

#[tokio::main]
async fn main() -> Result<()> {
    let state: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../gq.json"))?)?;
    let gq = AccountId::from_hex(state["gq_faucet"].as_str().context("run gq_faucet deploy first")?)?;

    let setup = setup_client().await?;
    let mut client = setup.client;
    let keystore = setup.keystore;
    client.add_note_tag(NoteTag::new(GQ_TAG)).await?;
    client.sync_state().await?;

    let cfg = || AccountCreationConfig { account_type: AccountType::Private, ..Default::default() };
    let champion = create_basic_wallet_account(&mut client, keystore.clone(), cfg()).await?;
    let loser = create_basic_wallet_account(&mut client, keystore.clone(), cfg()).await?;
    let winner = create_basic_wallet_account(&mut client, keystore.clone(), cfg()).await?;
    for (name, a) in [("champion", &champion), ("loser", &loser), ("winner", &winner)] {
        println!("{name}: {}", a.id().to_hex());
    }

    // fees (USDCx from the public faucet) and GQ (from our faucet) for everyone
    for a in [&champion, &loser, &winner] {
        let note = request_fee_tokens(TESTNET_FAUCET_API, a.id())?;
        println!("fee note for {}: {note}", a.id().to_hex());
    }
    ensure_accounts_funded(&mut client, &[champion.id(), loser.id(), winner.id()]).await?;
    for a in [&champion, &loser, &winner] {
        mint_gq(&mut client, &keystore, gq, a.id(), 5_000_000).await?;
    }

    // --- champion posts the prize
    let chain_tip = client.get_sync_height().await?.as_u32();
    let challenge = challenge_script()?;
    let prize_storage = ChallengeStorage::prize(
        chain_tip + LIFETIME_BLOCKS,
        2_000, // target: beat 2000 points
        STAKE,
        champion.id(),
        Word::from(challenge.root()),
        GqGameData { seed: draw_word(client.rng()), dataset: Word::default(), cities: CITIES }.to_felts(),
    );
    let prize = make_note(&mut client, champion.id(), prize_script()?, &prize_storage, FungibleAsset::new(gq, PRIZE)?)?;
    post(&mut client, champion.id(), &prize).await?;
    println!("prize note {}", prize.id().to_hex());

    // --- loser challenges and settles with a losing answer: stake forfeited to the champion
    let storage = prize_storage.challenge_for(loser.id(), prize.id());
    let ch = make_note(&mut client, loser.id(), challenge.clone(), &storage, FungibleAsset::new(gq, STAKE)?)?;
    post(&mut client, loser.id(), &ch).await?;
    let bad = CITIES.map(|c| Answer { lat: (c.lat + 9000) % 18000, lon: c.lon, t: 100 });
    consume(&mut client, loser.id(), &[(&ch, word(&bad))]).await?;
    println!("loser settled: stake forfeited (public P2ID to the champion)");

    // --- winner challenges and claims prize + stake
    let storage = prize_storage.challenge_for(winner.id(), prize.id());
    let ch = make_note(&mut client, winner.id(), challenge, &storage, FungibleAsset::new(gq, STAKE)?)?;
    post(&mut client, winner.id(), &ch).await?;
    let good = CITIES.map(|c| Answer { lat: c.lat, lon: c.lon, t: 200 });
    consume(&mut client, winner.id(), &[(&prize, word(&good)), (&ch, word(&good))]).await?;
    println!("winner claimed prize + stake");

    client.sync_state().await?;
    for (name, a) in [("champion", &champion), ("loser", &loser), ("winner", &winner)] {
        let acc = client.get_account(a.id()).await?.context("account")?;
        let bal = acc.vault().get_balance(FungibleAsset::new(gq, 1)?.id())?.as_u64();
        println!("{name} GQ balance: {}", bal as f64 / 1e6);
    }
    Ok(())
}

fn word(a: &[Answer; ROUNDS]) -> Word {
    Word::new(pack_answers(a).map(felt))
}

fn make_note(client: &mut C, sender: AccountId, script: NoteScript, storage: &ChallengeStorage, asset: FungibleAsset) -> Result<Note> {
    let recipient = NoteRecipient::new(draw_word(client.rng()), script, NoteStorage::new(storage.to_felts())?);
    let metadata = PartialNoteMetadata::new(sender, NoteType::Public).with_tag(NoteTag::new(GQ_TAG));
    Ok(Note::new(NoteAssets::new(vec![asset.into()])?, metadata, recipient))
}

async fn post(client: &mut C, account: AccountId, note: &Note) -> Result<()> {
    let request = TransactionRequestBuilder::new().own_output_notes(vec![note.clone()]).build()?;
    let tx = client.submit_new_transaction(account, request).await?;
    println!("  post tx {}", tx.to_hex());
    wait_for_commit(client, tx).await
}

async fn consume(client: &mut C, account: AccountId, notes: &[(&Note, Word)]) -> Result<()> {
    // the notes are public and tagged GQ_TAG, so a sync brings them into the store
    client.sync_state().await?;
    let request = TransactionRequestBuilder::new()
        .input_notes(notes.iter().map(|(n, w)| ((*n).clone(), Some(*w))))
        .build()?;
    let tx = client.submit_new_transaction(account, request).await?;
    println!("  consume tx {}", tx.to_hex());
    wait_for_commit(client, tx).await
}

async fn mint_gq(client: &mut C, _keystore: &Arc<FilesystemKeyStore>, faucet: AccountId, target: AccountId, amount: u64) -> Result<()> {
    let request = TransactionRequestBuilder::new()
        .build_mint_fungible_asset(FungibleAsset::new(faucet, amount)?, target, NoteType::Public, client.rng())?;
    let tx = client.submit_new_transaction(faucet, request).await?;
    wait_for_commit(client, tx).await?;
    // consume the minted P2ID
    for _ in 0..60 {
        client.sync_state().await?;
        for (record, _) in client.get_consumable_notes(Some(target)).await? {
            let note: Note = record.try_into()?;
            if !note.assets().iter_fungible().any(|a| a.faucet_id() == faucet) {
                continue;
            }
            let request = TransactionRequestBuilder::new().build_consume_notes(vec![note])?;
            let tx = client.submit_new_transaction(target, request).await?;
            wait_for_commit(client, tx).await?;
            println!("  {} received {} GQ", target.to_hex(), amount as f64 / 1e6);
            return Ok(());
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
    anyhow::bail!("GQ mint note never showed up for {}", target.to_hex())
}

#[allow(dead_code)]
fn _keep(_: &Account) {}
