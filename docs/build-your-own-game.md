# Build your own game on the challenge mechanic

The mechanic: a **champion** posts a **record** (a score to beat, with a prize). A **rival** pays a
stake to take a **shot** at it, plays the same game, and the chain checks the result. The first
rival who beats the record takes the prize and their stake back. A rival who fails signs nothing:
their stake goes to the champion once the shot's short deadline passes. An unbeaten record goes
back to the champion when it expires.

All of that lives in three MASM files you do not touch (`masm/challenge/`). Your game is one
procedure. GeoQuizz is the full example; a six-line game is in the tests.

## 1. Write the game: one procedure

A MASM module that exports `beats_target`:

```
Inputs:  [ANSWER, data_ptr, target]
Outputs: [beats_target]
```

- `ANSWER` is the note argument the rival passes when claiming (one word).
- `data_ptr` points at your game's data in memory: whatever you stored after the note header.
- `target` is the champion's score.
- Return 1 when the answer beats the target. You decide what "beats" means.

The smallest complete game, "higher number wins", from `integration/tests/challenge_test.rs`:

```masm
pub proc beats_target
    # => [N, N, N, N, data_ptr, target]
    drop drop drop swap drop
    # => [n, target]
    swap gt
end
```

Answers bigger than one word: make `ANSWER` a commitment and read the data from the advice map
under it, then re-hash and compare. GeoQuizz does this for its ten answers (`load_answers` in
`masm/games/gq_score.masm`, about fifteen lines).

The core imports your module as `game::rules`. Build the two note scripts with it:

```rust
let (record_script, shot_script) = integration::scripts::scripts_for(MY_GAME_MASM)?;
```

`cargo run --release --bin build_scripts` writes GeoQuizz's to `web/public/scripts/`; point it at
your module to ship yours. Two games never share script roots, so their notes never mix.

## 2. The note storage

A record and its shots share one layout: a 16-felt header the core owns, then your game's data in
whole words (any length, GeoQuizz uses 48). The header table is in the [README](../README.md#note-storage-layout).
A shot is its record's storage with three fields filled in: the rival, the shot's deadline and the
record's id. The record recognises its shots by hashing that expected storage.

Host side: `ChallengeStorage` in `integration/src/storage.rs` (Rust) and `web/src/lib/notes.ts`
(TypeScript), both game-agnostic (`game` is your data).

## 3. The four transactions

| who | when | consumes | note argument | advice map | effect |
|---|---|---|---|---|---|
| champion | any time | nothing; creates the **record** note (record script, your data, the prize) | | | record posted |
| rival | before the record expires | nothing; creates a **shot** note (shot script, `shotStorage(record, …)`, the stake) | | | shot posted |
| rival | before the shot's deadline | the shot (and the record, to claim the prize) | your `ANSWER`, on every note | each shot's id → `[shot_deadline]`, plus your game's entries | win: prize and stake back (or stake only) |
| champion | after the shot's deadline / the record's expiry | the shot / the record | zero | | collect a lost stake / take the record back |

A losing answer cannot consume anything, so a loss needs no transaction.

Code to copy:

- Rust, any client: `integration/src/bin/testnet_flow.rs` (post, consume with advice) and
  `integration::deadline_advice(shot_root, notes)`.
- Web: `web/src/lib/bread.ts` (`postRecord`, `postShot`, `settle(…, answer)`, `collect`) with
  `GameAnswer = { arg, advice }` from `notes.ts`; GeoQuizz's is `gqAnswer` in `rules.ts`.

## 4. What the core guarantees

- A shot belongs to one record and one rival (storage commitment), carries at least `min_stake`
  of the record's asset, and is checked by its **initial** assets (input notes run in any order).
- A shot is settleable before `min(shot_deadline, expiry_block)`; from then on only the champion
  can collect it. The record can be claimed before `expiry_block`, reclaimed after.
- A back-dated reference block buys at most 64 blocks (`CLAIM_FUZZ`).
- The game's verdict is the only thing that decides a win.

What it does not do: anti-cheat. The chain recomputes the score from the answers, but it cannot
know how the answers were produced. See the trust list in [design.md](design.md).

## 5. Pitfalls we paid for

- **Watch the chain, not the wallet.** A wallet saying yes means it accepted the request, not that
  the transaction landed. Wait for the effect (the note exists, or it is consumed).
- **Show the shot's deadline.** A winner who claims too late loses the stake to the champion.
  Before claiming again, check whether the shot is already consumed: before its deadline only its
  rival can consume it (`claimVerdict` in `web/src/lib/flow.ts`).
- **Your own notes are output notes.** A note your account created never shows up as an input
  note in your local store; read both lists.
- **WASM handles are consumed.** A `Word`, `NoteArray` or `AccountId` passed to an SDK builder call
  is freed by it; build fresh ones per attempt and keep ids as hex.
- **Bread (Guardian multisig) accounts** need the multisig auth args in every request
  (`multisigAuthArgs` in `bread.ts`), and Bread 1.17.1 checks the request's bound block against
  its own sync height after approval, without telling the dApp when it fails. The app's timing
  workaround is in `bread.ts`; the root cause and repro are in
  [bread-anchor-mismatch.md](bread-anchor-mismatch.md).

## 6. Test it

- MockChain, no node needed: `setup_for(target, MY_GAME_MASM, my_game_felts)` and
  `consume_with_arg` in `integration/tests/common/mod.rs`. Copy
  `another_game_plugs_into_the_same_core` and the deadline tests.
- Mirror your scoring host side and pin both to shared vectors, as GeoQuizz does with
  `rules/vectors.json` (Rust, MASM and TypeScript all read it).
- On testnet, `?local=1` and `?local=2` give the web app two wallets of its own, no extension needed.

## Checklist

1. `my_game.masm` with `beats_target`.
2. `scripts_for(MY_GAME_MASM)`; ship the two scripts.
3. Host mirror of the scoring, with shared vectors.
4. MockChain tests: claim, settle, refusal, deadlines.
5. Client: the four transactions, the answer's note argument and advice, deadlines on screen.
6. Pick your own note tag and token.
