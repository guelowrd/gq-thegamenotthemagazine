//! Dev probe: error-code table for the scripts' messages, and whether a note's nullifier is spent.
//!   cargo run --release --bin probe [note-id-hex]
use anyhow::Result;
use integration::helpers::setup_client;
use miden_client::rpc::{Endpoint, GrpcClient, NodeRpcClient};
use miden_protocol::errors::MasmError;

const MESSAGES: &[&str] = &[
    "challenge: note storage must hold the 16 header items plus game data in whole words",
    "challenge: the deadline has passed",
    "challenge: the deadline has not passed yet",
    "challenge: the note must hold exactly one asset",
    "challenge: the challenge stake is not in the prize's asset",
    "challenge: the challenge stake is below min_stake",
    "challenge: no challenge note bound to this prize and consumer in the transaction",
    "prize: the answer does not beat the target score",
    "challenge: only the player or the champion may consume this note",
];

#[tokio::main]
async fn main() -> Result<()> {
    for m in MESSAGES {
        println!("{:>22}  {m}", MasmError::from_static_str(m).code().as_canonical_u64());
    }
    if let Some(id) = std::env::args().nth(1) {
        let mut client = setup_client().await?.client;
        client.sync_state().await?;
        let tip = client.get_sync_height().await?;
        let rec = client.get_input_note(miden_client::note::NoteId::try_from_hex(&id)?).await?.expect("note in store");
        let note: miden_client::note::Note = rec.try_into()?;
        println!("script root {}", note.script().root().to_hex());
        for a in note.assets().iter() {
            println!("asset {a:?}");
        }
        let nullifier = note.nullifier();
        let from = tip.as_u32().saturating_sub(2_000);
        let rpc = GrpcClient::new(&Endpoint::testnet(), 10_000);
        let hits = rpc.sync_nullifiers(&[nullifier.prefix()], from.into(), tip).await?;
        match hits.iter().find(|u| u.nullifier == nullifier) {
            Some(u) => println!("note {id}: CONSUMED in block {}", u.block_num),
            None => println!("note {id}: not consumed (blocks {from}..{tip})"),
        }
    }
    Ok(())
}
