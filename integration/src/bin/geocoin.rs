//! The GQ token on testnet: a public fungible faucet we control.
//!
//!   cargo run --release --bin gq_faucet deploy            # once; writes gq.json
//!   cargo run --release --bin gq_faucet mint <account> <amount-in-GQ>
//!
//! `<account>` is bech32 (mtst1...) or hex. State lives next to the repo root: `store.sqlite3`,
//! `keystore/` and `gq.json` (faucet id). Fees are paid in USDCx fetched from the testnet faucet.

use anyhow::{bail, Context, Result};
use integration::{
    faucet_api::{request_fee_tokens, TESTNET_FAUCET_API},
    funding::ensure_accounts_funded,
    helpers::{setup_client, wait_for_commit},
};
use miden_client::{
    account::{
        standards::{
            access::{Authority, Pausable, PausableManager},
        wallets::BasicWallet,
            faucets::{FungibleFaucet, TokenName},
            policies::{BurnPolicy, MintPolicy, TokenPolicyManager},
        },
        Account, AccountBuilder, AccountId, AccountType, Address,
    },
    asset::{AssetAmount, FungibleAsset, TokenSymbol},
    auth::{AuthSecretKey, AuthSingleSig},
    keystore::Keystore,
    note::NoteType,
    transaction::TransactionRequestBuilder,
};
use rand::Rng;

pub const GQ_DECIMALS: u8 = 6;
pub const GQ_MAX_SUPPLY: u64 = 1_000_000_000 * 1_000_000; // 1e9 GQ
const STATE_FILE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../gq.json");

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("deploy") => deploy().await,
        Some("mint") if args.len() == 3 => mint(&args[1], &args[2]).await,
        _ => bail!("usage: gq_faucet deploy | gq_faucet mint <account> <amount-in-GQ>"),
    }
}

async fn deploy() -> Result<()> {
    let setup = setup_client().await?;
    let mut client = setup.client;
    client.sync_state().await?;

    let faucet = FungibleFaucet::builder()
        .name(TokenName::new("GeoQuiz")?)
        .symbol(TokenSymbol::new("GQ")?)
        .decimals(GQ_DECIMALS)
        .max_supply(AssetAmount::new(GQ_MAX_SUPPLY)?)
        .build()
        .context("build FungibleFaucet")?;
    let policies = TokenPolicyManager::builder()
        .active_mint_policy(MintPolicy::allow_all())
        .active_burn_policy(BurnPolicy::allow_all())
        .build();

    let mut seed = [0u8; 32];
    client.rng().fill_bytes(&mut seed);
    let key = AuthSecretKey::new_falcon512_poseidon2_with_rng(client.rng());
    let account: Account = AccountBuilder::new(seed)
        .account_type(AccountType::Public)
        .with_component(AuthSingleSig::from_public_key(key.public_key()))
        .with_component(faucet)
        // the faucet pays its own fees in USDCx, received as plain P2ID notes
        .with_component(BasicWallet)
        .with_component(Authority::AuthControlled)
        .with_components(policies)
        .with_component(Pausable::unpaused())
        .with_component(PausableManager)
        .build()
        .context("build faucet account")?;
    client.add_account(&account, false).await?;
    setup.keystore.add_key(&key, account.id()).await?;

    let id = account.id();
    println!("GQ faucet: {} ({})", id.to_bech32(miden_client::account::NetworkId::Testnet), id.to_hex());
    std::fs::write(STATE_FILE, format!("{{\n  \"gq_faucet\": \"{}\"\n}}\n", id.to_hex()))?;
    println!("wrote {STATE_FILE}");

    fund_fees(&mut client, id).await?;
    println!("Faucet is funded for fees. Mint with: gq_faucet mint <account> <amount>");
    Ok(())
}

async fn mint(target: &str, amount_gq: &str) -> Result<()> {
    let state: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(STATE_FILE)?)?;
    let faucet_id = AccountId::from_hex(state["gq_faucet"].as_str().context("no gq_faucet in gq.json")?)?;
    let target_id = parse_account(target)?;
    let amount = parse_gq(amount_gq)?;

    let setup = setup_client().await?;
    let mut client = setup.client;
    client.sync_state().await?;
    fund_fees(&mut client, faucet_id).await?;

    let asset = FungibleAsset::new(faucet_id, amount)?;
    let request = TransactionRequestBuilder::new()
        .build_mint_fungible_asset(asset, target_id, NoteType::Public, client.rng())?;
    let tx_id = client.submit_new_transaction(faucet_id, request).await?;
    println!("mint tx {}", tx_id.to_hex());
    wait_for_commit(&mut client, tx_id).await?;
    println!("Minted {amount_gq} GQ to {}", target_id.to_hex());
    Ok(())
}

/// Tops up the fee asset from the testnet faucet when the account has none.
async fn fund_fees(client: &mut miden_client::Client<miden_client::keystore::FilesystemKeyStore>, id: AccountId) -> Result<()> {
    let header = client.get_latest_block_header().await?;
    let fee_asset = client.get_protocol_config(header.protocol_config_commitment()).await?.fee_asset_id();
    let balance = client.get_account(id).await?.context("account")?.vault().get_balance(fee_asset)?;
    if balance.as_u64() > 0 {
        return Ok(());
    }
    println!("Requesting fee tokens for {} ...", id.to_hex());
    let note = request_fee_tokens(TESTNET_FAUCET_API, id)?;
    println!("faucet note {note}");
    ensure_accounts_funded(client, &[id]).await
}

fn parse_account(s: &str) -> Result<AccountId> {
    if s.starts_with("0x") {
        return Ok(AccountId::from_hex(s)?);
    }
    let (_, address) = Address::decode(s).context("bech32 address")?;
    match address.id() {
        miden_protocol::address::AddressId::AccountId(id) => Ok(id),
        other => bail!("unsupported address kind: {other:?}"),
    }
}

fn parse_gq(s: &str) -> Result<u64> {
    let (int, frac) = s.split_once('.').unwrap_or((s, ""));
    if frac.len() > GQ_DECIMALS as usize {
        bail!("at most {GQ_DECIMALS} decimals");
    }
    let frac = format!("{frac:0<6}");
    Ok(int.parse::<u64>()? * 1_000_000 + frac.parse::<u64>()?)
}
