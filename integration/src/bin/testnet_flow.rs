//! End-to-end on the public testnet with two in-process wallets (same account shape as Bread):
//! champion posts a record note, rival posts a shot note and settles with a LOSING answer
//! (the stake is forfeited to the champion as a public P2ID), then a second rival wins and
//! CLAIMS record + stake in one transaction.
//!
//!   cargo run --release --bin geocoin deploy        # once
//!   cargo run --release --bin testnet_flow
//!
//! Prints every transaction id (https://testnet.midenscan.com/tx/<id>).

use std::{sync::Arc, time::Duration};

use anyhow::{Context, Result};
use integration::{
    deadline_advice,
    faucet_api::{request_fee_tokens, TESTNET_FAUCET_API},
    funding::ensure_accounts_funded,
    helpers::{create_basic_wallet_account, setup_client, wait_for_commit, AccountCreationConfig},
    quiz::GqGameData,
    rules::{answer_advice, Answer, City, ROUNDS, VECTOR_CITIES},
    scripts::{shot_script, record_script},
    storage::ChallengeStorage,
    NOTE_TAG,
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

const STAKE: u64 = 1_000_000; // 1 GC
const PRIZE: u64 = STAKE; // the champion stakes the same amount as the rivals
const LIFETIME_BLOCKS: u32 = 2_000;
const SHOT_WINDOW_BLOCKS: u32 = 200;
const CITIES: [City; ROUNDS] = VECTOR_CITIES;

#[tokio::main]
async fn main() -> Result<()> {
    let state: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../geocoin.json"))?)?;
    let gq = AccountId::from_hex(state["geocoin"].as_str().context("run geocoin deploy first")?)?;

    let setup = setup_client().await?;
    let mut client = setup.client;
    let keystore = setup.keystore;
    client.add_note_tag(NoteTag::new(NOTE_TAG)).await?;
    client.sync_state().await?;

    let cfg = || AccountCreationConfig { account_type: AccountType::Private };
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

    // --- champion posts the record
    let chain_tip = client.get_sync_height().await?.as_u32();
    let shot = shot_script()?;
    let record_storage = ChallengeStorage::record(
        chain_tip + LIFETIME_BLOCKS,
        2_000, // target: beat 2000 points
        STAKE,
        champion.id(),
        Word::from(shot.root()),
        GqGameData { seed: draw_word(client.rng()), dataset: Word::default(), cities: CITIES }.to_felts(),
    );
    let record = make_note(&mut client, champion.id(), record_script()?, &record_storage, FungibleAsset::new(gq, PRIZE)?)?;
    post(&mut client, champion.id(), &record).await?;
    println!("record note {}", record.id().to_hex());

    // --- loser challenges and settles with a losing answer: stake forfeited to the champion
    let storage = record_storage.shot_for(loser.id(), record.id(), client.get_sync_height().await?.as_u32() + SHOT_WINDOW_BLOCKS);
    let ch = make_note(&mut client, loser.id(), shot.clone(), &storage, FungibleAsset::new(gq, STAKE)?)?;
    post(&mut client, loser.id(), &ch).await?;
    let bad = CITIES.map(|c| Answer { lat: (c.lat + 9000) % 18000, lon: c.lon, t: 100 });
    consume(&mut client, loser.id(), &[&ch], &bad).await?;
    println!("loser settled: stake forfeited (public P2ID to the champion)");

    // --- winner challenges and claims record + stake
    let storage = record_storage.shot_for(winner.id(), record.id(), client.get_sync_height().await?.as_u32() + SHOT_WINDOW_BLOCKS);
    let ch = make_note(&mut client, winner.id(), shot, &storage, FungibleAsset::new(gq, STAKE)?)?;
    post(&mut client, winner.id(), &ch).await?;
    let good = CITIES.map(|c| Answer { lat: c.lat, lon: c.lon, t: 200 });
    consume(&mut client, winner.id(), &[&record, &ch], &good).await?;
    println!("winner claimed record + stake");

    client.sync_state().await?;
    for (name, a) in [("champion", &champion), ("loser", &loser), ("winner", &winner)] {
        let acc = client.get_account(a.id()).await?.context("account")?;
        let bal = acc.vault().get_balance(FungibleAsset::new(gq, 1)?.id())?.as_u64();
        println!("{name} GC balance: {}", bal as f64 / 1e6);
    }
    Ok(())
}

fn make_note(client: &mut C, sender: AccountId, script: NoteScript, storage: &ChallengeStorage, asset: FungibleAsset) -> Result<Note> {
    let recipient = NoteRecipient::new(draw_word(client.rng()), script, NoteStorage::new(storage.to_felts())?);
    let metadata = PartialNoteMetadata::new(sender, NoteType::Public).with_tag(NoteTag::new(NOTE_TAG));
    Ok(Note::new(NoteAssets::new(vec![asset.into()])?, metadata, recipient))
}

async fn post(client: &mut C, account: AccountId, note: &Note) -> Result<()> {
    let request = TransactionRequestBuilder::new().own_output_notes(vec![note.clone()]).build()?;
    let tx = client.submit_new_transaction(account, request).await?;
    println!("  post tx {}", tx.to_hex());
    wait_for_commit(client, tx).await
}

async fn consume(client: &mut C, account: AccountId, notes: &[&Note], answers: &[Answer; ROUNDS]) -> Result<()> {
    // the notes are public and tagged NOTE_TAG, so a sync brings them into the store
    client.sync_state().await?;
    let owned: Vec<Note> = notes.iter().map(|n| (*n).clone()).collect();
    let (commitment, packed) = answer_advice(answers);
    let mut advice = deadline_advice(Word::from(shot_script()?.root()), &owned);
    advice.push((commitment, packed));
    let request = TransactionRequestBuilder::new()
        .input_notes(notes.iter().map(|n| ((*n).clone(), Some(commitment))))
        .extend_advice_map(advice)
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
