//! Lists every GQ prize/challenge note the chain carries under GQ_TAG (sender, kind, amount, state).
//!   cargo run --release --bin list_gq

use anyhow::Result;
use integration::{
    helpers::setup_client,
    scripts::{challenge_script, prize_script},
    GQ_TAG,
};
use miden_client::{note::NoteTag, store::NoteFilter};

#[tokio::main]
async fn main() -> Result<()> {
    let mut client = setup_client().await?.client;
    client.add_note_tag(NoteTag::new(GQ_TAG)).await?;
    client.sync_state().await?;
    let prize_root = prize_script()?.root();
    let challenge_root = challenge_script()?.root();
    let records = client.get_input_notes(NoteFilter::All).await?;
    let mut n = 0;
    for r in records {
        let root = r.details().script().root();
        let kind = if root == prize_root { "prize" } else if root == challenge_root { "challenge" } else { continue };
        let items = r.details().storage().items();
        let amount: u64 = r.details().assets().iter_fungible().map(|a| a.amount().as_u64()).sum();
        let sender = r.metadata().map(|m| m.sender().to_hex()).unwrap_or_default();
        println!(
            "{kind:<9} {} sender {sender} amount {} target {} expiry {} consumed {}",
            r.id().map(|i| i.to_hex()).unwrap_or_default(),
            amount as f64 / 1e6,
            items.get(2).map(|f| f.as_canonical_u64()).unwrap_or(0),
            items.get(4).map(|f| f.as_canonical_u64()).unwrap_or(0),
            r.is_consumed()
        );
        n += 1;
    }
    println!("{n} GQ notes");
    Ok(())
}
