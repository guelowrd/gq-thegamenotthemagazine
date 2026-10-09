pub mod auth_args;
pub mod faucet_api;
pub mod funding;
pub mod helpers;
pub mod quiz;
pub mod rules;
pub mod scripts;
pub mod storage;

/// One tag for every GQ note on chain; clients sync it and filter by script root.
pub const GQ_TAG: u32 = 0x4751_0001;

/// Infallible `Felt` from a value known to be below the field modulus.
pub fn felt(v: u64) -> miden_client::Felt {
    miden_client::Felt::new(v).expect("value below the field modulus")
}

/// The advice-map entries a transaction consuming `notes` needs: under each shot note's id,
/// that note's `shot_deadline` (storage item 7), which the record script verifies by
/// commitment.
pub fn deadline_advice(notes: &[miden_client::note::Note]) -> anyhow::Result<Vec<(miden_client::Word, Vec<miden_client::Felt>)>> {
    let root = scripts::shot_script()?.root();
    Ok(notes
        .iter()
        .filter(|n| n.script().root() == root)
        .map(|n| (n.id().as_word(), vec![n.recipient().storage().items()[storage::SHOT_DEADLINE_INDEX]]))
        .collect())
}

/// The advice-map entry carrying the answers: under their commitment (the note argument), the
/// ten packed rounds. The score script reads them from there and re-hashes them.
pub fn answer_advice(answers: &[rules::Answer; rules::ROUNDS]) -> (miden_client::Word, Vec<miden_client::Felt>) {
    (rules::answer_commitment(answers), rules::pack_answers(answers).iter().map(|&v| felt(v)).collect())
}
