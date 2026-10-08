pub mod auth_args;
pub mod faucet_api;
pub mod funding;
pub mod helpers;
pub mod quiz;
pub mod rules;
pub mod scripts;
pub mod storage;

/// One tag for every GQ note on chain; clients sync it and filter by script root.
pub const GQ_TAG: u32 = 0x4751_0001;

/// Infallible `Felt` from a value known to be below the field modulus.
pub fn felt(v: u64) -> miden_client::Felt {
    miden_client::Felt::new(v).expect("value below the field modulus")
}
