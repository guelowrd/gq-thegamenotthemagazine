//! Assembles the two note scripts from `masm/`.

use anyhow::{Context, Result};
use miden_client::note::NoteScript;
use miden_standards::code_builder::CodeBuilder;

pub const GQ_SCORE_MASM: &str = include_str!("../../masm/games/gq_score.masm");
pub const CHALLENGE_CORE_MASM: &str = include_str!("../../masm/challenge/challenge_core.masm");
pub const PRIZE_MASM: &str = include_str!("../../masm/challenge/prize.masm");
pub const CHALLENGE_MASM: &str = include_str!("../../masm/challenge/challenge.masm");

fn builder() -> Result<CodeBuilder> {
    CodeBuilder::default()
        .with_linked_module("gq::score", GQ_SCORE_MASM)
        .context("link gq::score")?
        .with_linked_module("challenge::core", CHALLENGE_CORE_MASM)
        .context("link challenge::core")
}

pub fn prize_script() -> Result<NoteScript> {
    builder()?.compile_note_script(PRIZE_MASM).context("compile prize.masm")
}

pub fn challenge_script() -> Result<NoteScript> {
    builder()?
        .compile_note_script(CHALLENGE_MASM)
        .context("compile challenge.masm")
}
