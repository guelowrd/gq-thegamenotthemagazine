//! Assembles the two note scripts: `record.masm` and `shot.masm` on the challenge core, linked with
//! a game. A game is one MASM module that exports `beats_target` (see `challenge_core.masm`); the
//! core imports it as `game::rules`.

use anyhow::{Context, Result};
use miden_client::note::{Note, NoteRecipient, NoteScript};
use miden_standards::code_builder::CodeBuilder;

pub const GQ_SCORE_MASM: &str = include_str!("../../masm/games/gq_score.masm");
const CHALLENGE_CORE_MASM: &str = include_str!("../../masm/challenge/challenge_core.masm");
const RECORD_MASM: &str = include_str!("../../masm/challenge/record.masm");
const SHOT_MASM: &str = include_str!("../../masm/challenge/shot.masm");
const SALE_MASM: &str = include_str!("../../masm/sale/sale.masm");

/// The record and shot scripts for the game in `game_masm`.
pub fn scripts_for(game_masm: &str) -> Result<(NoteScript, NoteScript)> {
    let builder = || -> Result<CodeBuilder> {
        CodeBuilder::default()
            .with_linked_module("game::rules", game_masm)
            .context("link the game as game::rules")?
            .with_linked_module("challenge::core", CHALLENGE_CORE_MASM)
            .context("link challenge::core")
    };
    let record = builder()?.compile_note_script(RECORD_MASM).context("compile record.masm")?;
    let shot = builder()?.compile_note_script(SHOT_MASM).context("compile shot.masm")?;
    Ok((record, shot))
}

/// The Gamecoin sale script: the standard PSWAP plus "anyone but the seller must name an amount".
pub fn sale_script() -> Result<NoteScript> {
    CodeBuilder::default().compile_note_script(SALE_MASM).context("compile sale.masm")
}

/// `pswap` (a standard PSWAP note, from miden-standards) with the sale script in place of PSWAP's.
pub fn as_sale(pswap: &Note) -> Result<Note> {
    let (assets, metadata, recipient, attachments) = pswap.clone().into_parts();
    let recipient = NoteRecipient::new(recipient.serial_num(), sale_script()?, recipient.storage().clone());
    Ok(Note::with_attachments(assets, metadata.into_partial_metadata(), recipient, attachments))
}
