//! The challenge mechanic on MockChain: record note + shot note, all four paths and the
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
    let shot = s.standard_shot()?;
    let before = s.balance(s.rival.id());

    let tx = s
        .consume(s.rival.id(), &[&s.record.clone(), &shot], Some(&perfect_answers()))
        .await
        .expect("claim with a winning answer succeeds");
    s.commit(&tx)?;

    assert_eq!(s.balance(s.rival.id()), before + PRIZE + STAKE);
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn claim_works_whichever_note_runs_first() -> Result<()> {
    // Clients order input notes by id, so the shot script can run before the record script and
    // move its stake out of the note first; the record must check the stake the shot was
    // created with, not what is left in it.
    let mut s = setup(1000)?;
    let shot = s.standard_shot()?;
    let before = s.balance(s.rival.id());
    let tx = s
        .consume(s.rival.id(), &[&shot, &s.record.clone()], Some(&perfect_answers()))
        .await
        .expect("claim succeeds with the shot note first");
    s.commit(&tx)?;
    assert_eq!(s.balance(s.rival.id()), before + PRIZE + STAKE);
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn claim_with_losing_answer_fails() -> Result<()> {
    let mut s = setup(1000)?;
    let shot = s.standard_shot()?;
    let r = s
        .consume(s.rival.id(), &[&s.record.clone(), &shot], Some(&losing_answers()))
        .await;
    assert!(r.is_err());
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn claim_must_exactly_beat_target() -> Result<()> {
    // target == score is not enough; target == score - 1 is
    let score = integration::rules::quiz_score(&CITIES, &perfect_answers());
    let mut s = setup(score)?;
    let shot = s.standard_shot()?;
    let r = s
        .consume(s.rival.id(), &[&s.record.clone(), &shot], Some(&perfect_answers()))
        .await;
    assert!(r.is_err(), "equal score must not claim");

    let mut s = setup(score - 1)?;
    let shot = s.standard_shot()?;
    s.consume(s.rival.id(), &[&s.record.clone(), &shot], Some(&perfect_answers()))
        .await
        .expect("score above target claims");
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn claim_without_shot_note_fails() -> Result<()> {
    let mut s = setup(1000)?;
    let r = s
        .consume(s.rival.id(), &[&s.record.clone()], Some(&perfect_answers()))
        .await;
    assert!(r.is_err());
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn claim_with_tampered_challenge_fails() -> Result<()> {
    let mut s = setup(1000)?;
    // same rival, same record id, but the shot copies different game data
    let mut storage = s.record_storage.shot_for(s.rival.id(), s.record.id(), SHOT_DEADLINE);
    storage.game[8 + 1] = felt(0); // move the first city
    let shot = s.shot_note(s.rival.id(), s.faucet.id(), STAKE, &storage)?;
    let creator = s.rival.clone();
    s.publish(&creator, &shot)?;
    let r = s
        .consume(s.rival.id(), &[&s.record.clone(), &shot], Some(&perfect_answers()))
        .await;
    assert!(r.is_err());
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn claim_with_someone_elses_challenge_fails() -> Result<()> {
    let mut s = setup(1000)?;
    // the stranger posted a shot; the rival tries to use it
    let storage = s.record_storage.shot_for(s.stranger.id(), s.record.id(), SHOT_DEADLINE);
    let shot = s.shot_note(s.stranger.id(), s.faucet.id(), STAKE, &storage)?;
    let creator = s.stranger.clone();
    s.publish(&creator, &shot)?;
    let r = s
        .consume(s.rival.id(), &[&s.record.clone(), &shot], Some(&perfect_answers()))
        .await;
    assert!(r.is_err());
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn claim_with_small_stake_fails() -> Result<()> {
    let mut s = setup(1000)?;
    let storage = s.record_storage.shot_for(s.rival.id(), s.record.id(), SHOT_DEADLINE);
    let shot = s.shot_note(s.rival.id(), s.faucet.id(), STAKE - 1, &storage)?;
    let creator = s.rival.clone();
    s.publish(&creator, &shot)?;
    let r = s
        .consume(s.rival.id(), &[&s.record.clone(), &shot], Some(&perfect_answers()))
        .await;
    assert!(r.is_err());
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn claim_after_expiry_fails() -> Result<()> {
    let mut s = setup(1000)?;
    let shot = s.standard_shot()?;
    s.jump_to(EXPIRY)?;
    let r = s
        .consume(s.rival.id(), &[&s.record.clone(), &shot], Some(&perfect_answers()))
        .await;
    assert!(r.is_err());
    Ok(())
}

// --- reclaim -------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn champion_reclaims_after_expiry_only() -> Result<()> {
    let mut s = setup(1000)?;
    let r = s.consume(s.champion.id(), &[&s.record.clone()], None).await;
    assert!(r.is_err(), "reclaim before expiry must fail");

    s.jump_to(EXPIRY)?;
    let before = s.balance(s.champion.id());
    let tx = s
        .consume(s.champion.id(), &[&s.record.clone()], None)
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
    let r = s.consume(s.stranger.id(), &[&s.record.clone()], Some(&perfect_answers())).await;
    assert!(r.is_err());
    Ok(())
}

// --- settle --------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn settle_win_refunds_stake() -> Result<()> {
    let mut s = setup(1000)?;
    let shot = s.standard_shot()?;
    let before = s.balance(s.rival.id());
    let tx = s
        .consume(s.rival.id(), &[&shot], Some(&perfect_answers()))
        .await
        .expect("settle with a win");
    assert_eq!(tx.output_notes().num_notes(), 0, "a win creates no note");
    s.commit(&tx)?;
    assert_eq!(s.balance(s.rival.id()), before + STAKE);
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn settle_with_losing_answer_fails_and_the_stake_waits_for_the_champion() -> Result<()> {
    let mut s = setup(1000)?;
    let shot = s.standard_shot()?;
    let r = s.consume(s.rival.id(), &[&shot], Some(&losing_answers())).await;
    assert!(r.is_err(), "a losing answer cannot settle");
    s.jump_to(SHOT_DEADLINE)?;
    let before = s.balance(s.champion.id());
    let tx = s.consume(s.champion.id(), &[&shot], None).await.expect("champion collects");
    s.commit(&tx)?;
    assert_eq!(s.balance(s.champion.id()), before + STAKE);
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn settle_after_expiry_fails() -> Result<()> {
    let mut s = setup(1000)?;
    let shot = s.standard_shot()?;
    s.jump_to(EXPIRY)?;
    let r = s.consume(s.rival.id(), &[&shot], Some(&perfect_answers())).await;
    assert!(r.is_err());
    Ok(())
}

// --- shot deadline (shorter than the record expiry) -----------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn shot_deadline_cuts_settle_short_and_opens_collect() -> Result<()> {
    let mut s = setup(1000)?;
    let shot = s.standard_shot()?;
    s.jump_to(SHOT_DEADLINE)?;
    const { assert!(SHOT_DEADLINE < EXPIRY) };
    let r = s.consume(s.rival.id(), &[&shot], Some(&perfect_answers())).await;
    assert!(r.is_err(), "settle at the shot deadline must fail even though the record is open");
    let r = s
        .consume(s.rival.id(), &[&s.record.clone(), &shot], Some(&perfect_answers()))
        .await;
    assert!(r.is_err(), "claiming with an expired shot must fail");
    let before = s.balance(s.champion.id());
    let tx = s
        .consume(s.champion.id(), &[&shot], None)
        .await
        .expect("champion collects from the shot deadline on");
    s.commit(&tx)?;
    assert_eq!(s.balance(s.champion.id()), before + STAKE);
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn shot_deadline_cannot_outlive_the_prize() -> Result<()> {
    let mut s = setup(1000)?;
    let storage = s.record_storage.shot_for(s.rival.id(), s.record.id(), EXPIRY + 1_000);
    let shot = s.shot_note(s.rival.id(), s.faucet.id(), STAKE, &storage)?;
    let creator = s.rival.clone();
    s.publish(&creator, &shot)?;
    s.jump_to(EXPIRY)?;
    let r = s.consume(s.rival.id(), &[&shot], Some(&perfect_answers())).await;
    assert!(r.is_err(), "the record expiry bounds the shot deadline");
    let tx = s.consume(s.champion.id(), &[&shot], None).await.expect("collect at record expiry");
    s.commit(&tx)?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn claim_with_a_lied_about_deadline_fails() -> Result<()> {
    let mut s = setup(1000)?;
    let shot = s.standard_shot()?;
    let advice = vec![(shot.id().as_word(), vec![felt(SHOT_DEADLINE as u64 + 1)])];
    let r = s
        .consume_with_advice(s.rival.id(), &[&s.record.clone(), &shot], Some(&perfect_answers()), advice)
        .await;
    assert!(r.is_err(), "the advised deadline must match the note's storage");
    Ok(())
}

// --- the answers are bound to the note argument --------------------------------------------

/// The note argument commits to the answers; the answers in the advice map must be the ones.
#[tokio::test(flavor = "multi_thread")]
async fn settle_with_answers_that_do_not_match_the_commitment_fails() -> Result<()> {
    let mut s = setup(1000)?;
    let shot = s.standard_shot()?;
    // commit to a losing answer, supply a perfect one in the advice map
    let (key, _) = integration::rules::answer_advice(&losing_answers());
    let (_, perfect) = integration::rules::answer_advice(&perfect_answers());
    let owned = vec![shot.clone()];
    let mut advice = integration::deadline_advice(Word::from(s.shot_script.root()), &owned);
    advice.push((key, perfect));
    let e = s.consume_with_arg(s.rival.id(), &[&shot], key, advice).await.unwrap_err();
    assert_masm_error(&e, "gq: the advice map does not hold the answers the note argument commits to");
    Ok(())
}

// --- collect -------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn champion_collects_after_expiry_only() -> Result<()> {
    let mut s = setup(1000)?;
    let shot = s.standard_shot()?;
    let r = s.consume(s.champion.id(), &[&shot], None).await;
    assert!(r.is_err(), "collect before expiry must fail");

    s.jump_to(EXPIRY)?;
    let before = s.balance(s.champion.id());
    let tx = s
        .consume(s.champion.id(), &[&shot], None)
        .await
        .expect("collect after expiry");
    s.commit(&tx)?;
    assert_eq!(s.balance(s.champion.id()), before + STAKE);
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn stranger_cannot_touch_challenge() -> Result<()> {
    let mut s = setup(1000)?;
    let shot = s.standard_shot()?;
    let r = s.consume(s.stranger.id(), &[&shot], Some(&perfect_answers())).await;
    assert!(r.is_err());
    s.jump_to(EXPIRY)?;
    let r = s.consume(s.stranger.id(), &[&shot], None).await;
    assert!(r.is_err());
    Ok(())
}

// --- the core is agnostic to the game data length -------------------------------------------

/// Another game may need more data: the core accepts any whole number of words after the
/// 16-felt header, as long as record and shot carry the same tail.
#[tokio::test(flavor = "multi_thread")]
async fn longer_game_tail_is_accepted() -> Result<()> {
    let mut s = setup(1000)?;
    let extra = [felt(7), felt(8), felt(9), felt(10)];
    let mut prize_felts = s.record_storage.to_felts();
    prize_felts.extend_from_slice(&extra);
    let record = build_note_felts(s.champion.id(), integration::scripts::record_script()?, prize_felts, FungibleAsset::new(s.faucet.id(), PRIZE)?, 11)?;
    let champion = s.champion.clone();
    s.publish(&champion, &record)?;
    let mut ch_felts = s.record_storage.shot_for(s.rival.id(), record.id(), SHOT_DEADLINE).to_felts();
    ch_felts.extend_from_slice(&extra);
    let shot = build_note_felts(s.rival.id(), s.shot_script.clone(), ch_felts, FungibleAsset::new(s.faucet.id(), STAKE)?, 12)?;
    let rival = s.rival.clone();
    s.publish(&rival, &shot)?;
    let before = s.balance(s.rival.id());
    let tx = s
        .consume(s.rival.id(), &[&record, &shot], Some(&perfect_answers()))
        .await
        .expect("claim with a 68-felt layout");
    s.commit(&tx)?;
    assert_eq!(s.balance(s.rival.id()), before + PRIZE + STAKE);
    Ok(())
}

// --- another game on the same core --------------------------------------------------------------

/// A whole game, for the record: the note argument is the rival's number (in all four felts), and
/// it beats the target when it is higher. No game data. The core does the rest.
const HIGHER_NUMBER_WINS: &str = "
pub proc beats_target
    # => [N, N, N, N, data_ptr, target]
    drop drop drop swap drop
    # => [n, target]
    swap gt
end
";

#[tokio::test(flavor = "multi_thread")]
async fn another_game_plugs_into_the_same_core() -> Result<()> {
    let mut s = setup_for(1000, HIGHER_NUMBER_WINS, vec![])?;
    let shot = s.standard_shot()?;
    let number = |n: u64| Word::new([felt(n); 4]);
    let advice = integration::deadline_advice(Word::from(s.shot_script.root()), std::slice::from_ref(&shot));
    let r = s.consume_with_arg(s.rival.id(), &[&s.record.clone(), &shot], number(1000), advice.clone()).await;
    assert!(r.is_err(), "a tie does not beat the record");
    let before = s.balance(s.rival.id());
    let tx = s
        .consume_with_arg(s.rival.id(), &[&s.record.clone(), &shot], number(1001), advice)
        .await
        .expect("a higher number claims the prize and the stake");
    s.commit(&tx)?;
    assert_eq!(s.balance(s.rival.id()), before + PRIZE + STAKE);
    Ok(())
}

// --- scoring vectors: MASM agrees with the Rust reference -----------------------------------

/// For every vector, a target of `score - 1` settles (win) and a target of `score` is refused.
/// Together these pin the on-chain score to the exact value the reference computes.
#[tokio::test(flavor = "multi_thread")]
async fn masm_score_matches_reference_on_vectors() -> Result<()> {
    for v in vectors() {
        for (target, wins) in [(v.score.saturating_sub(1), v.score > 0), (v.score, false)] {
            let mut s = setup_with_cities(target, v.cities)?;
            let shot = s.standard_shot()?;
            let r = s.consume(s.rival.id(), &[&shot], Some(&v.answers)).await;
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
        .consume(s.rival.id(), &[&s.record.clone()], Some(&perfect_answers()))
        .await
        .unwrap_err();
    assert_masm_error(&e, "challenge: no shot note bound to this record and consumer in the transaction");

    let e = s.consume(s.champion.id(), &[&s.record.clone()], None).await.unwrap_err();
    assert_masm_error(&e, "challenge: the deadline has not passed yet");
    Ok(())
}

/// The executor reports `assert.err=MSG` failures by code; check the code is the one of `msg`.
fn assert_masm_error(e: &miden_client::transaction::TransactionExecutorError, msg: &'static str) {
    let code = miden_protocol::errors::MasmError::from_static_str(msg).code();
    let text = format!("{e:#}");
    assert!(text.contains(&code.as_canonical_u64().to_string()), "expected {msg:?}, got: {text}");
}
