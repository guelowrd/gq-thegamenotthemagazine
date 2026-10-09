//! MockChain harness shared by the shot tests: a GC faucet, a champion, a rival and a
//! stranger, all standard wallets (the shape Bread creates), plus helpers to post the notes the
//! way the clients do: as output notes of a transaction from the creator's funded wallet.

use std::collections::BTreeMap;

use anyhow::Result;
use integration::{
    answer_advice,
    deadline_advice,
    felt,
    rules::{Answer, City, ROUNDS, VECTOR_CITIES},
    scripts::{shot_script, record_script},
    storage::{ChallengeStorage, GqGameData},
    GQ_TAG,
};
use miden_client::{
    account::{Account, AccountId},
    asset::FungibleAsset,
    auth::AuthSchemeId,
    note::{Note, NoteScript, NoteType, PartialNote},
    transaction::{ExecutedTransaction, RawOutputNote, TransactionExecutorError},
    Word,
};
use miden_standards::{testing::note::NoteBuilder, tx_script::SendNotesTransactionScript};
use miden_testing::{Auth, MockChain};
use rand::{rngs::StdRng, SeedableRng};

pub const STAKE: u64 = 1_000_000; // 1 GC at 6 decimals
pub const PRIZE: u64 = 5_000_000;
pub const FUNDS: u64 = 100_000_000; // every wallet starts with 100 GC
pub const EXPIRY: u32 = 100;
/// A shot must be settled before this block (well before the record expires).
pub const SHOT_DEADLINE: u32 = 40;

pub const CITIES: [City; ROUNDS] = VECTOR_CITIES;

pub fn perfect_answers() -> [Answer; ROUNDS] {
    CITIES.map(|c| Answer { lat: c.lat, lon: c.lon, t: 100 })
}

pub fn losing_answers() -> [Answer; ROUNDS] {
    CITIES.map(|c| Answer { lat: (c.lat + 9000) % 18000, lon: (c.lon + 18000) % 36000, t: 100 })
}


pub fn auth() -> Auth {
    Auth::BasicAuth { auth_scheme: AuthSchemeId::Falcon512Poseidon2 }
}

pub fn game_data(cities: [City; ROUNDS]) -> GqGameData {
    GqGameData {
        seed: Word::new([felt(1), felt(2), felt(3), felt(4)]),
        dataset: Word::new([felt(9), felt(9), felt(9), felt(9)]),
        cities,
    }
}

/// Builds a note with the given script/storage/asset, as the client would.
pub fn build_note(
    sender: AccountId,
    script: NoteScript,
    storage: &ChallengeStorage,
    asset: FungibleAsset,
    seed: u64,
) -> Result<Note> {
    build_note_felts(sender, script, storage.to_felts(), asset, seed)
}

pub fn build_note_felts(
    sender: AccountId,
    script: NoteScript,
    felts: Vec<miden_client::Felt>,
    asset: FungibleAsset,
    seed: u64,
) -> Result<Note> {
    let mut rng = StdRng::seed_from_u64(seed);
    Ok(NoteBuilder::new(sender, &mut rng)
        .script(script)
        .note_storage(felts)?
        .add_assets([asset.into()])
        .note_type(NoteType::Public)
        .tag(GQ_TAG)
        .build()?)
}

pub struct Setup {
    pub chain: MockChain,
    pub faucet: Account,
    pub champion: Account,
    pub rival: Account,
    pub stranger: Account,
    pub record: Note,
    pub record_storage: ChallengeStorage,
    pub shot_script: NoteScript,
    seed: u64,
}

/// Chain with the record note posted by the champion. `target` is the score to beat.
pub fn setup(target: u32) -> Result<Setup> {
    setup_with_cities(target, CITIES)
}

pub fn setup_with_cities(target: u32, cities: [City; ROUNDS]) -> Result<Setup> {
    let mut builder = MockChain::builder();
    let faucet = builder.add_existing_basic_faucet(auth(), "GC", 1_000_000_000, None)?;
    let funds = |faucet: AccountId| FungibleAsset::new(faucet, FUNDS).map(Into::into);
    let champion = builder.add_existing_wallet_with_assets(auth(), [funds(faucet.id())?])?;
    let rival = builder.add_existing_wallet_with_assets(auth(), [funds(faucet.id())?])?;
    let stranger = builder.add_existing_wallet_with_assets(auth(), [funds(faucet.id())?])?;
    let chain = builder.build()?;

    let shot_script = shot_script()?;
    let record_storage = ChallengeStorage::record(
        EXPIRY,
        target,
        STAKE,
        champion.id(),
        Word::from(shot_script.root()),
        game_data(cities).to_felts(),
    );
    let record = build_note(
        champion.id(),
        record_script()?,
        &record_storage,
        FungibleAsset::new(faucet.id(), PRIZE)?,
        1,
    )?;
    let mut s = Setup {
        chain,
        faucet,
        champion: champion.clone(),
        rival,
        stranger,
        record: record.clone(),
        record_storage,
        shot_script,
        seed: 2,
    };
    s.publish(&champion, &record)?;
    Ok(s)
}

