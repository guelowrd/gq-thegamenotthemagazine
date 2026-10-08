//! Compares the client's sync height with the node's chain tip (both read at the same moment).
use anyhow::Result;
use integration::helpers::setup_client;
#[tokio::main]
async fn main() -> Result<()> {
    let mut client = setup_client().await?.client;
    for _ in 0..3 {
        let s = client.sync_state().await?;
        let tip = std::process::Command::new("grpcurl").args(["rpc.testnet.miden.io:443", "miden.node.v1.NodeService/Status"]).output()?;
        let tip = String::from_utf8_lossy(&tip.stdout);
        let tip = tip.lines().find(|l| l.contains("chainTip")).unwrap_or("?").trim().to_string();
        println!("sync height {} vs node {}", s.block_num, tip);
        tokio::time::sleep(std::time::Duration::from_secs(4)).await;
    }
    Ok(())
}
