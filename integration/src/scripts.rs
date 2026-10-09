//! Assembles the two note scripts from `masm/`.

use anyhow::{Context, Result};
use miden_client::note::NoteScript;
use miden_standards::code_builder::CodeBuilder;

pub const GQ_SCORE_MASM: &str = include_str!("../../masm/games/gq_score.masm");
pub const CHALLENGE_CORE_MASM: &str = include_str!("../../masm/challenge/challenge_core.masm");
pub const RECORD_MASM: &str = include_str!("../../masm/challenge/record.masm");
pub const SHOT_MASM: &str = include_str!("../../masm/challenge/shot.masm");

fn builder() -> Result<CodeBuilder> {
    CodeBuilder::default()
        .with_linked_module("gq::score", GQ_SCORE_MASM)
        .context("link gq::score")?
        .with_linked_module("challenge::core", CHALLENGE_CORE_MASM)
        .context("link challenge::core")
}

pub fn record_script() -> Result<NoteScript> {
    builder()?.compile_note_script(RECORD_MASM).context("compile record.masm")
}

pub fn shot_script() -> Result<NoteScript> {
    builder()?
        .compile_note_script(SHOT_MASM)
        .context("compile shot.masm")
}
