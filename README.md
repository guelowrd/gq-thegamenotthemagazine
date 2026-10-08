# GQ · GeoQuiz on Miden

A small, complete reference for a **challenge mechanic** on Miden testnet v0.17: a champion posts a
**prize note** with a score to beat; challengers post **challenge notes** with a stake, play the same
quiz, and the chain recomputes the score from their answers. Beat the target and you take the prize
(first come, first served) and your stake back; fall short and your stake goes to the champion.

GeoQuiz is the game plugged into it: a city name appears, you click the map, points for distance
and speed. Players use the [Bread](https://github.com/0xMiden/wallet/releases) wallet.

- Design, verified capabilities, blockers and trust assumptions: [`docs/design.md`](docs/design.md)
- How to run it end to end: [`docs/walkthrough.md`](docs/walkthrough.md)
- Plan and progress: [`tasks/todo.md`](tasks/todo.md)

## Layout

```
masm/challenge/   challenge_core.masm, prize.masm, challenge.masm   the reusable mechanic (MASM)
masm/games/       gq_score.masm                                     GeoQuiz scoring, the only game code
integration/      Rust: script assembly, scoring + quiz reference, MockChain tests, testnet binaries
rules/            vectors shared by MASM, Rust and TypeScript (scoring, quiz selection, auth args)
web/              React app (frontend-template v0.17 lineage) + Bread wallet adapter
```

## Build and test

Toolchain (once): `cargo install --locked midenup && midenup install 0.17.0`.

```sh
cargo test -p integration --release          # scoring reference, 17 MockChain tests (all four paths and their failures)
cargo run --release --bin build_scripts      # assembles the two note scripts into web/public/scripts/
cd web && yarn install && yarn test && yarn dev
```

Testnet: `cargo run --release --bin gq_faucet deploy|mint <account> <GQ>` and
`cargo run --release --bin testnet_flow` (champion / losing challenger / winning challenger, in-process wallets).

## Adapting it to another game

1. Replace `masm/games/gq_score.masm` with your `score(ANSWER, data_ptr) -> u32` procedure. The core
   gives it the one-Word note argument and a pointer to 24 felts of game data you define.
2. Mirror the scoring in `integration/src/rules.rs` (test vectors) and `web/src/lib/rules.ts`.
3. Keep `masm/challenge/*` as is. Storage layout, the four paths and the binding check do not know
   what the game is.

The note scripts are MASM today because the released Rust compiler (0.11.0) cannot yet call the
standards wallet from a note script; see `docs/design.md` §3 for the port plan.
