# GQ (GeoQuiz) on Miden: design

Status: approved direction, 2026-10-08. Targets **Miden testnet v0.17**
only. Note scripts are **MASM for now**; a Rust port is planned once the
compiler release after 0.11.0 ships (see "Why MASM").

Vocabulary: a **prize note** is posted by the champion. A **challenge note**
is posted by a challenger and bound to one prize note. The reusable part is
the *challenge mechanic*; GeoQuiz is one game plugged into it.

## 1. The game (GeoQuiz)

A quiz is 4 rounds. Each round shows a city name; the player clicks the map.
The client records the click as centi-degrees (`lat_cd = round((lat+90)*100)`,
`lon_cd = round((lon+180)*100)`) and the elapsed time in 10 ms units (15 s cap).

Score per round, rules version 1, all `u32` math (no sqrt, no floats):

```
dlat  = |lat_true - lat_click|
dlon  = min(|lon_true - lon_click|, 36000 - |lon_true - lon_click|) * cos_x100 / 100
d2    = dlat² + dlon²                       (centi-degrees², fits u32)
dist  = d2 <= 100²  ? 1000                   (≈ 1° ≈ 111 km)
      : d2 <= 300²  ? 700
      : d2 <= 800²  ? 400
      : d2 <= 2000² ? 150 : 0
speed = dist == 0 ? 0 : t <= 300 ? 300 : t <= 600 ? 200 : t <= 1000 ? 100 : 0
round = dist + speed                         (max 1300, quiz max 5200)
```

`cos_x100 = round(cos(lat_true) * 100)` is stored per city so the script never
computes trigonometry. One round packs into one field element:
`felt = lat_cd * 2^32 + (lon_cd * 2048 + t_10ms)`. Four rounds = one Word,
which is exactly the single note argument a Miden note script receives.

Quiz selection is off-chain and deterministic: `seed` (random Word chosen by the
champion) plus the dataset pick 4 distinct city indices via SHA-256. The prize
note stores the resulting `{city_idx, lat_cd, lon_cd, cos_x100}` per round, the
seed and the dataset hash. A challenger's client re-derives the indices from the
seed and refuses a challenge whose stored rounds don't match the bundled
dataset. On-chain, only the stored coordinates are used.

Dataset: Natural Earth populated places (public domain), ~240 cities, bundled
as `cities.json`; `dataset = SHA-256(canonical json)` folded into 4 felts.
Map: equirectangular SVG rendered from Natural Earth 110m country outlines
(public domain). Click to lat/lon is a linear mapping. No map library.

Stake: fixed at **1 GQ** in the GeoQuiz UI (0.001 GQ while testing). GQ is a
fungible token from a faucet we deploy on testnet (`gq_faucet` binary; Gaylord
mints). The contracts only know a generic `min_stake` and "same asset as the
prize", so another game can use another token.

## 2. The challenge mechanic (generic)

### Two note scripts, one shared core

| artifact | paths | who consumes |
|---|---|---|
| `prize.masm`     | **claim** (challenger, before expiry, winning answer, with their challenge note in the same tx) / **reclaim** (champion, after expiry) | prize assets go to the consumer |
| `challenge.masm` | **settle** (player, before expiry: win → refund; lose → forfeit to champion as public P2ID) / **collect** (champion, after expiry) | |

Both include `challenge_core.masm` (storage layout, deadline checks, the
"find my challenge note" check, asset moves) and call one game procedure,
`score(ANSWER, game_data_ptr) -> u32`, provided by `games/gq_score.masm`.
Another game replaces that one file. Anything not matching a path aborts.

Why two scripts and not one with a kind field: two artifacts named after the
two concepts explain themselves, each has two paths, and a game can ship a new
challenge script without touching the prize script. The price is that the
prize must know the challenge script's root; it is written into the prize
storage by the champion's client and cross-checked by every client, never
hardcoded.

### Storage (40 felts, identical layout for both notes)

```
 0      version          = 1
 1      expiry_block     prize lifetime; also the challenge deadline
 2      target           champion's score to beat (strictly greater wins)
 3      min_stake        minimum challenge amount, in the prize's asset
 4..5   champion         [suffix, prefix]  (P2ID convention)
 6..7   player           [suffix, prefix]  zero in a prize note
 8..11  PRIZE_ID         zero in a prize note
12..15  CHALLENGE_ROOT   challenge.masm script root
16..39  GAME DATA        opaque to the core; GeoQuiz: SEED(4) DATASET(4) 4×{city,lat,lon,cos}
```

