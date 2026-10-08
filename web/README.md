# Miden Frontend Template

Minimal Vite + React + TypeScript template for building Miden frontends. It ships a Miden testnet counter demo that reads a shared on-chain counter and **increments it end-to-end from the browser** — the in-browser WebClient publishes an increment note and consumes it against the public `NoAuth` counter, no wallet required. Built on core SDK v0.17.1 and React SDK v0.17.0; configure a compatible counter deployment (see [Counter Demo](#counter-demo)).

## Getting Started

```bash
yarn install
yarn dev
```

Open [http://localhost:5173](http://localhost:5173). Set `VITE_MIDEN_COUNTER_ADDRESS` in `.env.local` to a compatible v0.17 counter and restart Vite. The app defaults to Miden testnet, renders the counter value, and lets you increment it on-chain by clicking the counter button — no wallet required (the button drives the full publish + consume flow via the in-browser client). Optionally install the [MidenFi wallet extension](https://chromewebstore.google.com/detail/midenfi) and connect to explore the wallet adapter, though the counter demo does not use it. See [Counter Demo](#counter-demo).

## Project Structure

```
src/
├── App.tsx                         # Root component
├── providers.tsx                   # MidenProvider + wallet adapter setup
├── config.ts                       # Constants (counter address, explorer URL, SDK config)
├── components/
│   ├── AppContent.tsx              # Page layout, logos, wallet button
│   ├── Counter.tsx                 # Counter UI (configured / unconfigured)
│   └── ConfiguredCounter.tsx       # Counter UI when address is set
├── hooks/
│   └── useIncrementCounter.ts      # Note construction, SDK submission, bounded poll
└── lib/
    ├── funding.ts                  # Fee funding: faucet HTTP/PoW, consume and confirmation
    └── miden.ts                    # Shared Miden utilities

public/packages/
├── counter-account.masp            # Compiled v0.17 counter contract
└── increment-note.masp             # Compiled v0.17 increment note script
```

## Counter Demo

The template demonstrates incrementing a shared on-chain counter on Miden testnet, entirely from the browser via the local WebClient (no wallet required):

1. A **counter account** — a **public, `NoAuth` + `BasicWallet`** account built from `counter-account.masp` — must be deployed on the selected v0.17 network. Earlier deployments are incompatible; configure your own v0.17 counter address.
2. On button click the in-browser WebClient restores or creates a local sender, **publishes** a plain increment note (built from `increment-note.masp`, tag `0`, no attachment) as the sender's own output note, then **consumes** it as the counter (NoAuth ⇒ no signature). Both transactions use the configured remote prover and the local client — no wallet involved.
3. Before publishing, `fundAccounts` syncs the client, reads `client.feeFaucetId()` from the protocol configuration, and checks whether new accounts need registration. It ensures sender and counter have a fee reserve (256 base-fee units), reusing available P2ID fee notes or requesting them from the public faucet. The faucet metadata identifies its distribution account, so the helper validates the delivered note's P2ID script and fee asset before consuming it and checking the confirmed balance. `BasicWallet` lets the counter receive these notes; NoAuth accounts still pay fees. This shared demo account must only hold test tokens.
4. The frontend waits for each transaction with `useWaitForCommit`, then re-reads the counter's `StorageMap`. A timeout does not cancel a submission; recovery of a whole increment across retries or reloads is outside this template's scope.

> **v0.17 verification:** on October 7, 2026, an isolated browser funded a new sender through the public testnet faucet, published and consumed the bundled increment note with remote proving, and confirmed the deployed counter changed from 1 to 2. Unit tests also cover funding retries, timeouts, account registration and invalid funding notes. The client retains `useWorker: false`; see Implementation Notes below.

The `.masp` packages in `public/packages/` use package format `7.0.0`. They were rebuilt with the v0.17 toolchain from [project-template PR #67](https://github.com/0xMiden/project-template/pull/67), commit [`6ae2ef0`](https://github.com/0xMiden/project-template/tree/6ae2ef043052cd8bb04578a3e10c1405569aa4b9), and deserialized with the installed SDK. See "Pointing at your own counter" below to rebuild/redeploy against your own counter.

### Pointing at your own counter

The counter address is resolved at runtime via the `VITE_MIDEN_COUNTER_ADDRESS` environment variable (`src/config.ts`):

| `VITE_MIDEN_COUNTER_ADDRESS` value | Effect |
|---|---|
| unset / commented out (default) | Unconfigured — set a compatible v0.17 deployment. |
| empty string (`VITE_MIDEN_COUNTER_ADDRESS=`) | Unconfigured — `<Counter>` renders the "address not configured" card and makes no network calls. |
| any account id — hex (`0x…`) or bech32 (`mtst1…`) | Uses your own deployment (resolved via `AccountId.fromHex` / `fromBech32`). |

The slot-name constant is fixed in `src/config.ts` and must match the counter contract's storage map name.

To redeploy (e.g. after modifying contract sources):

> **v0.17 toolchain:** use project-template's `miden-toolchain.toml` (midenup channel `0.17.0`, guest `miden` SDK `0.15.0`, compiler `0.11.0`). Rebuild both contracts and deploy the counter with current `NoAuth` and `BasicWallet` components; keep contract sources and build tooling in the contract project.

1. In the [project-template](https://github.com/0xMiden/project-template) repo (on the branch matching your SDK version), follow its build and deployment instructions to obtain a compatible public counter address.
2. Copy the freshly built artifacts into this template:
   ```bash
   cp contracts/counter-account/target/miden/release/out.masp \
      <frontend-template>/public/packages/counter-account.masp
   cp contracts/increment-note/target/miden/release/out.masp \
      <frontend-template>/public/packages/increment-note.masp
   ```
3. Set `VITE_MIDEN_COUNTER_ADDRESS=<your bech32 address>` in `.env` (or your shell environment) — no source edit required.
4. Verify the files exist with `.claude/hooks/check-artifacts.sh` (it checks the `.masp` files are present and non-trivial in size; note it does **not** validate the MASP/MAST format version, so it will not catch a v0.16 ↔ v0.17 version mismatch).

## Key Dependencies

| Package | Version pin | Purpose |
|---------|-------------|---------|
| `@miden-sdk/react` | `0.17.0` | React hooks for Miden (useAccount, useSyncState, useMiden, useMidenClient, useTransaction, …) |
| `@miden-sdk/miden-sdk` | `0.17.1` | Core SDK types (Note, NoteScript, AccountId, Word, Felt, …) |
| `@miden-sdk/vite-plugin` | `0.17.0` | Vite plugin that handles WASM loading, top-level await, and COOP/COEP |
| `@miden-sdk/miden-wallet-adapter-react` | `0.17.0` | MidenFi wallet adapter React context + hooks |
| `@miden-sdk/miden-wallet-adapter-base` | `0.17.0` | Wallet adapter types and network configuration |
| `@miden-sdk/create` | `0.17.0` | Syncs SDK guidance into `.claude/skills/` on install |

## Configuration

SDK settings can be overridden via environment variables (see `.env.example`):

```bash
VITE_MIDEN_RPC_URL=testnet   # "devnet" | "testnet" | "localhost" | custom URL
VITE_MIDEN_PROVER=testnet    # "devnet" | "testnet" | "local" | custom URL
VITE_MIDEN_FAUCET_URL=https://faucet-api.testnet.miden.io
```

Use stable v0.17 RPC, prover and note transport services together; a v0.16 or v0.17 release-candidate endpoint is incompatible. Custom RPCs require a faucet that distributes that network's fee asset. For private-note applications, also set the matching `noteTransportUrl` in `MidenProvider`'s config (`src/providers.tsx`).

On networks enforcing account registration, the helper reports the new account ID before requesting funding or proving. Obtain an invitation and register that account using `client.registerAccount(accountId, invitationCode)` under `runExclusive` after syncing, then retry. Existing on-chain accounts do not need registration.

### Upgrading an existing browser profile

Follow [docs PR #375](https://github.com/0xMiden/docs/pull/375) before opening the upgraded app against existing data:

- Consume v0.16 private notes before upgrading; v0.16 account/note exports cannot be imported into v0.17.
- Back up browser-keystore secret keys on the v0.16 SDK first. Opening the stable v0.17 SDK resets the old IndexedDB store **including its local secret keys**. This comes from the SDK even though the template contains no database-deletion code.
- A v0.17 release-candidate store is not reset automatically and is incompatible with stable v0.17. Back up its keys before recreating it.
- For this disposable demo, a fresh browser origin/profile avoids old stores and chain-reset state. Rebuild both packages and configure a compatible counter; old account IDs and compiled packages do not carry over.

## Verification

Automated gates that must all stay green:

```bash
npx tsc -b --noEmit       # type check
npx vitest --run          # unit tests (components, hook, funding, patterns)
npx vite build            # production build (emits dist/)
npx eslint .              # lint
```

The configured Claude PostToolUse hooks run typecheck, affected tests, and the full test/build suite after Edit/Write operations.

Browser-level verification (render correctness, no console errors, wallet popup, E2E increment) can be done with either:
- **Playwright MCP** for headless render / console checks
- **Claude in Chrome** (via the `/chrome` command) to exercise the real MidenFi extension

## Implementation Notes

### Client execution and signing

`MidenProvider` stays outside `MidenFiSignerProvider`, so its local keystore initializes immediately and the counter works without a connected wallet. Putting the signer outside it gates client initialization on wallet connection.

The template retains `useWorker: false`, introduced in v0.16 to keep imported-account state and transaction application in the same client instance. Remote proving keeps proof generation off the main thread. SDK mutation hooks own their locks; direct client calls and `useWaitForCommit` are serialized with `runExclusive`. The React SDK still requires the explicit numeric Falcon option (`authScheme: 2`) in `useCreateWallet`.

### Transaction confirmation and funding

After publishing, the frontend waits for commitment and polls for its exact note ID every `NETWORK_POLL_INTERVAL_MS` (2.5 s), bounded by `NETWORK_POLL_TIMEOUT_MS` (60 s). After consumption commits, it syncs and reads the confirmed count. Fee-enabled transactions also produce a fee note, so the increment note is matched by ID rather than output position.

All funding logic lives in `src/lib/funding.ts`, behind `fundAccounts`, ready to be replaced by an SDK funding method. It preserves known funding note IDs and checks the SDK's consumption record on retries. If the faucet HTTP response fails, it syncs again to find an issued P2ID fee note; later attempts also check existing funding before requesting more tokens. `useMint` executes a faucet account and does not replace the public faucet HTTP request.

## AI Developer Experience

SDK skills are installed from the pinned npm packages into `.claude/skills/` by `yarn install` (`miden-skills sync`). They are not committed. To refresh them, run `yarn miden-skills sync`. See [AGENTS.md](./AGENTS.md) for this template's configuration and increment flow; it takes precedence over generic examples in the packaged skills.

The committed `miden-concepts` skill is synced from [agent-tools PR #18](https://github.com/0xMiden/agent-tools/pull/18), commit [`4c0951c`](https://github.com/0xMiden/agent-tools/tree/4c0951c12a02fb1bcfa7a60f166949e2c10b622e), with its account-upgrade reference linked to the upstream skill.
