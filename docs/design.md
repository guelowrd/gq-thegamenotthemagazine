# GQ (GeoQuizz) on Miden: design

Status: approved direction, 2026-10-08; rules v2 and vocabulary v2 decided
2026-10-09. Targets **Miden testnet v0.17** only. Note scripts are **MASM for
now**; a Rust port is planned once the compiler release after 0.11.0 ships
(see "Why MASM").

Vocabulary: the **champion** posts a **record** (a *record note*: the score to
beat and the prize). A **rival** takes a **shot** (a *shot note* holding one
**Geocoin**, GC), bound to one record. The reusable part is the *challenge
mechanic*; GeoQuizz is one game plugged into it.

## 1. The game (GeoQuizz)

A quiz is 10 rounds. Each round shows a city name; the player clicks the map.
The client records the click as centi-degrees (`lat_cd = round((lat+90)*100)`,
`lon_cd = round((lon+180)*100)`) and the elapsed time in 10 ms units (15 s cap).

Score per round, rules version 2, all `u32` math (no sqrt, no floats): the
design package's curve `exp(-km / 500)` made integer through a table.

```
dlat  = |lat_true - lat_click|
dlon  = min(|lon_true - lon_click|, 36000 - |lon_true - lon_click|) * cos_x100 / 100
d2    = dlat² + dlon²                         (centi-degrees², fits u32)
band  = first i in 0..128 with d2 <= ((i+1) * 25)²   (25 cd ≈ 27.8 km per band)
a     = EXP_MILLI[band]                       (round(1000 * exp(-i * 25 * 1.11195 / 500)); 0 past the table)
acc   = 850 * a / 1000
speed = 150 * a * (1500 - min(t, 1500)) / 1 500 000
round = acc + speed                           (max 1000, quiz max 10 000)
```

`cos_x100 = round(cos(lat_true) * 100)` is stored per city so the script never
computes trigonometry. The table (`EXP_MILLI`, 128 entries) is the same literal
in `rules.rs`, `rules.ts` and `gq_score.masm`; a Rust test pins it to the
formula and `rules/vectors.json` pins the three implementations to each other.
One round packs into one field element:
`felt = lat_cd * 2^32 + (lon_cd * 2048 + t_10ms)`. Ten of them do not fit the
single Word a note script receives as argument, so the argument is their
commitment (`note::compute_storage_commitment` over the ten felts, Poseidon2)
and the felts travel in the advice map under that key; the script re-hashes
them and refuses a mismatch.

Quiz selection is off-chain and deterministic: `seed` (random Word chosen by the
champion) plus the dataset pick 10 distinct city indices via SHA-256. The record
note stores the resulting `{city_idx, lat_cd, lon_cd, cos_x100}` per round, the
seed and the dataset hash. A rival's client re-derives the indices from the
seed and refuses a shot at a record whose stored rounds don't match the bundled
dataset. On-chain, only the stored coordinates are used.

Dataset: Natural Earth populated places (public domain), ~240 cities, bundled
as `cities.json`; `dataset = SHA-256(canonical json)` folded into 4 felts.
Map: equirectangular SVG rendered from Natural Earth 110m country outlines
(public domain). Click to lat/lon is a linear mapping. No map library.

Stake: one amount, **1 Geocoin (GC)**, for everyone. The champion puts it in
the record note (that is the prize); each rival puts the same amount in their
shot note to play. Geocoin is a fungible token from a faucet on testnet with
**no authentication** (`miden::standards::auth::no_auth`): anyone may mint, the
app's "Empty pockets? Get Geocoins now!" button does it from the browser
(`geocoin` binary deploys and mints from the CLI; PoW or a captcha can come
later). The contracts only know a generic `min_stake` and "same asset as the
record", so another game can use another token or amount.

## 2. The challenge mechanic (generic)

### Two note scripts, one shared core

