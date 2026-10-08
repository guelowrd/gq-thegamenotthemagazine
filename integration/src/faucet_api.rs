//! The testnet fee-asset faucet (`faucet-api.testnet.miden.io`): proof of work over HTTP, then a
//! public P2ID note of the chain's fee asset (USDCx) for the account. Mirrors `web/src/lib/funding.ts`.

use anyhow::{bail, Context, Result};
use miden_client::account::AccountId;
use sha2::{Digest, Sha256};

pub const TESTNET_FAUCET_API: &str = "https://faucet-api.testnet.miden.io";

/// Requests the faucet's base amount for `account`; returns the note id the faucet reports.
pub fn request_fee_tokens(base_url: &str, account: AccountId) -> Result<String> {
    let base = base_url.trim_end_matches('/');
    let account_id = account.to_bech32(miden_client::account::NetworkId::Testnet);
    let get = |path: &str| -> Result<serde_json::Value> {
        ureq::get(&format!("{base}/{path}"))
            .call()
            .with_context(|| format!("faucet {path}"))?
            .body_mut()
            .read_json::<serde_json::Value>()
            .with_context(|| format!("faucet {path}: bad json"))
    };

    let metadata = get("get_metadata")?;
    let amount = metadata["base_amount"]
        .as_u64()
        .or_else(|| metadata["base_amount"].as_str().and_then(|s| s.parse().ok()))
        .context("faucet metadata has no base_amount")?;

    let pow = get(&format!("pow?account_id={account_id}&amount={amount}"))?;
    let challenge_hex = pow["challenge"].as_str().context("no challenge")?.trim_start_matches("0x");
    let challenge = hex_decode(challenge_hex)?;
    let target: u128 = pow["target"]
        .as_u64()
        .map(u128::from)
        .or_else(|| pow["target"].as_str().and_then(|s| s.parse().ok()))
        .context("no target")?;

    let mut input = challenge.clone();
    input.extend_from_slice(&[0u8; 8]);
    let mut nonce: u64 = rand::random();
    let n = challenge.len();
    loop {
        input[n..].copy_from_slice(&nonce.to_be_bytes());
        let digest = Sha256::digest(&input);
        let head = u64::from_be_bytes(digest[..8].try_into().unwrap());
        if u128::from(head) < target {
            break;
        }
        nonce = nonce.wrapping_add(1);
    }

    let result = get(&format!(
        "get_tokens?account_id={account_id}&is_private_note=false&asset_amount={amount}&challenge={challenge_hex}&nonce={nonce}"
    ))?;
    match result["note_id"].as_str() {
        Some(id) => Ok(id.to_string()),
        None => bail!("faucet get_tokens returned {result}"),
    }
}

fn hex_decode(s: &str) -> Result<Vec<u8>> {
    if s.len() % 2 != 0 {
        bail!("odd hex length");
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).context("bad hex"))
        .collect()
}
