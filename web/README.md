# GeoQuizz web app

The React app for GeoQuizz on Miden testnet: play, post a record, take shots, claim. The project
overview, the challenge mechanic and how to build your own game on it are in the
[root README](../README.md) and [docs/build-your-own-game.md](../docs/build-your-own-game.md).

```sh
yarn install
yarn dev          # http://localhost:5173 (Bread wallet); ?local=1 / ?local=2 for in-app test wallets
yarn test         # vitest
yarn lint
yarn build
```

Where things are:

| path | what |
|---|---|
| `src/lib/notes.ts` | the mechanic's note storage (any game): header + game data, shots, deadlines |
| `src/lib/chain.ts` | reading records and shots from the chain, building notes |
| `src/lib/bread.ts` | the four transactions (post a record, take a shot, claim, collect) and the wallet layer |
| `src/lib/flow.ts` | the app's decisions as pure functions (tested), errors in plain words |
| `src/lib/rules.ts`, `src/lib/quiz.ts` | GeoQuizz itself: scoring, answers, city selection, game data |
| `src/components/` | screens; `AppContent.tsx` wires them |
| `public/scripts/` | the assembled note scripts (`cargo run --release --bin build_scripts`) |
| `public/brand/` | art, font, music |
