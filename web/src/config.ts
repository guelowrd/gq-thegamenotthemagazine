// GQ (GeoQuizz) on Miden testnet v0.17.

export const APP_NAME = "GQ GeoQuizz";

// Geocoin (GC): a fungible faucet on testnet anyone may mint from (`cargo run --bin geocoin deploy`).
export const GC_FAUCET = import.meta.env.VITE_GC_FAUCET ?? "0x2a85bbc7c655b6d116381742015892";
export const GC_DECIMALS = 6;

// The stake of the GeoQuizz UI: the champion puts it in the record note, each rival puts the
// same amount in their shot note. The contracts only know `min_stake`.
export const STAKE: bigint = BigInt(import.meta.env.VITE_GC_STAKE ?? "1000000"); // 1 GC
// Testnet makes a block about every 3 s.
export const BLOCK_SECONDS = 3;
// A record stays open about a day: time for people to see the post and come play.
export const RECORD_LIFETIME_BLOCKS = Math.round((24 * 3600) / BLOCK_SECONDS); // 28 800
// A shot must be settled within ~2 plays of the game (10 cities x 15 s, plus proving), so a
// rival cannot sit on a stake and rehearse the same ten cities.
export const SHOT_WINDOW_BLOCKS = Math.round((6 * 60) / BLOCK_SECONDS); // 120
// Refuse a shot at a record that will expire before the shot window ends.
export const MIN_SHOT_WINDOW_BLOCKS = SHOT_WINDOW_BLOCKS + 20;

// Where the assembled note scripts live (written by `cargo run --bin build_scripts`).
export const RECORD_SCRIPT_URL = "/scripts/record.bin";
export const SHOT_SCRIPT_URL = "/scripts/shot.bin";
export const CITIES_URL = "/cities.json";

export const NETWORK_POLL_INTERVAL_MS = 2_500;
export const NETWORK_POLL_TIMEOUT_MS = 120_000;

// Miden SDK configuration — override via environment variables
export const MIDEN_RPC_URL = import.meta.env.VITE_MIDEN_RPC_URL ?? "testnet";
export const MIDEN_FAUCET_URL =
  import.meta.env.VITE_MIDEN_FAUCET_URL ?? (MIDEN_RPC_URL === "testnet" ? "https://faucet-api.testnet.miden.io" : "");
export const MIDEN_PROVER = (import.meta.env.VITE_MIDEN_PROVER as "devnet" | "testnet" | "local") ?? "testnet";