A challenge note is a copy of its prize note's storage with `player` and
`PRIZE_ID` filled in. Both notes are **public**, tagged `GQ_TAG` (one u32 for
the app), and carry GQ.

### Binding a challenge to its prize (the claim check)

The kernel exposes other input notes' script root, storage commitment and
initial assets, not their storage contents. So the prize script:

1. copies its own storage to memory, sets `player = active_account::get_id()`
   and `PRIZE_ID = active_note::get_note_id()`;
2. hashes the 40 felts with `note::compute_storage_commitment`;
3. loops `0..tx::get_num_input_notes()` for an input note whose
   `input_note::get_script_root(i) == CHALLENGE_ROOT`, whose
   `input_note::get_storage_info(i).commitment` equals the hash, and whose
   initial assets hold ≥ `min_stake` of the prize's asset;
4. aborts if none.

A challenge note with altered quiz data, another player or another prize id
hashes differently and cannot claim.

### Deadlines

`tx::get_reference_block_number()` is chosen by the executor and can be
back-dated, so every before-expiry path calls
`tx::update_expiration_block_delta(CLAIM_FUZZ)`; a back-dated block then buys
at most `CLAIM_FUZZ` blocks. After-expiry paths cannot be forged forward.
The claim window is the prize lifetime (`PRIZE_LIFETIME_BLOCKS`, set when the
prize is created); the client refuses a challenge with fewer than
`MIN_CHALLENGE_WINDOW_BLOCKS` left.

### Flow

- Champion plays, posts a prize note with the prize amount, `target`,
  `min_stake`, expiry and the quiz.
- Challenger posts a challenge note (1 GQ) copying the prize storage, then
  plays the same quiz.
- Winner who is first: one transaction consumes the prize (claim) and their
  challenge note (settle, win): prize plus stake back.
- Later winners: settle their challenge note alone (refund) before expiry.
- Loser: the UI submits the real answers; the script forfeits the stake to the
  champion as a public P2ID. If they never submit, the champion collects after
  expiry. Prize closure never refunds challenges.
- Champion reclaims an unclaimed prize after expiry.

### Accounts and signer

Players use **Bread** (0xMiden/wallet v1.17.1, SDK 0.17.1). A Bread account is
a private Guardian multisig (ECDSA, threshold 1 + Guardian) with the standard
BasicWallet, so the standard `receive_asset` / `move_asset_to_note` /
`create_note` the scripts call are present. The dApp builds every
`TransactionRequest` itself and submits it through `requestTransaction`
(custom); Bread executes it verbatim. Notes Bread has not synced are shipped
as `importNotes` bytes (NoteFile with inclusion proof) and referenced with
explicit input notes plus per-note args. A local read-only client syncs
`GQ_TAG` and reads strangers' public notes.

### Lightweight safeguards

- Score recomputed onchain from answers; truth and target come from the note.
- Challenge bound to one prize and one player by storage commitment.
- `min_stake` in the prize asset checked onchain against the challenge's assets.
- Expiration delta bounds reference-block back-dating.
- Client-side: seed → cities check, dataset hash, rules version, and a
  champion's client only counts a challenge whose storage equals the prize's.

### Remaining trust assumptions (honest list)

1. Timing and clicks are whatever the browser submits; a modified client
   scores 5200. Anti-cheat is deferred by the brief.
2. A challenger can play first and post the challenge only when they know they
   won; nothing onchain orders challenge before play (no commitment stage).
3. The champion knows their own quiz. Irrelevant: they want challengers to lose.
4. A wrong `CHALLENGE_ROOT` in a prize makes it unclaimable until expiry; only
   the champion is hurt (clients cross-check before challenging).
5. Reference block can be back-dated by up to `CLAIM_FUZZ` blocks.
6. Public notes expose scores, ids and amounts.
7. A challenger can post a challenge and never play; the champion collects after expiry.

## 3. Why MASM (verified 2026-10-08)

Blocker B1: with the released toolchain (midenup 0.17.0 = midenc/cargo-miden
0.11.0, guest SDK `miden` 0.15.0) a Rust note script cannot move its assets into
a standard BasicWallet account, which is what Bread creates. Spike at
`upstream/spike/` (left in place, failing Rust test kept as the record):

