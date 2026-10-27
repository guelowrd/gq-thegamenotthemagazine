//! The Gamecoin sale note on MockChain: the standard PSWAP with one more rule, a buyer must name an
//! amount. A take with no amount is what a wallet's claim button sends, and what Bread's check runs
//! to decide which notes to list; on the standard PSWAP it buys everything left (wallet#1952).

use anyhow::Result;
use integration::scripts::{as_sale, sale_script};
use miden_client::{
    account::{Account, AccountId},
    asset::FungibleAsset,
    auth::AuthSchemeId,
    note::{Note, NoteType, PartialNote},
    transaction::{ExecutedTransaction, InputNote, RawOutputNote, TransactionExecutorError},
    Word,
};
use miden_standards::{
    note::{PswapNote, PswapNoteStorage},
    tx_script::SendNotesTransactionScript,
};
use miden_testing::{Auth, MockChain};
use miden_client::note::NoteConsumptionStatus;
use miden_tx::{auth::UnreachableAuth, NoteConsumptionChecker, TransactionExecutor};

const UNIT: u64 = 1_000_000; // 6 decimals on both sides
const OFFERED: u64 = 1000 * UNIT; // GC on sale
const ASKED: u64 = 80 * UNIT; // USD for all of it: 0.08 each
const ONE_GC_PRICE: u64 = 80_000;
const NO_AMOUNT: &str = "sale: a buyer must name an amount";

struct Shop {
    chain: MockChain,
    gc: AccountId,
    usd: AccountId,
    seller: Account,
    rich: Account, // holds more than the leftover costs
}

fn auth() -> Auth {
    Auth::BasicAuth { auth_scheme: AuthSchemeId::Falcon512Poseidon2 }
}

fn shop() -> Result<Shop> {
    let mut b = MockChain::builder();
    let gc = b.add_existing_basic_faucet(auth(), "GC", 1_000_000 * UNIT, None)?.id();
    let usd = b.add_existing_basic_faucet(auth(), "USD", 1_000_000 * UNIT, None)?.id();
    let seller = b.add_existing_wallet_with_assets(auth(), [FungibleAsset::new(gc, 2 * OFFERED)?.into()])?;
    let rich = b.add_existing_wallet_with_assets(auth(), [FungibleAsset::new(usd, 100 * UNIT)?.into()])?;
    Ok(Shop { chain: b.build()?, gc, usd, seller, rich })
}

impl Shop {
    /// A standard PSWAP note: OFFERED GC for ASKED USD, sold by the seller.
    fn standard_sale(&self, serial: u64) -> Result<Note> {
        let storage = PswapNoteStorage::builder()
            .min_requested_asset(FungibleAsset::new(self.usd, ASKED)?)
            .creator_account_id(self.seller.id())
            .payback_note_type(NoteType::Public)
            .build();
        Ok(PswapNote::builder()
            .sender(self.seller.id())
            .storage(storage)
            .serial_number(Word::from([serial as u32, 7, 7, 7]))
            .note_type(NoteType::Public)
            .offered_asset(FungibleAsset::new(self.gc, OFFERED)?)
            .build()?
            .into())
    }

    /// The seller posts `note` from its vault.
    fn publish(&mut self, note: &Note) -> Result<()> {
        let script = SendNotesTransactionScript::new(&self.seller.code_interface(), &[PartialNote::from(note.clone())])?;
        let tx = self.chain.build_transaction(self.seller.id()).send_notes_script(&script)
            .expected_output_note(RawOutputNote::Full(note.clone())).build()?;
        let executed = tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(tx.execute()))?;
        self.commit(&executed)
    }

    /// `account` takes `note` with the note argument `arg` ([pay, 0, 0, 0] names an amount, zero names none).
    async fn take(&self, account: AccountId, note: &Note, arg: Word) -> Result<ExecutedTransaction, TransactionExecutorError> {
        let args = [(note.id(), arg)].into_iter().collect();
        self.chain.build_transaction(account).authenticated_input_note(note.id()).extend_note_args(args)
            .build().expect("tx builds").execute().await
    }

    fn commit(&mut self, executed: &ExecutedTransaction) -> Result<()> {
        self.chain.add_pending_executed_transaction(executed)?;
        self.chain.prove_next_block()?;
        Ok(())
    }

    /// Whether `account`'s own client would list `note` (the screener's relevance rule in miden-client).
    async fn listed(&self, account: AccountId, note: &Note) -> Result<bool> {
        let tx = self.chain.build_transaction(account).authenticated_input_note(note.id()).build()?;
        let executor = TransactionExecutor::<'_, '_, _, UnreachableAuth>::new(&tx).with_source_manager(tx.source_manager());
        let status = NoteConsumptionChecker::new(&executor)
            .can_consume(account, tx.tx_inputs().block_header().block_num(), InputNote::unauthenticated(note.clone()), tx.tx_args().clone())
            .await?;
        Ok(!matches!(status, NoteConsumptionStatus::NeverConsumable(_) | NoteConsumptionStatus::UnconsumableConditions))
    }

    fn balance(&self, account: AccountId, faucet: AccountId) -> u64 {
        let id = FungibleAsset::new(faucet, 1).unwrap().id();
        self.chain.committed_account(account).unwrap().vault().get_balance(id).unwrap().as_u64()
    }
}

