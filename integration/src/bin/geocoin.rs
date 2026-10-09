//! Geocoin (GC) on testnet: a public fungible faucet with no authentication, so anyone may mint.
//! The app's "EMPTY POCKETS? GET GEOCOINS NOW!" button executes the mint from the browser; this
//! tool deploys the faucet and mints from the command line.
//!
//!   cargo run --release --bin geocoin deploy                       # once; writes geocoin.json
//!   cargo run --release --bin geocoin mint <account> <amount-in-GC>
//!   cargo run --release --bin geocoin fees                         # top up the faucet's fee balance
//!
//! `<account>` is bech32 (mtst1...) or hex. State lives next to the repo root: `store.sqlite3`
//! and `geocoin.json` (faucet id). The faucet pays the fees of every mint in the chain's fee
//! asset, fetched from the testnet faucet; `fees` refills it.
//!
//! ponytail: no PoW, no captcha, no rate limit. Testnet toy money; gate it when it matters.

use anyhow::{bail, Context, Result};
use integration::{
    faucet_api::{request_fee_tokens, TESTNET_FAUCET_API},
    funding::ensure_accounts_funded,
    helpers::{setup_client, wait_for_commit},
};
use miden_client::{
    account::{
        component::NoAuth,
        standards::{
            access::{Authority, Pausable},
            faucets::{FungibleFaucet, TokenName},
            policies::{BurnPolicy, MintPolicy, TokenPolicyManager},
            wallets::BasicWallet,
        },
        Account, AccountBuilder, AccountId, AccountType, Address,
    },
    asset::{AssetAmount, FungibleAsset, TokenSymbol},
    note::NoteType,
    transaction::TransactionRequestBuilder,
};
use rand::Rng;

pub const GC_DECIMALS: u8 = 6;
pub const GC_MAX_SUPPLY: u64 = 1_000_000_000 * 1_000_000; // 1e9 GC
const STATE_FILE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../geocoin.json");

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("deploy") => deploy().await,
        Some("mint") if args.len() == 3 => mint(&args[1], &args[2]).await,
        Some("fees") => fees().await,
        _ => bail!("usage: geocoin deploy | geocoin mint <account> <amount-in-GC> | geocoin fees"),
    }
}

async fn deploy() -> Result<()> {
    let setup = setup_client().await?;
    let mut client = setup.client;
    client.sync_state().await?;

    let faucet = FungibleFaucet::builder()
        .name(TokenName::new("Geocoin")?)
        .symbol(TokenSymbol::new("GC")?)
        .decimals(GC_DECIMALS)
        .max_supply(AssetAmount::new(GC_MAX_SUPPLY)?)
        .build()
        .context("build FungibleFaucet")?;
    let policies = TokenPolicyManager::builder()
        .active_mint_policy(MintPolicy::allow_all())
        .active_burn_policy(BurnPolicy::allow_all())
        .build();

    let mut seed = [0u8; 32];
    client.rng().fill_bytes(&mut seed);
    let account: Account = AccountBuilder::new(seed)
        .account_type(AccountType::Public)
        // no key: every transaction on this account is authorised, which is the point
        .with_component(NoAuth)
        .with_component(faucet)
        // the faucet pays its own fees, received as plain P2ID notes
        .with_component(BasicWallet)
        .with_component(Authority::AuthControlled)
        .with_components(policies)
        // the faucet's mint checks the pause flag; without a manager nobody can flip it
        .with_component(Pausable::unpaused())
        .build()
        .context("build faucet account")?;
    client.add_account(&account, false).await?;

    let id = account.id();
    println!("Geocoin faucet: {} ({})", id.to_bech32(miden_client::account::NetworkId::Testnet), id.to_hex());
    std::fs::write(STATE_FILE, format!("{{\n  \"geocoin\": \"{}\"\n}}\n", id.to_hex()))?;
    println!("wrote {STATE_FILE}; set VITE_GC_FAUCET or web/src/config.ts GC_FAUCET to it");

    fund_fees(&mut client, id).await?;
    println!("Faucet is funded for fees. Mint with: geocoin mint <account> <amount>");
    Ok(())
}

fn faucet_id() -> Result<AccountId> {
    let state: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(STATE_FILE)?)?;
    Ok(AccountId::from_hex(state["geocoin"].as_str().context("no geocoin in geocoin.json")?)?)
}

async fn mint(target: &str, amount_gc: &str) -> Result<()> {
    let faucet_id = faucet_id()?;
    let target_id = parse_account(target)?;
    let amount = parse_gc(amount_gc)?;

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
    println!("Minted {amount_gc} GC to {}", target_id.to_hex());
    Ok(())
}

async fn fees() -> Result<()> {
    let faucet_id = faucet_id()?;
    let setup = setup_client().await?;
    let mut client = setup.client;
    client.sync_state().await?;
    println!("Requesting fee tokens for {} ...", faucet_id.to_hex());
    let note = request_fee_tokens(TESTNET_FAUCET_API, faucet_id)?;
    println!("faucet note {note}");
    ensure_accounts_funded(&mut client, &[faucet_id]).await
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

fn parse_gc(s: &str) -> Result<u64> {
    let (int, frac) = s.split_once('.').unwrap_or((s, ""));
    if frac.len() > GC_DECIMALS as usize {
        bail!("at most {GC_DECIMALS} decimals");
    }
    let frac = format!("{frac:0<6}");
    Ok(int.parse::<u64>()? * 1_000_000 + frac.parse::<u64>()?)
}
