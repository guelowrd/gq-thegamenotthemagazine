// Public NoAuth + BasicWallet counter on testnet, compatible with v0.17.
// Set a deployed account ID (hex or bech32); unset or empty leaves it unconfigured.
export const COUNTER_ADDRESS: string | null =
  import.meta.env.VITE_MIDEN_COUNTER_ADDRESS || null;

// StorageMap slot name for the counter account component.
export const COUNTER_SLOT_NAME =
  "counter_account::counter_contract::count_map";

// Block explorer base URL
export const EXPLORER_BASE_URL = "https://testnet.midenscan.com";

// Poll interval (ms) while waiting for a submitted transaction (the increment
// note publish, then the counter's consume) to commit and the count to update.
export const NETWORK_POLL_INTERVAL_MS = 2_500;

// Hard cap (ms) on how long to wait for each step of the increment (publish
// commit, then the post-consume count change) before giving up. Covers several
// network block cycles with margin.
export const NETWORK_POLL_TIMEOUT_MS = 60_000;

// Compiled v0.17 increment-note package, fetched at runtime for the counter.
export const INCREMENT_NOTE_PACKAGE_URL = "/packages/increment-note.masp";

// Application display name (used by wallet adapter)
export const APP_NAME = "Miden Template";

// Miden SDK configuration — override via environment variables
export const MIDEN_RPC_URL =
  import.meta.env.VITE_MIDEN_RPC_URL ?? "testnet";
// Custom RPCs must explicitly choose a faucet for the same chain.
export const MIDEN_FAUCET_URL = import.meta.env.VITE_MIDEN_FAUCET_URL ??
  (MIDEN_RPC_URL === "testnet" ? "https://faucet-api.testnet.miden.io" : "");
export const MIDEN_PROVER =
  (import.meta.env.VITE_MIDEN_PROVER as "devnet" | "testnet" | "local") ?? "testnet";
