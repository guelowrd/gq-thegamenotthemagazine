# GQ · GeoQuizz on Miden

A small, complete reference for a **challenge mechanic** on Miden testnet v0.17: a champion posts a
**record note** with a score to beat; rivals post **shot notes** with a stake, play the same
quiz, and the chain recomputes the score from their answers. Beat the target and you take the prize
(first come, first served) and your stake back; fall short and your stake goes to the champion once
the challenge's short deadline passes. A loser signs nothing.

GeoQuizz is the game plugged into it: a city name appears, you click the map, points for distance
and speed. Players use the [Bread](https://www.miden.xyz/bread) wallet.

- Design, verified capabilities, blockers and trust assumptions: [`docs/design.md`](docs/design.md)
- How to run it end to end: [`docs/walkthrough.md`](docs/walkthrough.md)
- Plan and progress: [`tasks/todo.md`](tasks/todo.md)

## Layout

```
masm/challenge/   challenge_core.masm, record.masm, shot.masm   the reusable mechanic (MASM)
masm/games/       gq_score.masm                                     GeoQuizz scoring, the only game code
integration/      Rust: script assembly, scoring + quiz reference, MockChain tests, testnet binaries
rules/            vectors shared by MASM, Rust and TypeScript (scoring, quiz selection, auth args)
web/              React app (frontend-template v0.17 lineage) + Bread wallet adapter
```

## Note storage layout

Both notes carry the same layout: 16 header felts the core owns, then the game's data in whole
words (GeoQuizz uses 24, so 40 felts in all). The prize's facts come first, then the challenge's
own, then the script root and the game data. A shot note is its record note's storage with three fields
filled in, which is how the prize script recognises a legitimate challenge: it rebuilds the 40
felts a challenge of it must have and compares the storage hash.

| felt  | field              | record note                | shot note          |
|-------|--------------------|---------------------------|-------------------------|
| 0-1   | champion           | [suffix, prefix]          | copied from the prize   |
| 2     | target             | champion's score to beat  | copied                  |
| 3     | min_stake          | the stake                 | copied                  |
| 4     | expiry_block       | prize's end (~24 h)       | copied                  |
| 5-6   | player             | 0, 0                      | rival [suffix, prefix] |
| 7     | shot_deadline | 0                         | challenge's end (~6 min)|
| 8-11  | RECORD_ID           | 0                         | the record note's id     |
| 12-15 | SHOT_ROOT     | shot.masm script root| copied                  |
| 16-39 | game data          | seed(4), dataset(4), 4 × [city, lat, lon, cos] | copied |

A challenge settles before `min(shot_deadline, expiry_block)`; the champion collects from
that block on. The note argument on settle or claim is one Word: four packed answers,
`lat_cd << 32 | (lon_cd * 2048 + t_10ms)` per round. On a claim, the claimant also puts the
challenge's deadline in the advice map under the shot note id, and the hash check proves it.

## Build and test

Toolchain (once): `cargo install --locked midenup && midenup install 0.17.0`.

```sh
cargo test -p integration --release          # scoring reference, 22 MockChain tests (all four paths, their failures, deadlines, note order, a longer game tail)
cargo run --release --bin build_scripts      # assembles the two note scripts into web/public/scripts/
cd web && yarn install && yarn test && yarn dev
```

No Bread at hand? `http://localhost:5173/?local=1` runs a test wallet inside the app (`?local=2`
for a second one): same contracts, same requests, signed by a private single-signature account
the app creates and fee-funds itself. Mint it GQ with `geocoin mint <its 0x… id> 10`.

Testnet: `cargo run --release --bin geocoin deploy|mint <account> <GQ>` and
`cargo run --release --bin testnet_flow` (champion / losing rival / winning rival, in-process wallets).

## Adapting it to another game

1. Replace `masm/games/gq_score.masm` with your `beats_target(ANSWER, data_ptr, target) -> bool`
   procedure. The core hands it the one-Word note argument, a pointer to your game data (any
   number of whole words after the 16-felt header) and the champion's target; you decide what
   "beats" means (GeoQuizz: a strictly higher score).
2. Mirror the scoring in `integration/src/rules.rs` (test vectors) and `web/src/lib/rules.ts`.
3. Keep `masm/challenge/*` as is. Storage layout, the four paths and the binding check do not know
   what the game is.

The note scripts are MASM today because the released Rust compiler (0.11.0) cannot yet call the
standards wallet from a note script; see `docs/design.md` §3 for the port plan.
