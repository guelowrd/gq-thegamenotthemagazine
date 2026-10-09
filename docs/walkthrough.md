# GQ walkthrough

(Work in progress; the web part is added as it lands.)

## Testnet run of the challenge mechanic (2026-10-08, protocol 0.17.1)

`cargo run --release --bin testnet_flow` with three fresh private wallets, GQ faucet
`0x02a14387adb68f516e57cc5aa65891`:

| step | tx | block |
|---|---|---|
| champion posts record note `0x3a4cdefd…` (3 GQ in that Rust run; the app uses the 1 GQ stake, target 2000) | `0x605937cd2e30d9334e10e76c4d50b3bc72386c0e21ee5306c7775e2e98b9315d` | 56406 |
| loser posts shot note (1 GQ) | `0xc959a2388f7ada28883066b5f19278a286327d6ba4fc43ddfb5f26c00567e190` | 56409 |
| loser settles with a losing answer → stake forfeited to champion (public P2ID) | `0x002140106cb6e56586edad0c5a5c2801f75fa149ddb56919e66820b1114e7b90` | 56411 |
| winner posts shot note (1 GQ) | `0xb15a34b7ccb6758684b2a6c2646510f24e8ae6afd3923665f4cad77dc1a44f49` | 56414 |
| winner claims prize + stake in one tx (record note + own shot note) | `0x8913d0e9cd9f4b0a387002556793bd0e4d2b3d85a40e697bd8674bb2f869fe11` | 56416 |

Balances after (GQ): champion 2 (+1 GQ forfeit still sitting in its P2ID note), loser 4, winner 8.
Explorer: `https://testnet.midenscan.com/tx/<id>`.

## Web app (Bread wallet)

First prize posted from Bread (2026-10-08): note `0x649864af…`, 1 GQ, target 2850, expiry block
60634, tx `0x3d45e4bd3eb06055831646954503d8db75ebf8cdc12c8dff820a08baa290bc01`, from
a Bread account.

```sh
cargo run --release --bin build_scripts     # once, and after any change under masm/
cd web && yarn install && yarn dev          # http://localhost:5173
```

1. Install Bread (latest release at https://www.miden.xyz/bread, v1.17.1+, testnet build), create a wallet, fund fees ("Fund your wallet": 0.01 USDCx).
2. Get GQ: `cargo run --release --bin geocoin mint <your mtst1… address> 10` (anyone with the
   faucet key; ask Gaylord). Bread auto-claims the public P2ID note. The stake is 1 GQ: the champion
   stakes it as the prize, each rival stakes it to play.
3. Connect, "Play", then "Yes" to put 1 GQ on your score. Another account opens the shared link
   and clicks "Play (1 GQ)". A win settles (stake back, plus the prize if you claimed first); a
   loss signs nothing, the champion collects the stake once the challenge deadline (~6 min) passes.
4. The lobby only ever shows your own notes: "Yours" (your prizes, "Take it back" after expiry),
   "Finish your game" (your open challenges), "For you" (failed challenges on your prizes, "Take
   it" after their deadline).
5. Share: after posting, the champion gets "Share on X" and a link of the form
   `<app>/?prize=<note id>`. Opening it loads the prize straight from the node (no lobby needed)
   and offers "Challenge & play": one click posts the shot note and starts the quiz as soon
   as the note is on chain; the app then settles the challenge (and claims the prize on a win).

Every transaction is built by the app (`web/src/lib/bread.ts`) and signed in Bread. Bread
accounts are guarded multisigs, so the request carries the multisig auth args (bound block,
salt, fee conversion info) and declares the bound block; the app checks its commitment against
the Rust reference at start-up in development ("auth-args self-check: ok").
Notes the wallet never synced travel with their inclusion proofs (`importNotes`).

## Web app without Bread (local test wallet)

`http://localhost:5173/?local=1` creates a private single-signature account in the app's own
store (fee-funded from the public faucet, ~1 min of proof-of-work on first use), remembers it in
`localStorage`, claims whatever is sent to it on connect, and signs the very same requests Bread
would. `?local=2` is a second wallet, so one browser can play both sides. Mint GQ to the id shown
in the header: `cargo run --release --bin geocoin mint <0x… id> 10`.

Full round verified this way on 2026-10-09 (test wallets `0x071d3da3…` champion, `0x35b6665a…`
rival): prize `0x6c3143e9…` (target 900), challenge posted from the shared link, perfect
play, prize + stake claimed in one transaction; a lost challenge signed nothing and its stake was
collected by the champion after the deadline. Balances reconciled to the GQ.

Troubleshooting: `SummaryAnchorMismatchError: the transaction summary binds block commitment …
but the captured chain anchor is …` comes from Bread anchoring at its own sync height; the app
retries with a fresh block automatically (see design.md, Bread specifics). A `You need N GQ`
error means the wallet has no GQ yet: mint with `geocoin mint`. A transaction that fails with
`assertion failed with error code: <number>` failed inside the note scripts;
`cargo run --release --bin probe` prints the code of every message (for example
`14434107113890732517` = "challenge: the deadline has passed", normal after ~6 min).

Prizes posted before 2026-10-09 carry the previous prize script (root `0x320f3695…`, listed in
`web/src/config.ts` as legacy): they still show under "Yours" for take-back and their failed
challenges under "For you", but no new challenge is offered on them. Their claim path read the
challenge's *current* assets and failed whenever the shot note's script ran first.
