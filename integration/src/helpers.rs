//! Common helper functions for scripts and tests

use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{bail, ensure, Context, Result};
use miden_client::{
    account::{component::BasicWallet, Account, AccountBuilder, AccountType},
    auth::{AuthSecretKey, AuthSingleSig},
    builder::ClientBuilder,
    keystore::{FilesystemKeyStore, Keystore},
    store::TransactionFilter,
    transaction::{TransactionId, TransactionStatus},
    Client,
};
use miden_client_sqlite_store::ClientBuilderSqliteExt;
use rand::Rng;

pub(crate) const NETWORK_TIMEOUT: Duration = Duration::from_secs(600);
pub(crate) const POLL_INTERVAL: Duration = Duration::from_secs(5);

/// Test setup configuration containing initialized client and keystore
pub struct ClientSetup {
    /// The configured Miden client instance.
    pub client: Client<FilesystemKeyStore>,
    /// The filesystem-backed keystore used by the client.
    pub keystore: Arc<FilesystemKeyStore>,
}

/// Initializes test infrastructure with client and keystore
///
/// # Returns
/// A `ClientSetup` containing the initialized client and keystore
///
/// # Errors
/// Returns an error if RPC connection fails, keystore initialization fails,
/// or client building fails
pub async fn setup_client() -> Result<ClientSetup> {
    // Initialize keystore
    let keystore_path = std::path::PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../keystore"));

    let keystore =
        Arc::new(FilesystemKeyStore::new(keystore_path).context("Failed to initialize keystore")?);

    let store_path = std::path::PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../store.sqlite3"));

    let client = ClientBuilder::for_testnet()
        .sqlite_store(store_path)
        .authenticator(keystore.clone())
        .build()
        .await
        .context("Failed to build Miden client")?;

    Ok(ClientSetup { client, keystore })
}

/// Configuration for creating a wallet account.
pub struct AccountCreationConfig {
    /// The account type to create. The account type also encodes the
    /// storage visibility (`AccountType::Public` / `AccountType::Private`).
    pub account_type: AccountType,
}

impl Default for AccountCreationConfig {
    fn default() -> Self {
        Self { account_type: AccountType::Public }
    }
}

/// Creates a basic wallet account with authentication
///
/// # Arguments
/// * `client` - The Miden client instance
/// * `keystore` - The keystore for storing authentication keys
/// * `config` - Configuration for account creation
///
/// # Returns
/// The created `Account` with basic wallet functionality
///
/// # Errors
/// Returns an error if account creation, key generation, or keystore operations fail
pub async fn create_basic_wallet_account(
    client: &mut Client<FilesystemKeyStore>,
    keystore: Arc<FilesystemKeyStore>,
    config: AccountCreationConfig,
) -> Result<Account> {
    let mut init_seed = [0_u8; 32];
    client.rng().fill_bytes(&mut init_seed);

    let key_pair = AuthSecretKey::new_falcon512_poseidon2_with_rng(client.rng());

    let builder = AccountBuilder::new(init_seed)
        .account_type(config.account_type)
        .with_component(AuthSingleSig::from_public_key(key_pair.public_key()))
        .with_component(BasicWallet);

    let account = builder
        .build()
        .context("Failed to build basic wallet account")?;

    client
        .add_account(&account, false)
        .await
        .context("Failed to add account to client")?;

    keystore
        .add_key(&key_pair, account.id())
        .await
        .context("Failed to add key to keystore")?;

    Ok(account)
}

/// Wait until a submitted transaction is committed on chain.
///
/// # Errors
/// Returns an error if syncing fails, the transaction is discarded, or the wait times out.
pub async fn wait_for_commit(
    client: &mut Client<FilesystemKeyStore>,
    tx_id: TransactionId,
) -> Result<()> {
    let started = Instant::now();
    loop {
        client.sync_state().await?;
        let records = client
            .get_transactions(TransactionFilter::Ids(vec![tx_id]))
            .await?;
        if let Some(record) = records.first() {
            match &record.status {
                TransactionStatus::Committed { block_number, .. } => {
                    println!(
                        "Transaction {} committed in block {block_number}",
                        tx_id.to_hex()
                    );
                    return Ok(());
                }
                TransactionStatus::Discarded(cause) => {
                    bail!("Transaction {tx_id} discarded: {cause}")
                }
                TransactionStatus::Pending => {}
            }
        }
        ensure!(
            started.elapsed() < NETWORK_TIMEOUT,
            "Timed out waiting for transaction {tx_id}"
        );
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}