| artifact | paths | who consumes |
|---|---|---|
| `record.masm` | **claim** (rival, before expiry, winning answer, with their shot note in the same tx) / **reclaim** (champion, after expiry) | prize assets go to the consumer |
| `shot.masm`   | **settle** (rival, before the shot deadline, winning answer only: Geocoin back) / **collect** (champion, from the deadline on) | |

Both include `challenge_core.masm` (storage layout, deadline checks, the
"find my shot note" check, asset receipt) and call one game procedure,
`beats_target(ANSWER, game_data_ptr, target) -> bool`, provided by
`games/gq_score.masm`. The core never sees a score; the game decides what beats
the target. Game data is any whole number of words after the 16-felt header;
the core reads the storage length at run time. Another game replaces that one
file. Anything not matching a path aborts.

Why two scripts and not one with a kind field: two artifacts named after the
two concepts explain themselves, each has two paths, and a game can ship a new
shot script without touching the record script. The price is that the
record must know the shot script's root; it is written into the record
storage by the champion's client and cross-checked by every client, never
hardcoded.

### Storage (64 felts, identical layout for both notes)

```
 0..1   champion        [suffix, prefix]  (P2ID convention)
 2      target          champion's score to beat (strictly greater wins)
 3      min_stake       minimum shot amount, in the record's asset
 4      expiry_block    record lifetime (~24 h = 28 800 blocks at 3 s)
 5..6   rival           [suffix, prefix]  zero in a record note
 7      shot_deadline   block by which the rival must settle; zero in a record note
 8..11  RECORD_ID       zero in a record note
12..15  SHOT_ROOT       shot.masm script root
16..    GAME DATA       whole words, any length; GeoQuizz: SEED(4) DATASET(4) 10×{city,lat,lon,cos} = 48
```

A shot note is a copy of its record note's storage with `rival`,
`shot_deadline` and `RECORD_ID` filled in. The deadline is short on purpose
(~6 min = 120 blocks, about two plays of the game): once the Geocoin is down,
the rival gets one sitting, not hours to rehearse the same ten cities.
A shot settles before `min(shot_deadline, expiry_block)` and the
champion collects from that block on, so a rival cannot pick a deadline
past the record's own life. Both notes are **public**, tagged `GQ_TAG` (one u32
for the app), and carry Geocoin.

### Binding a shot to its record (the claim check)

The kernel exposes other input notes' script root, storage commitment and
initial assets, not their storage contents. So the record script:

1. loops `0..tx::get_num_input_notes()` for input notes whose
   `input_note::get_script_root(i) == SHOT_ROOT`;
2. for each, reads that note's `shot_deadline` from the advice map (key =
   the note id; the claimant supplies it) and builds the storage the note must
   have: its own storage with `rival = active_account::get_id()`,
   `RECORD_ID = active_note::get_note_id()` and that deadline;
3. hashes the whole storage (same length as its own) with `note::compute_storage_commitment` and compares
   with `input_note::get_storage_info(i).commitment`; a lie about the deadline,
   the rival, the record or the quiz hashes differently;
4. checks the note's *initial* assets (`input_note::get_initial_assets`) hold ≥ `min_stake` of
   the record's asset. Initial, because input notes run in the order the client gives them
   (sorted by id in practice): when the shot script runs first it has already moved its
   Geocoin into the account, and `input_note::get_asset` would return an empty word
   (verified on testnet 2026-10-09, `ERR_WRONG_ASSET`; test `claim_works_whichever_note_runs_first`);
5. aborts if no note passes.

A shot note with altered quiz data, another rival or another record id
hashes differently and cannot claim.

### Deadlines

`tx::get_reference_block_number()` is chosen by the executor and can be
back-dated, so every before-expiry path calls
`tx::update_expiration_block_delta(CLAIM_FUZZ)`; a back-dated block then buys
at most `CLAIM_FUZZ` blocks. After-expiry paths cannot be forged forward.
The record lives `RECORD_LIFETIME_BLOCKS` (~24 h); a shot must be settled
within `SHOT_WINDOW_BLOCKS` (~6 min) of its creation; the client refuses
a shot at a record with fewer than `MIN_SHOT_WINDOW_BLOCKS` left.

