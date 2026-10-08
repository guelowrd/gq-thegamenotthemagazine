//! Reference for the multisig auth args a Bread (guarded multisig) account needs in a dApp-built
//! request. `web/src/lib/bread.ts` rebuilds the same words in the browser; `rules/auth_vectors.json`
//! pins the two together.

use miden_client::{account::AccountId, Word};
use miden_standards::account::auth::FeeConversionInfo;
use miden_standards::account::auth::MultisigAuthArgs;
use miden_protocol::crypto::SequentialCommit;

pub fn auth_args(bound_block: u32, salt: Word, fee_faucet: AccountId) -> (Vec<miden_client::Felt>, Word) {
    let args = MultisigAuthArgs::new(bound_block.into(), salt)
        .with_conversion_info(FeeConversionInfo::one_to_one(fee_faucet));
    (args.to_elements(), args.to_commitment())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::felt;

    #[test]
    fn write_auth_vectors_json() {
        let faucet = AccountId::from_hex("0x02a14387adb68f516e57cc5aa65891").unwrap();
        let salt = Word::new([felt(11), felt(22), felt(33), felt(44)]);
        let (elements, commitment) = auth_args(56400, salt, faucet);
        let json = serde_json::json!([{
            "bound_block": 56400,
            "salt": ["11", "22", "33", "44"],
            "fee_faucet": faucet.to_hex(),
            "elements": elements.iter().map(|f| f.as_canonical_u64().to_string()).collect::<Vec<_>>(),
            "commitment": commitment.to_hex(),
        }]);
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../rules/auth_vectors.json");
        std::fs::write(path, serde_json::to_string_pretty(&json).unwrap() + "\n").unwrap();
        assert_eq!(elements.len(), 12);
        assert_eq!(elements[0].as_canonical_u64(), 56400);
    }
}