impl Setup {
    fn account(&self, id: AccountId) -> &Account {
        [&self.champion, &self.rival, &self.stranger]
            .into_iter()
            .find(|a| a.id() == id)
            .expect("known account")
    }

    /// A shot note by `rival` against the record, holding `amount` of `faucet`.
    pub fn shot_note(
        &mut self,
        rival: AccountId,
        faucet: AccountId,
        amount: u64,
        storage: &ChallengeStorage,
    ) -> Result<Note> {
        self.seed += 1;
        build_note(
            rival,
            self.shot_script.clone(),
            storage,
            FungibleAsset::new(faucet, amount)?,
            self.seed,
        )
    }

    /// The rival's correct shot note for the record, already on chain.
    pub fn standard_shot(&mut self) -> Result<Note> {
        let storage = self.record_storage.shot_for(self.rival.id(), self.record.id(), SHOT_DEADLINE);
        let note = self.shot_note(self.rival.id(), self.faucet.id(), STAKE, &storage)?;
        let rival = self.rival.clone();
        self.publish(&rival, &note)?;
        Ok(note)
    }

    /// `creator` posts `note` from its vault in a transaction, which is then committed.
    pub fn publish(&mut self, creator: &Account, note: &Note) -> Result<()> {
        let script = SendNotesTransactionScript::new(
            &creator.code_interface(),
            &[PartialNote::from(note.clone())],
        )?;
        let executed = self
            .chain
            .build_transaction(creator.id())
            .send_notes_script(&script)
            .expected_output_note(RawOutputNote::Full(note.clone()))
            .build()?
            .execute()
            .await_blocking()?;
        self.commit(&executed)
    }

    /// `account` consumes `notes` with `answers` (none on the reclaim/collect paths): the note
    /// argument is the answers' commitment, the answers themselves and the shot deadlines go
    /// in the advice map.
    pub async fn consume(
        &mut self,
        account: AccountId,
        notes: &[&Note],
        answers: Option<&[Answer; ROUNDS]>,
    ) -> Result<ExecutedTransaction, TransactionExecutorError> {
        let owned: Vec<Note> = notes.iter().map(|n| (*n).clone()).collect();
        let advice = deadline_advice(&owned).expect("advice");
        self.consume_with_advice(account, notes, answers, advice).await
    }

    pub async fn consume_with_advice(
        &mut self,
        account: AccountId,
        notes: &[&Note],
        answers: Option<&[Answer; ROUNDS]>,
        mut advice: Vec<(Word, Vec<miden_client::Felt>)>,
    ) -> Result<ExecutedTransaction, TransactionExecutorError> {
        let arg = match answers {
            Some(a) => {
                let entry = answer_advice(a);
                let key = entry.0;
                advice.push(entry);
                key
            }
            None => Word::default(),
        };
        self.consume_with_arg(account, notes, arg, advice).await
    }

    /// The raw form: one note argument for every note, whatever advice the caller brings.
    pub async fn consume_with_arg(
        &mut self,
        account: AccountId,
        notes: &[&Note],
        arg: Word,
        advice: Vec<(Word, Vec<miden_client::Felt>)>,
    ) -> Result<ExecutedTransaction, TransactionExecutorError> {
        let mut tx = self.chain.build_transaction(account);
        let mut args = BTreeMap::new();
        for n in notes {
            tx = tx.authenticated_input_note(n.id());
            args.insert(n.id(), arg);
        }
        for (k, v) in advice {
            tx = tx.add_advice_map_entry(k, v);
        }
        tx.extend_note_args(args).build().expect("tx builds").execute().await
    }

    pub fn commit(&mut self, executed: &ExecutedTransaction) -> Result<()> {
        self.chain.add_pending_executed_transaction(executed)?;
        self.chain.prove_next_block()?;
        Ok(())
    }

    pub fn balance(&self, account: AccountId) -> u64 {
        let asset = FungibleAsset::new(self.faucet.id(), 1).unwrap();
        let _ = self.account(account);
        self.chain
            .committed_account(account)
            .unwrap()
            .vault()
            .get_balance(asset.id())
            .unwrap()
            .as_u64()
    }

    pub fn jump_to(&mut self, block: u32) -> Result<()> {
        self.chain.prove_until_block(block)?;
        Ok(())
    }
}

/// Runs a future to completion from sync code (the harness is called from `#[tokio::test]`).
trait AwaitBlocking: core::future::Future + Sized {
    fn await_blocking(self) -> Self::Output {
        tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(self))
    }
}
impl<F: core::future::Future> AwaitBlocking for F {}