### Flow

- Champion plays, posts a record note holding one Geocoin, with `target`,
  `min_stake` (= one Geocoin), expiry and the quiz.
- Rival posts a shot note (1 GC) copying the record storage, then
  plays the same quiz.
- Winner who is first: one transaction consumes the record (claim) and their
  shot note (settle, win): prize plus Geocoin back.
- Later winners: settle their shot note alone (refund) before its deadline.
- Loser: nothing to sign. A losing answer cannot settle; the champion collects
  the Geocoin from the shot deadline (~6 min) on. Record closure never refunds
  shots.
- Champion reclaims an unclaimed record after expiry.

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
- Shot bound to one record and one rival by storage commitment.
- `min_stake` in the record's asset checked onchain against the shot's initial assets.
- The note argument commits to the answers; the script re-hashes the advice-map felts.
- Expiration delta bounds reference-block back-dating.
- Client-side: seed → cities check, dataset hash, rules version, and a
  champion's client only counts a shot whose storage equals the record's.

### Remaining trust assumptions (honest list)

1. Timing and clicks are whatever the browser submits; a modified client
   scores 10 000. Anti-cheat is deferred by the brief.
2. A rival can play first and post the shot only when they know they
   won; nothing onchain orders shot before play (no commitment stage).
3. The champion knows their own quiz. Irrelevant: they want rivals to lose.
4. A wrong `SHOT_ROOT` in a record makes it unclaimable until expiry; only
   the champion is hurt (clients cross-check before taking a shot).
5. Reference block can be back-dated by up to `CLAIM_FUZZ` blocks.
6. Public notes expose scores, ids and amounts.
7. A rival can post a shot and never play; the champion collects after the deadline.
8. Anyone can mint Geocoin: it is testnet play money by design.

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
  port `record.masm`/`shot.masm` to Rust; the storage layout, paths and
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

Bread specifics (found 2026-10-08, see `web/src/lib/bread.ts`):

- A 0.17 Guardian multisig needs its auth args committed in the request. Bread
  does not add them, and the SDK helper (`feeAwareTransactionRequestBuilder`)
  only does so for accounts in the dApp's own store, which a private Bread
  account never is. The app rebuilds `MultisigAuthArgs` itself (12 felts, Poseidon2
  commitment, `withAuthArg` + `extendAdviceMap` + `withBlockNumbers`); the browser
  commitment is checked against the Rust reference (`rules/auth_vectors.json`).
- Bread checks the anchor again **after the user approves**, when its queue turns the request
  into a Guardian proposal (`createCustomProposal` → `executeForSummary`): the transaction goes
  through only if Bread's sync height then is exactly the block the request binds. The time spent
  approving makes that rare. Bread has already answered the dApp at approval, so the dApp cannot see
  the failure or retry. The app's answer: it waits for the effect on chain, returns to the screen
  you came from with "Your wallet did not finish" when it never shows, and keeps a Back button on
  the waiting screen. Root cause and repro for the wallet team: `docs/bread-anchor-mismatch.md`
  (corrected 2026-10-09 evening: the dry run's own mismatch is swallowed, it is not the one users see).

## 5. Repository layout (one repo, no submodules)

```
gq/
  masm/challenge/        challenge_core.masm, record.masm, shot.masm   (reusable)
  masm/games/            gq_score.masm                                     (GeoQuizz)
  integration/           Rust: assemble scripts, rules reference + vectors, MockChain tests,
                         bins: build_scripts, geocoin (deploy/mint), testnet_flow
  web/                   React app from frontend-template PR #31 (SDK 0.17) + Bread adapter
  docs/design.md, docs/walkthrough.md
  tasks/todo.md, tasks/lessons.md
  upstream/              gitignored clones used for verification + the spike
```
