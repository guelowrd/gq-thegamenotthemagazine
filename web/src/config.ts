// GQ (GeoQuiz) on Miden testnet v0.17.

export const APP_NAME = "GQ GeoQuiz";

// The GQ token: a fungible faucet we deployed on testnet (`cargo run --bin gq_faucet deploy`).
export const GQ_FAUCET = import.meta.env.VITE_GQ_FAUCET ?? "0x02a14387adb68f516e57cc5aa65891";
export const GQ_DECIMALS = 6;

// Challenge terms of the GeoQuiz UI. The contracts only know `min_stake`.
export const STAKE: bigint = BigInt(import.meta.env.VITE_GQ_STAKE ?? "1000000"); // 1 GQ
export const DEFAULT_PRIZE: bigint = STAKE * 3n;
export const PRIZE_LIFETIME_BLOCKS = 2_000; // claim window, in blocks
export const MIN_CHALLENGE_WINDOW_BLOCKS = 100; // refuse to challenge a prize about to expire

// Where the assembled note scripts live (written by `cargo run --bin build_scripts`).
export const PRIZE_SCRIPT_URL = "/scripts/prize.bin";
export const CHALLENGE_SCRIPT_URL = "/scripts/challenge.bin";
export const CITIES_URL = "/cities.json";
export const WORLD_URL = "/world.json";

export const EXPLORER_BASE_URL = "https://testnet.midenscan.com";
export const NETWORK_POLL_INTERVAL_MS = 2_500;
export const NETWORK_POLL_TIMEOUT_MS = 120_000;

// Miden SDK configuration — override via environment variables
export const MIDEN_RPC_URL = import.meta.env.VITE_MIDEN_RPC_URL ?? "testnet";
export const MIDEN_FAUCET_URL =
  import.meta.env.VITE_MIDEN_FAUCET_URL ?? (MIDEN_RPC_URL === "testnet" ? "https://faucet-api.testnet.miden.io" : "");
export const MIDEN_PROVER = (import.meta.env.VITE_MIDEN_PROVER as "devnet" | "testnet" | "local") ?? "testnet";