/// The leftover a fill left behind: the one output note carrying GC.
fn leftover(executed: &ExecutedTransaction, gc: AccountId) -> Note {
    executed.output_notes().iter().find_map(|n| match n {
        RawOutputNote::Full(note) if note.assets().iter_fungible().any(|a| a.faucet_id() == gc) => Some(note.clone()),
        _ => None,
    }).expect("a leftover note")
}

/// The executor reports `assert.err=MSG` failures by code; check the code is the one of `msg` (as challenge_test).
fn assert_masm_error(e: &TransactionExecutorError, msg: &'static str) {
    let code = miden_protocol::errors::MasmError::from_static_str(msg).code();
    let text = format!("{e:#}");
    assert!(text.contains(&code.as_canonical_u64().to_string()), "expected {msg:?}, got: {text}");
}

fn named(pay: u64) -> Word {
    PswapNote::create_args(pay, 0).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_buyer_without_an_amount_is_refused() -> Result<()> {
    let mut s = shop()?;
    let sale = as_sale(&s.standard_sale(1)?)?;
    s.publish(&sale)?;
    let err = s.take(s.rich.id(), &sale, Word::default()).await.expect_err("a take with no amount must fail");
    assert_masm_error(&err, NO_AMOUNT);
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_named_amount_buys_that_many_pays_the_seller_and_the_rest_keeps_the_rule() -> Result<()> {
    let mut s = shop()?;
    let sale = as_sale(&s.standard_sale(1)?)?;
    s.publish(&sale)?;
    let bought = s.take(s.rich.id(), &sale, named(ONE_GC_PRICE)).await?;
    let rest = leftover(&bought, s.gc);
    s.commit(&bought)?;

    assert_eq!(s.balance(s.rich.id(), s.gc), UNIT);
    assert_eq!(s.balance(s.rich.id(), s.usd), 100 * UNIT - ONE_GC_PRICE);
    let paid: u64 = bought.output_notes().iter().filter_map(|n| match n {
        RawOutputNote::Full(note) => Some(note.assets().iter_fungible().filter(|a| a.faucet_id() == s.usd).map(|a| a.amount().as_u64()).sum::<u64>()),
        _ => None,
    }).sum();
    assert_eq!(paid, ONE_GC_PRICE, "the seller's payment");
    assert_eq!(rest.script().root(), sale_script()?.root(), "the leftover keeps the sale script");
    assert_eq!(rest.assets().iter_fungible().map(|a| a.amount().as_u64()).sum::<u64>(), OFFERED - UNIT);

    let err = s.take(s.rich.id(), &rest, Word::default()).await.expect_err("the leftover refuses a take with no amount");
    assert_masm_error(&err, NO_AMOUNT);
    s.take(s.rich.id(), &rest, named(ONE_GC_PRICE)).await?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn the_seller_takes_back_the_sale_and_any_leftover_without_an_amount() -> Result<()> {
    let mut s = shop()?;
    let sale = as_sale(&s.standard_sale(1)?)?;
    s.publish(&sale)?;
    s.take(s.seller.id(), &sale, Word::default()).await?; // the untouched sale

    let bought = s.take(s.rich.id(), &sale, named(ONE_GC_PRICE)).await?;
    let rest = leftover(&bought, s.gc);
    s.commit(&bought)?;
    let back = s.take(s.seller.id(), &rest, Word::default()).await?;
    s.commit(&back)?;
    assert_eq!(s.balance(s.seller.id(), s.gc), 2 * OFFERED - UNIT);
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn the_buyers_wallet_lists_the_standard_leftover_but_never_ours() -> Result<()> {
    let mut s = shop()?;
    let standard = s.standard_sale(1)?;
    let ours = as_sale(&s.standard_sale(2)?)?;
    s.publish(&standard)?;
    s.publish(&ours)?;
    let mut rests = vec![];
    for sale in [&standard, &ours] {
        let bought = s.take(s.rich.id(), sale, named(ONE_GC_PRICE)).await?;
        rests.push(leftover(&bought, s.gc));
        s.commit(&bought)?;
    }
    assert!(s.listed(s.rich.id(), &rests[0]).await?, "the standard leftover is listed: today's bug");
    assert!(!s.listed(s.rich.id(), &rests[1]).await?, "our leftover is never listed to a buyer");
    assert!(s.listed(s.seller.id(), &rests[1]).await?, "the seller still sees it (take-back)");
    Ok(())
}
