// GQ (GeoQuizz) on Miden v0.17 mainnet; VITE_MIDEN_NETWORK=testnet for development.

export const MAINNET = import.meta.env.VITE_MIDEN_NETWORK !== "testnet";

export const APP_NAME = "GQ GeoQuizz";

// Gamecoin (GC): the game's fungible faucet (`cargo run --bin gamecoin deploy`, one per network).
export const GC_FAUCET = MAINNET ? "0x34a3510213533f512ec4abe36baf84" : "0xe1f2c48d5bfa8d5173dfcfdc8ac977";
export const GC_DECIMALS = 6;
// The shop: Gamecoin sold through sale notes (PSWAP) for the chain's fee asset (USDCx on mainnet, 6
// decimals): 0.001 per Gamecoin, at most 100 per buy. The price is a ceiling: a cheaper sale note sells first.
export const GC_PRICE = 1_000n; // base units of the fee asset per whole Gamecoin
export const MAX_BUY_GC = 100;
// The account that puts Gamecoin on sale from the game's admin panel (?admin=1); any account's sale note sells.
export const ADMIN = MAINNET ? "mm1azntuhzd3lwqxs2mmeny202ljy3fxnpm_qr7qqq9wr6w" : "0xc8050a7222eae00145f99cbec61298";

// The stake of the GeoQuizz UI: the champion puts it in the record note, each rival puts the
// same amount in their shot note. The contracts only know `min_stake`.
export const STAKE = 1_000_000n; // 1 GC
// Testnet makes a block about every 3 s, mainnet every 3.25 s.
export const BLOCK_SECONDS = MAINNET ? 3.25 : 3;
// A record stays open 64 hours: time for people to see the post and come play.
export const RECORD_LIFETIME_BLOCKS = Math.round((64 * 3600) / BLOCK_SECONDS); // 76 800 on testnet
// A shot must be settled within ~1 play of the game (10 cities x 15 s, plus proving), so a
// rival cannot sit on a stake and rehearse the same ten cities.
export const SHOT_WINDOW_BLOCKS = Math.round((3 * 60) / BLOCK_SECONDS); // 60 on testnet
// Refuse a shot at a record that will expire before the shot window ends.
export const MIN_SHOT_WINDOW_BLOCKS = SHOT_WINDOW_BLOCKS + 20;

// The two development wallets (?local=1 and ?local=2): their test rounds stay off the leaderboards
// and out of the nickname order.
export const TEST_ACCOUNTS = ["0x071d3da3ad56d88175b628f76073cb", "0x35b6665ae257d50144a45872cf5b50"];

// Where the assembled note scripts live (written by `cargo run --bin build_scripts`).
export const RECORD_SCRIPT_URL = "/scripts/record.bin";
export const SHOT_SCRIPT_URL = "/scripts/shot.bin";
// masm/challenge/challenge_core.masm CLAIM_FUZZ: how late a claim proved before a deadline may land.
export const CLAIM_FUZZ = 64;

export const NETWORK_POLL_INTERVAL_MS = 2_500;
export const NETWORK_POLL_TIMEOUT_MS = 120_000;

// Miden SDK configuration (mainnet = the Cedar hosts)
export const MIDEN_RPC_URL = MAINNET ? "https://rpc.cedar.miden.io" : "testnet";
export const MIDEN_PROVER = MAINNET ? "https://tx-prover.cedar.miden.io" : "testnet";
// The testnet fee-asset faucet (the local test wallet's money; mainnet accounts are funded by their invite code).
export const MIDEN_FAUCET_URL = "https://faucet-api.testnet.miden.io";
