//! Receive testnet fee assets from public faucet notes.

use anyhow::{ensure, Context, Result};
use miden_client::{
    account::AccountId, asset::AssetId, keystore::FilesystemKeyStore, note::Note,
    transaction::TransactionRequestBuilder, Client,
};
use miden_standards::note::P2idNote;
use std::time::Instant;

use crate::helpers::{wait_for_commit, NETWORK_TIMEOUT, POLL_INTERVAL};

/// Wait for public faucet notes and consume them to fund the accounts.
///
/// Request tokens for the printed IDs at https://faucet.testnet.miden.io/.
///
/// # Errors
/// Returns an error if registration is required, funding times out, or a
/// client operation or funding transaction fails.
pub async fn ensure_accounts_funded(
    client: &mut Client<FilesystemKeyStore>,
    account_ids: &[AccountId],
) -> Result<()> {
    for &account_id in account_ids {
        ensure!(
            client.is_account_allowed(account_id).await?,
            "Account {} requires testnet registration before submitting transactions",
            account_id.to_hex()
        );
    }
    let header = client.get_latest_block_header().await?;
    let fee_asset = client
        .get_protocol_config(header.protocol_config_commitment())
        .await?
        .fee_asset_id();

    println!("Request public funding notes for both accounts at https://faucet.testnet.miden.io/");
    println!("Waiting up to 10 minutes per account for funding.");
    for &account_id in account_ids {
        ensure_funded(client, account_id, fee_asset).await?;
    }
    Ok(())
}

async fn ensure_funded(
    client: &mut Client<FilesystemKeyStore>,
    account_id: AccountId,
    fee_asset: AssetId,
) -> Result<()> {
    let started = Instant::now();
    loop {
        client.sync_state().await?;
        let account = client
            .get_account(account_id)
            .await?
            .context("Missing account")?;
        let balance = account.vault().get_balance(fee_asset)?;
        if balance.as_u64() > 0 {
            println!(
                "Funded {}: {} native fee units",
                account_id.to_hex(),
                balance.as_u64()
            );
            return Ok(());
        }

        // The faucet sends from a distribution account. Match the asset issuer
        // and the standard P2ID script, not the note sender.
        for (record, _) in client.get_consumable_notes(Some(account_id)).await? {
            let note: Note = record.try_into()?;
            if note.script().root() != P2idNote::script_root()
                || !note
                    .assets()
                    .iter_fungible()
                    .any(|asset| asset.id() == fee_asset && asset.amount().as_u64() > 0)
            {
                continue;
            }
            let request = TransactionRequestBuilder::new().build_consume_notes(vec![note])?;
            let tx_id = client.submit_new_transaction(account_id, request).await?;
            println!("Funding transaction ID: {}", tx_id.to_hex());
            wait_for_commit(client, tx_id).await?;
            break;
        }
        ensure!(
            started.elapsed() < NETWORK_TIMEOUT,
            "Timed out waiting for a public funding note for {}",
            account_id.to_hex()
        );
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}
