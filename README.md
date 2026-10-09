# GQ · GeoQuizz on Miden

A small, complete reference for a **challenge mechanic** on Miden testnet v0.17: a champion posts a
**record note** with a score to beat; rivals take a **shot** (a shot note holding one Geocoin), play
the same quiz, and the chain recomputes the score from their answers. Beat the record and you take
the prize (first come, first served) and your Geocoin back; fall short and your Geocoin goes to the
champion once the shot's short deadline passes. A loser signs nothing.

GeoQuizz is the game plugged into it: a city name appears, you click the map, points for closeness
and speed, ten cities per quiz. Players use the [Bread](https://www.miden.xyz/bread) wallet.

- Design, verified capabilities, blockers and trust assumptions: [`docs/design.md`](docs/design.md)
- How to run it end to end: [`docs/walkthrough.md`](docs/walkthrough.md)
- Plan and progress: [`tasks/todo.md`](tasks/todo.md)

## Vocabulary

| word | meaning |
|---|---|
| champion | the player holding the score to beat |
| rival | a player who pays one Geocoin to beat it |
| record | what the champion posts and shares: the score and the prize (a **record note**) |
| shot | one rival's paid attempt (a **shot note**, bound to one record) |
| Geocoin (GC) | the token both sides put in: one per record, one per shot |
| challenge | the act, and the name of the reusable mechanic |

## Layout

```
masm/challenge/   challenge_core.masm, record.masm, shot.masm   the reusable mechanic (MASM)
masm/games/       gq_score.masm                                 GeoQuizz scoring, the only game code
integration/      Rust: script assembly, scoring + quiz reference, MockChain tests, testnet binaries
rules/            vectors shared by MASM, Rust and TypeScript (scoring, quiz selection, auth args)
web/              React app (frontend-template v0.17 lineage) + Bread wallet adapter
```

## Note storage layout

Both notes carry the same layout: 16 header felts the core owns, then the game's data in whole
words (GeoQuizz uses 48, so 64 felts in all). The record's facts come first, then the shot's own,
then the script root and the game data. A shot note is its record note's storage with three fields
filled in, which is how the record script recognises a legitimate shot: it rebuilds the 64 felts a
shot at it must have and compares the storage hash.

| felt  | field          | record note                                     | shot note                   |
|-------|----------------|-------------------------------------------------|-----------------------------|
| 0-1   | champion       | [suffix, prefix]                                | copied from the record      |
| 2     | target         | champion's score to beat                        | copied                      |
| 3     | min_stake      | the stake (one Geocoin)                         | copied                      |
| 4     | expiry_block   | record's end (~24 h)                            | copied                      |
| 5-6   | rival          | 0, 0                                            | rival [suffix, prefix]      |
| 7     | shot_deadline  | 0                                               | shot's end (~6 min)         |
| 8-11  | RECORD_ID      | 0                                               | the record note's id        |
| 12-15 | SHOT_ROOT      | shot.masm script root                           | copied                      |
| 16-63 | game data      | seed(4), dataset(4), 10 × [city, lat, lon, cos] | copied                      |

A shot settles before `min(shot_deadline, expiry_block)`; the champion collects from that block
on. The note argument on settle or claim is the commitment to the ten packed answers
(`lat_cd << 32 | (lon_cd * 2048 + t_10ms)` per round, hashed like a note storage); the answers
themselves travel in the advice map under that key and the script re-hashes them. On a claim, the
claimant also puts the shot's deadline in the advice map under the shot note id, and the hash
check proves it.

## Build and test

Toolchain (once): `cargo install --locked midenup && midenup install 0.17.0`.

```sh
cargo test -p integration --release          # scoring reference, 23 MockChain tests (all four paths, their failures, deadlines, note order, answer commitment, a longer game tail)
cargo run --release --bin build_scripts      # assembles the two note scripts into web/public/scripts/
cd web && yarn install && yarn test && yarn dev
```

No Bread at hand? `http://localhost:5173/?local=1` runs a test wallet inside the app (`?local=2`
for a second one): same contracts, same requests, signed by a private single-signature account
the app creates and fee-funds itself.

Geocoins: the faucet (`0x2a85bbc7c655b6d116381742015892` on testnet) has no authentication, so
anyone may mint. In the app, "Empty pockets? Get Geocoins now!" mints ten from the browser; from
the CLI, `cargo run --release --bin geocoin mint <account> <GC>` (`geocoin deploy` creates a new
faucet, `geocoin fees` tops up the fee balance it pays mints with).
`cargo run --release --bin testnet_flow` runs champion / losing rival / winning rival with
in-process wallets.

## Adapting it to another game

1. Replace `masm/games/gq_score.masm` with your `beats_target(ANSWER, data_ptr, target) -> bool`
   procedure. The core hands it the one-Word note argument (GeoQuizz uses it as a commitment to
   data in the advice map), a pointer to your game data (any number of whole words after the
   16-felt header) and the champion's target; you decide what "beats" means (GeoQuizz: a strictly
   higher score).
2. Mirror the scoring in `integration/src/rules.rs` (test vectors) and `web/src/lib/rules.ts`.
3. Keep `masm/challenge/*` as is. Storage layout, the four paths and the binding check do not know
   what the game is.

The note scripts are MASM today because the released Rust compiler (0.11.0) cannot yet call the
standards wallet from a note script; see `docs/design.md` §3 for the port plan.
