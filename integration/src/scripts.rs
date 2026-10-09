//! Assembles the two note scripts: `record.masm` and `shot.masm` on the challenge core, linked with
//! a game. A game is one MASM module that exports `beats_target` (see `challenge_core.masm`); the
//! core imports it as `game::rules`.

use anyhow::{Context, Result};
use miden_client::note::NoteScript;
use miden_standards::code_builder::CodeBuilder;

pub const GQ_SCORE_MASM: &str = include_str!("../../masm/games/gq_score.masm");
pub const CHALLENGE_CORE_MASM: &str = include_str!("../../masm/challenge/challenge_core.masm");
pub const RECORD_MASM: &str = include_str!("../../masm/challenge/record.masm");
pub const SHOT_MASM: &str = include_str!("../../masm/challenge/shot.masm");

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

/// GeoQuizz's record script.
pub fn record_script() -> Result<NoteScript> {
    Ok(scripts_for(GQ_SCORE_MASM)?.0)
}

/// GeoQuizz's shot script.
pub fn shot_script() -> Result<NoteScript> {
    Ok(scripts_for(GQ_SCORE_MASM)?.1)
}
