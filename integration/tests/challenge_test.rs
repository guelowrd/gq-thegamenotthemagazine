//! The challenge mechanic on MockChain: prize note + challenge note, all four paths and the
//! ways they must fail. Accounts are standard wallets, the shape Bread creates.

mod common;

use anyhow::Result;
use common::*;
use integration::{felt, rules::vectors};
use miden_client::{asset::FungibleAsset, Word};

// --- claim ---------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn claim_wins_prize_and_returns_stake() -> Result<()> {
    let mut s = setup(1000)?;
    let challenge = s.standard_challenge()?;
    let before = s.balance(s.challenger.id());

    let tx = s
        .consume(s.challenger.id(), &[&s.prize.clone(), &challenge], answer_word(&perfect_answers()))
        .await
        .expect("claim with a winning answer succeeds");
    s.commit(&tx)?;

    assert_eq!(s.balance(s.challenger.id()), before + PRIZE + STAKE);
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn claim_with_losing_answer_fails() -> Result<()> {
    let mut s = setup(1000)?;
    let challenge = s.standard_challenge()?;
    let r = s
        .consume(s.challenger.id(), &[&s.prize.clone(), &challenge], answer_word(&losing_answers()))
        .await;
    assert!(r.is_err());
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn claim_must_exactly_beat_target() -> Result<()> {
    // target == score is not enough; target == score - 1 is
    let score = integration::rules::quiz_score(&CITIES, &perfect_answers());
    let mut s = setup(score)?;
    let challenge = s.standard_challenge()?;
    let r = s
        .consume(s.challenger.id(), &[&s.prize.clone(), &challenge], answer_word(&perfect_answers()))
        .await;
    assert!(r.is_err(), "equal score must not claim");

    let mut s = setup(score - 1)?;
    let challenge = s.standard_challenge()?;
    s.consume(s.challenger.id(), &[&s.prize.clone(), &challenge], answer_word(&perfect_answers()))
        .await
        .expect("score above target claims");
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn claim_without_challenge_note_fails() -> Result<()> {
    let mut s = setup(1000)?;
    let r = s
        .consume(s.challenger.id(), &[&s.prize.clone()], answer_word(&perfect_answers()))
        .await;
    assert!(r.is_err());
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn claim_with_tampered_challenge_fails() -> Result<()> {
    let mut s = setup(1000)?;
    // same player, same prize id, but the challenge copies different game data
    let mut storage = s.prize_storage.challenge_for(s.challenger.id(), s.prize.id(), CHALLENGE_DEADLINE);
    storage.game[8 + 1] = felt(0); // move the first city
    let challenge = s.challenge_note(s.challenger.id(), s.faucet.id(), STAKE, &storage)?;
    let creator = s.challenger.clone();
    s.publish(&creator, &challenge)?;
    let r = s
        .consume(s.challenger.id(), &[&s.prize.clone(), &challenge], answer_word(&perfect_answers()))
        .await;
    assert!(r.is_err());
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn claim_with_someone_elses_challenge_fails() -> Result<()> {
    let mut s = setup(1000)?;
    // the stranger posted a challenge; the challenger tries to use it
    let storage = s.prize_storage.challenge_for(s.stranger.id(), s.prize.id(), CHALLENGE_DEADLINE);
    let challenge = s.challenge_note(s.stranger.id(), s.faucet.id(), STAKE, &storage)?;
    let creator = s.stranger.clone();
    s.publish(&creator, &challenge)?;
    let r = s
        .consume(s.challenger.id(), &[&s.prize.clone(), &challenge], answer_word(&perfect_answers()))
        .await;
    assert!(r.is_err());
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn claim_with_small_stake_fails() -> Result<()> {
    let mut s = setup(1000)?;
    let storage = s.prize_storage.challenge_for(s.challenger.id(), s.prize.id(), CHALLENGE_DEADLINE);
    let challenge = s.challenge_note(s.challenger.id(), s.faucet.id(), STAKE - 1, &storage)?;
    let creator = s.challenger.clone();
    s.publish(&creator, &challenge)?;
    let r = s
        .consume(s.challenger.id(), &[&s.prize.clone(), &challenge], answer_word(&perfect_answers()))
        .await;
    assert!(r.is_err());
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn claim_after_expiry_fails() -> Result<()> {
    let mut s = setup(1000)?;
    let challenge = s.standard_challenge()?;
    s.jump_to(EXPIRY)?;
    let r = s
        .consume(s.challenger.id(), &[&s.prize.clone(), &challenge], answer_word(&perfect_answers()))
        .await;
    assert!(r.is_err());
    Ok(())
}

// --- reclaim -------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn champion_reclaims_after_expiry_only() -> Result<()> {
    let mut s = setup(1000)?;
    let r = s.consume(s.champion.id(), &[&s.prize.clone()], Word::default()).await;
    assert!(r.is_err(), "reclaim before expiry must fail");

    s.jump_to(EXPIRY)?;
    let before = s.balance(s.champion.id());
    let tx = s
        .consume(s.champion.id(), &[&s.prize.clone()], Word::default())
        .await
        .expect("reclaim after expiry");
    s.commit(&tx)?;
    assert_eq!(s.balance(s.champion.id()), before + PRIZE);
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn stranger_cannot_take_expired_prize() -> Result<()> {
    let mut s = setup(1000)?;
    s.jump_to(EXPIRY)?;
    let r = s.consume(s.stranger.id(), &[&s.prize.clone()], answer_word(&perfect_answers())).await;
    assert!(r.is_err());
    Ok(())
}

// --- settle --------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn settle_win_refunds_stake() -> Result<()> {
    let mut s = setup(1000)?;
    let challenge = s.standard_challenge()?;
    let before = s.balance(s.challenger.id());
    let tx = s
        .consume(s.challenger.id(), &[&challenge], answer_word(&perfect_answers()))
        .await
        .expect("settle with a win");
    assert_eq!(tx.output_notes().num_notes(), 0, "a win creates no note");
    s.commit(&tx)?;
    assert_eq!(s.balance(s.challenger.id()), before + STAKE);
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn settle_with_losing_answer_fails_and_the_stake_waits_for_the_champion() -> Result<()> {
    let mut s = setup(1000)?;
    let challenge = s.standard_challenge()?;
    let r = s.consume(s.challenger.id(), &[&challenge], answer_word(&losing_answers())).await;
    assert!(r.is_err(), "a losing answer cannot settle");
    s.jump_to(CHALLENGE_DEADLINE)?;
    let before = s.balance(s.champion.id());
    let tx = s.consume(s.champion.id(), &[&challenge], Word::default()).await.expect("champion collects");
    s.commit(&tx)?;
    assert_eq!(s.balance(s.champion.id()), before + STAKE);
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn settle_after_expiry_fails() -> Result<()> {
    let mut s = setup(1000)?;
    let challenge = s.standard_challenge()?;
    s.jump_to(EXPIRY)?;
    let r = s.consume(s.challenger.id(), &[&challenge], answer_word(&perfect_answers())).await;
    assert!(r.is_err());
    Ok(())
}

// --- challenge deadline (shorter than the prize expiry) -----------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn challenge_deadline_cuts_settle_short_and_opens_collect() -> Result<()> {
    let mut s = setup(1000)?;
    let challenge = s.standard_challenge()?;
    s.jump_to(CHALLENGE_DEADLINE)?;
    assert!(CHALLENGE_DEADLINE < EXPIRY);
    let r = s.consume(s.challenger.id(), &[&challenge], answer_word(&perfect_answers())).await;
    assert!(r.is_err(), "settle at the challenge deadline must fail even though the prize is open");
    let r = s
        .consume(s.challenger.id(), &[&s.prize.clone(), &challenge], answer_word(&perfect_answers()))
        .await;
    assert!(r.is_err(), "claiming with an expired challenge must fail");
    let before = s.balance(s.champion.id());
    let tx = s
        .consume(s.champion.id(), &[&challenge], Word::default())
        .await
        .expect("champion collects from the challenge deadline on");
    s.commit(&tx)?;
    assert_eq!(s.balance(s.champion.id()), before + STAKE);
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn challenge_deadline_cannot_outlive_the_prize() -> Result<()> {
    let mut s = setup(1000)?;
    let storage = s.prize_storage.challenge_for(s.challenger.id(), s.prize.id(), EXPIRY + 1_000);
    let challenge = s.challenge_note(s.challenger.id(), s.faucet.id(), STAKE, &storage)?;
    let creator = s.challenger.clone();
    s.publish(&creator, &challenge)?;
    s.jump_to(EXPIRY)?;
    let r = s.consume(s.challenger.id(), &[&challenge], answer_word(&perfect_answers())).await;
    assert!(r.is_err(), "the prize expiry bounds the challenge deadline");
    let tx = s.consume(s.champion.id(), &[&challenge], Word::default()).await.expect("collect at prize expiry");
    s.commit(&tx)?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn claim_with_a_lied_about_deadline_fails() -> Result<()> {
    let mut s = setup(1000)?;
    let challenge = s.standard_challenge()?;
    let advice = vec![(challenge.id().as_word(), vec![felt(CHALLENGE_DEADLINE as u64 + 1)])];
    let r = s
        .consume_with_advice(s.challenger.id(), &[&s.prize.clone(), &challenge], answer_word(&perfect_answers()), advice)
        .await;
    assert!(r.is_err(), "the advised deadline must match the note's storage");
    Ok(())
}

// --- collect -------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn champion_collects_after_expiry_only() -> Result<()> {
    let mut s = setup(1000)?;
    let challenge = s.standard_challenge()?;
    let r = s.consume(s.champion.id(), &[&challenge], Word::default()).await;
    assert!(r.is_err(), "collect before expiry must fail");

    s.jump_to(EXPIRY)?;
    let before = s.balance(s.champion.id());
    let tx = s
        .consume(s.champion.id(), &[&challenge], Word::default())
        .await
        .expect("collect after expiry");
    s.commit(&tx)?;
    assert_eq!(s.balance(s.champion.id()), before + STAKE);
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn stranger_cannot_touch_challenge() -> Result<()> {
    let mut s = setup(1000)?;
    let challenge = s.standard_challenge()?;
    let r = s.consume(s.stranger.id(), &[&challenge], answer_word(&perfect_answers())).await;
    assert!(r.is_err());
    s.jump_to(EXPIRY)?;
    let r = s.consume(s.stranger.id(), &[&challenge], Word::default()).await;
    assert!(r.is_err());
    Ok(())
}

// --- the core is agnostic to the game data length -------------------------------------------

/// Another game may need more data: the core accepts any whole number of words after the
/// 16-felt header, as long as prize and challenge carry the same tail.
#[tokio::test(flavor = "multi_thread")]
async fn longer_game_tail_is_accepted() -> Result<()> {
    let mut s = setup(1000)?;
    let extra = [felt(7), felt(8), felt(9), felt(10)];
    let mut prize_felts = s.prize_storage.to_felts();
    prize_felts.extend_from_slice(&extra);
    let prize = build_note_felts(s.champion.id(), integration::scripts::prize_script()?, prize_felts, FungibleAsset::new(s.faucet.id(), PRIZE)?, 11)?;
    let champion = s.champion.clone();
    s.publish(&champion, &prize)?;
    let mut ch_felts = s.prize_storage.challenge_for(s.challenger.id(), prize.id(), CHALLENGE_DEADLINE).to_felts();
    ch_felts.extend_from_slice(&extra);
    let challenge = build_note_felts(s.challenger.id(), s.challenge_script.clone(), ch_felts, FungibleAsset::new(s.faucet.id(), STAKE)?, 12)?;
    let challenger = s.challenger.clone();
    s.publish(&challenger, &challenge)?;
    let before = s.balance(s.challenger.id());
    let tx = s
        .consume(s.challenger.id(), &[&prize, &challenge], answer_word(&perfect_answers()))
        .await
        .expect("claim with a 44-felt layout");
    s.commit(&tx)?;
    assert_eq!(s.balance(s.challenger.id()), before + PRIZE + STAKE);
    Ok(())
}

// --- scoring vectors: MASM agrees with the Rust reference -----------------------------------

/// For every vector, a target of `score - 1` settles (win) and a target of `score` is refused.
/// Together these pin the on-chain score to the exact value the reference computes.
#[tokio::test(flavor = "multi_thread")]
async fn masm_score_matches_reference_on_vectors() -> Result<()> {
    for v in vectors() {
        let word = Word::new(v.packed.map(felt));
        for (target, wins) in [(v.score.saturating_sub(1), v.score > 0), (v.score, false)] {
            let mut s = setup_with_cities(target, v.cities)?;
            let challenge = s.standard_challenge()?;
            let r = s.consume(s.challenger.id(), &[&challenge], word).await;
            assert_eq!(r.is_ok(), wins, "vector {} target {target}: {:?}", v.name, r.err());
        }
    }
    Ok(())
}


// --- failures are the intended ones --------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn failures_carry_their_messages() -> Result<()> {
    let mut s = setup(1000)?;
    let e = s
        .consume(s.challenger.id(), &[&s.prize.clone()], answer_word(&perfect_answers()))
        .await
        .unwrap_err();
    assert_masm_error(&e, "challenge: no challenge note bound to this prize and consumer in the transaction");

    let e = s.consume(s.champion.id(), &[&s.prize.clone()], Word::default()).await.unwrap_err();
    assert_masm_error(&e, "challenge: the deadline has not passed yet");
    Ok(())
}

/// The executor reports `assert.err=MSG` failures by code; check the code is the one of `msg`.
fn assert_masm_error(e: &miden_client::transaction::TransactionExecutorError, msg: &'static str) {
    let code = miden_protocol::errors::MasmError::from_static_str(msg).code();
    let text = format!("{e:#}");
    assert!(text.contains(&code.as_canonical_u64().to_string()), "expected {msg:?}, got: {text}");
}