- Linking the standards library works (`MIDEN_SYSROOT=$(midenup show home)/toolchains/0.17.0`
  puts `lib/miden-standards.masp` in the registry), but the 0.11.0 Wasm
  frontend only lowers `miden::` stubs listed in its hardcoded kernel/stdlib
  ABI tables and panics on `miden::standards::wallets::basic::move_note_assets_to_account`
  (`frontend/wasm/src/module/linker_stubs.rs:80-95`).
- A kernel-only Rust note (`native_account::add_asset`) compiles but the kernel
  rejects it: vault changes must go through a `call` to the account's own
  `receive_asset`.
- The same MockChain harness with a MASM note (`exec.basic::move_note_assets_to_account`)
  moves the assets into a vanilla BasicWallet.
- Compiler `main` already has the fix (linked-package stub resolution +
  generated `miden::raw::standards` bindings). It is unreleased. When it ships,
  port `prize.masm`/`challenge.masm` to Rust; the storage layout, paths and
  tests stay.

B2 is a cost, not a blocker: local-node validation is a four-binary topology.
Decision: validate on testnet only.

## 4. Versions (verified 2026-10-08)

| Component | agentic-template main | this project |
|---|---|---|
| Testnet node | | 0.17.1 (live) |
| midenup channel | 0.16.0 | 0.17.0 (installed) |
| miden-client / standards / testing | 0.16.0-rc | 0.17.2 / 0.17.1 / 0.17.1 |
| `@miden-sdk/miden-sdk` / react / adapters | 0.16.2 | 0.17.1 / 0.17.0 / 0.17.0 |
| Bread | | v1.17.1 |
| Rust nightly | nightly-2026-09-01 | same |

agentic-template `main` is still 0.16; the v0.17 migrations are
**project-template PR #67** and **frontend-template PR #31** (both
`pablo/migrate-v0.17`, expected to merge within hours). This project is based
on their heads (`upstream/project-template-v017`, `upstream/frontend-template-v017`).

Toolchain commands that work on this machine:

```
PATH="$(midenup show home)/toolchains/0.17.0/bin:$PATH"
CARGO_MIDEN="$(midenup show home)/toolchains/0.17.0/bin/cargo-miden"
MIDEN_SYSROOT="$(midenup show home)/toolchains/0.17.0"
```

Capability facts the design relies on (SDK/protocol 0.17.1, web SDK 0.17.1):
note arg is one Word; `input_note::{get_script_root, get_storage_info,
get_initial_assets, get_note_id, find_note}`, `tx::get_num_input_notes`,
`note::compute_storage_commitment`, `tx::get_reference_block_number`,
`tx::update_expiration_block_delta`; standards `basic::move_note_assets_to_account`,
`basic::move_asset_to_note`, `p2id::create_output_note(target, tag, note_type,
serial) -> note_idx`; P2ID storage `[suffix, prefix, 0, 0]`; web SDK
`NoteScript` from package or bytes, `NoteRecipient.fromScript`, `NoteMetadata
(sender, Public, NoteTag)`, `withOwnOutputNotes`, `NoteAndArgs`,
`withExplicitInputNote`, `extendAdviceMap`, `client.addTag`, `NoteFilter
(ScriptRoots)`, `RpcClient.getNotesById`; Bread `requestTransaction` custom
payload with `transactionRequest` + `importNotes`.

Known risk R1 (Bread): a 0.17 Guardian multisig needs auth args committed in
the request; Bread does not add them, and the SDK helper
(`feeAwareTransactionRequestBuilder`) wants the signer account in the dApp's
store, which a private account defeats. First thing Phase 4 does is a trivial
custom transaction through Bread on testnet.

## 5. Repository layout (one repo, no submodules)

```
gq/
  masm/challenge/        challenge_core.masm, prize.masm, challenge.masm   (reusable)
  masm/games/            gq_score.masm                                     (GeoQuiz)
  integration/           Rust: assemble scripts, rules reference + vectors, MockChain tests,
                         bins: build_scripts, gq_faucet (deploy/mint), testnet_flow
  web/                   React app from frontend-template PR #31 (SDK 0.17) + Bread adapter
  docs/design.md, docs/walkthrough.md
  tasks/todo.md, tasks/lessons.md
  upstream/              gitignored clones used for verification + the spike
```
