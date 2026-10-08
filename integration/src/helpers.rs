//! Common helper functions for scripts and tests

use std::{
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{anyhow, bail, ensure, Context, Result};
use miden_client::{
    account::{
        component::{BasicWallet, InitStorageData, NoAuth},
        Account, AccountBuilder, AccountComponent, AccountType, StorageSlotName,
    },
    auth::{AuthSecretKey, AuthSingleSig},
    builder::ClientBuilder,
    keystore::{FilesystemKeyStore, Keystore},
    store::TransactionFilter,
    transaction::{TransactionId, TransactionStatus},
    utils::Deserializable,
    Client, Felt, Word,
};
use miden_client_sqlite_store::ClientBuilderSqliteExt;
use miden_mast_package::Package;
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
    let keystore_path = std::path::PathBuf::from("../keystore");

    let keystore =
        Arc::new(FilesystemKeyStore::new(keystore_path).context("Failed to initialize keystore")?);

    let store_path = std::path::PathBuf::from("../store.sqlite3");

    let client = ClientBuilder::for_testnet()
        .sqlite_store(store_path)
        .authenticator(keystore.clone())
        .build()
        .await
        .context("Failed to build Miden client")?;

    Ok(ClientSetup { client, keystore })
}

/// Builds a Miden project in the specified directory
///
/// # Arguments
/// * `dir` - Path to the directory containing the Cargo.toml
/// * `release` - Whether to build in release mode
///
/// # Returns
/// The compiled `Package`
///
/// # Errors
/// Returns an error if compilation fails or if the output is not in the expected format
pub fn build_project_in_dir(dir: &Path, release: bool) -> Result<Package> {
    let profile = if release { "--release" } else { "--debug" };
    let profile_name = if release { "release" } else { "debug" };
    let manifest_path = dir.join("Cargo.toml");
    let artifact_path = dir
        .join("target")
        .join("miden")
        .join(profile_name)
        .join("out.masp");

    let args = vec![
        profile.to_string(),
        "-o".to_string(),
        artifact_path.display().to_string(),
        "--manifest-path".to_string(),
        manifest_path.display().to_string(),
    ];

    let status = miden_build(args).context("Failed to compile project")?;

    if !status.success() {
        bail!("Failed to compile project package. See output for details.");
    }

    let package_bytes = std::fs::read(&artifact_path).context(format!(
        "Failed to read compiled package from {}",
        artifact_path.display()
    ))?;

    Package::read_from_bytes(&package_bytes).context("Failed to deserialize package from bytes")
}

/// The fixed key used by the counter contract to store the counter value.
pub const COUNTER_STORAGE_KEY: Word = Word::new([Felt::ZERO, Felt::ZERO, Felt::ZERO, Felt::ONE]);

/// Returns the storage slot name used by the counter account component.
///
/// # Errors
/// Returns an error if the fixed storage slot name is invalid.
pub fn counter_storage_slot() -> Result<StorageSlotName> {
    StorageSlotName::new("counter_account::counter_contract::count_map")
        .context("invalid counter storage slot name")
}

/// Configuration for creating an account with a custom component
pub struct AccountCreationConfig {
    /// The account type to create. The account type also encodes the
    /// storage visibility (`AccountType::Public` / `AccountType::Private`).
    pub account_type: AccountType,
    /// Initial component storage data keyed by storage slot schema.
    pub init_storage_data: InitStorageData,
}

impl Default for AccountCreationConfig {
    fn default() -> Self {
        Self {
            account_type: AccountType::Public,
            init_storage_data: InitStorageData::default(),
        }
    }
}

/// Creates an account with a custom component from a compiled package
///
/// # Arguments
/// * `client` - The Miden client instance
/// * `package` - The compiled package containing the account component
/// * `config` - Configuration for account creation
///
/// # Returns
/// The created `Account`
///
/// # Errors
/// Returns an error if account creation or client operations fail
pub async fn create_account_from_package(
    client: &mut Client<FilesystemKeyStore>,
    package: Arc<Package>,
    config: AccountCreationConfig,
) -> Result<Account> {
    let account_component =
        AccountComponent::from_package(Arc::unwrap_or_clone(package), &config.init_storage_data)
            .context("Failed to create account component from package")?;

    let mut init_seed = [0_u8; 32];
    client.rng().fill_bytes(&mut init_seed);

    let account = AccountBuilder::new(init_seed)
        .account_type(config.account_type)
        .with_component(account_component)
        // Receive faucet notes to pay transaction fees.
        .with_component(BasicWallet)
        .with_component(NoAuth)
        .build()
        .context("Failed to build account")?;

    client
        .add_account(&account, false)
        .await
        .context("Failed to add account to client")?;

    Ok(account)
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

fn miden_build(args: impl IntoIterator<Item = String>) -> anyhow::Result<std::process::ExitStatus> {
    let mut cmd = match std::env::var_os("MIDENUP_HOME") {
        Some(_) => std::process::Command::new("miden"),
        None => match std::env::var_os("CARGO_MIDEN") {
            Some(cargo_miden) => {
                // The `cargo-miden` binary expects the `miden` subcommand token,
                // the same as when cargo invokes it as `cargo miden`.
                let mut cmd = std::process::Command::new(cargo_miden);
                cmd.arg("miden");
                cmd
            }
            None => {
                let mut cmd = std::process::Command::new("cargo");
                cmd.arg("miden");
                cmd
            }
        },
    };
    cmd.arg("build").args(args);

    let mut child = cmd
        .spawn()
        .map_err(|err| anyhow!("Failed to spawn build command: {err}"))?;

    child
        .wait()
        .map_err(|err| anyhow!("Build command failed: {err}"))
}
