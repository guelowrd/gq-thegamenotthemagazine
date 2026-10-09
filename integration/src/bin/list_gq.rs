//! Lists every GQ record/shot note the chain carries under NOTE_TAG (sender, kind, amount, state).
//!   cargo run --release --bin list_gq

use anyhow::Result;
use integration::{
    helpers::setup_client,
    scripts::{shot_script, record_script},
    NOTE_TAG,
};
use miden_client::{note::NoteTag, store::NoteFilter, Word};

#[tokio::main]
async fn main() -> Result<()> {
    let mut client = setup_client().await?.client;
    client.add_note_tag(NoteTag::new(NOTE_TAG)).await?;
    client.sync_state().await?;
    let record_root = record_script()?.root();
    let shot_root = shot_script()?.root();
    let records = client.get_input_notes(NoteFilter::All).await?;
    let mut n = 0;
    for r in records {
        let root = r.details().script().root();
        let kind = if root == record_root { "record" } else if root == shot_root { "shot" } else { "old-script" };
        if r.metadata().map(|m| m.tag().as_u32()) != Some(NOTE_TAG) { continue; }
        let items = r.details().storage().items();
        let amount: u64 = r.details().assets().iter_fungible().map(|a| a.amount().as_u64()).sum();
        let sender = r.metadata().map(|m| m.sender().to_hex()).unwrap_or_default();
        println!(
            "{kind:<10} {} root {} sender {sender} amount {} target {} expiry {} deadline {} consumed {}",
            r.id().map(|i| i.to_hex()).unwrap_or_default(),
            &Word::from(root).to_hex()[..10],
            amount as f64 / 1e6,
            items.get(2).map(|f| f.as_canonical_u64()).unwrap_or(0),
            items.get(4).map(|f| f.as_canonical_u64()).unwrap_or(0),
            items.get(7).map(|f| f.as_canonical_u64()).unwrap_or(0),
            r.is_consumed()
        );
        n += 1;
    }
    println!("{n} GQ notes, chain height {}", client.get_sync_height().await?.as_u32());
    Ok(())
}
