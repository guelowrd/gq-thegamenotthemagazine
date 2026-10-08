// GQ (GeoQuiz) on Miden testnet v0.17.

export const APP_NAME = "GQ GeoQuiz";

// The GQ token: a fungible faucet we deployed on testnet (`cargo run --bin gq_faucet deploy`).
export const GQ_FAUCET = import.meta.env.VITE_GQ_FAUCET ?? "0x02a14387adb68f516e57cc5aa65891";
export const GQ_DECIMALS = 6;

// The stake of the GeoQuiz UI: the champion puts it in the prize note, each challenger puts the
// same amount in their challenge note. The contracts only know `min_stake`.
export const STAKE: bigint = BigInt(import.meta.env.VITE_GQ_STAKE ?? "1000000"); // 1 GQ
// Testnet makes a block about every 3 s.
export const BLOCK_SECONDS = 3;
// A prize stays open about a day: time for people to see the post and come play.
export const PRIZE_LIFETIME_BLOCKS = Math.round((24 * 3600) / BLOCK_SECONDS); // 28 800
// A challenge must be settled within ~2-3 plays of the game (4 rounds x 15 s, plus proving),
// so a challenger cannot sit on a stake and rehearse the same four cities.
export const CHALLENGE_WINDOW_BLOCKS = Math.round((6 * 60) / BLOCK_SECONDS); // 120
// Refuse to challenge a prize that will expire before the challenge window ends.
export const MIN_CHALLENGE_WINDOW_BLOCKS = CHALLENGE_WINDOW_BLOCKS + 20;

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
