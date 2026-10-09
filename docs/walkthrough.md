# GQ walkthrough

Words: a **champion** posts a **record** (record note: score to beat + 1 Geocoin); a **rival** takes a
**shot** (shot note, 1 Geocoin) at it. **Geocoin (GC)** is the token. Rules v2 since 2026-10-09:
ten cities, 15 s each, 1000 max per city.

## Rules v2 round on testnet (2026-10-09, in-app test wallets)

Champion `0x071d3da3…` (`?local=1`), rival `0x35b6665a…` (`?local=2`), Geocoin faucet
`0x2a85bbc7c655b6d116381742015892` (no auth: both wallets minted their own 10 GC from the app's
"Empty pockets? Get Geocoins now!" button, claimed by the local wallet itself).

| step | note | state |
|---|---|---|
| champion plays 9690 and posts a record (1 GC) | record `0x3e5feb91…` (target 9690, expiry block 111298) | |
| rival opens the share link, takes a shot (1 GC) and loses (0 points, antipodes) | shot `0x4ea99130…` (deadline block 82645) | nothing signed |
| rival plays the same open shot again, 9792 points | | claim + settle in one tx, both notes consumed by block 82655 |

The 1 GC the rival put down came back with the 1 GC prize. Collect after a missed deadline and
reclaim after expiry are unchanged from the rules-v1 round below and covered by the MockChain
tests (`champion_collects_after_expiry_only`, `champion_reclaims_after_expiry_only`).

## Testnet run of the challenge mechanic (2026-10-08, protocol 0.17.1, rules v1)

`cargo run --release --bin testnet_flow` with three fresh private wallets, the first GQ faucet
`0x02a14387adb68f516e57cc5aa65891` (the GQ token of rules v1; replaced by Geocoin):

| step | tx | block |
|---|---|---|
| champion posts record note `0x3a4cdefd…` (3 GQ in that Rust run; the app uses the 1 GQ stake, target 2000) | `0x605937cd2e30d9334e10e76c4d50b3bc72386c0e21ee5306c7775e2e98b9315d` | 56406 |
| loser posts shot note (1 GQ) | `0xc959a2388f7ada28883066b5f19278a286327d6ba4fc43ddfb5f26c00567e190` | 56409 |
| loser settles with a losing answer → stake forfeited to champion (public P2ID) | `0x002140106cb6e56586edad0c5a5c2801f75fa149ddb56919e66820b1114e7b90` | 56411 |
| winner posts shot note (1 GQ) | `0xb15a34b7ccb6758684b2a6c2646510f24e8ae6afd3923665f4cad77dc1a44f49` | 56414 |
| winner claims prize + stake in one tx (record note + own shot note) | `0x8913d0e9cd9f4b0a387002556793bd0e4d2b3d85a40e697bd8674bb2f869fe11` | 56416 |

Balances after (GQ, the v1 token): champion 2 (+1 forfeit still sitting in its P2ID note), loser 4, winner 8.
Explorer: `https://testnet.midenscan.com/tx/<id>`.

## Web app (Bread wallet)

First record posted from Bread (2026-10-08, rules v1): note `0x649864af…`, 1 GQ, target 2850,
expiry block 60634, tx `0x3d45e4bd3eb06055831646954503d8db75ebf8cdc12c8dff820a08baa290bc01`, from
a Bread account. Notes posted under rules v1 (prize script root `0x320f3695…`
and earlier) are not recognised by the app any more.

```sh
cargo run --release --bin build_scripts     # once, and after any change under masm/
cd web && yarn install && yarn dev          # http://localhost:5173
```

1. Install Bread (latest release at https://www.miden.xyz/bread, v1.17.1+, testnet build), create a wallet, fund fees ("Fund your wallet": 0.01 USDCx).
2. Get Geocoins: once connected, "Empty pockets? Get Geocoins now!" mints 10 GC from the
   browser (the faucet has no key, anyone may mint); Bread auto-claims the public P2ID note.
   From the CLI: `cargo run --release --bin geocoin mint <your mtst1… address> 10`. One Geocoin per
   record, one per shot.
3. Connect, "Play", then "Yes" to put 1 GC on your score. Another account opens the shared link
   and clicks "Play (1 GC)". A win settles (Geocoin back, plus the prize if you claimed first); a
   loss signs nothing, the champion collects the Geocoin once the shot deadline (~6 min) passes.
4. The lobby only ever shows your own notes: "My records" ("Take it back" after expiry),
   "My shots" (open shots, "Play" again on a loss while the deadline holds), "For you" (lost shots
   at your records, "Take it" after their deadline).
5. Share: after posting, the champion gets "Share on X" and a link of the form
   `<app>/?record=<note id>` (`?prize=` links from before still open). Opening it loads the record
   straight from the node (no lobby needed) and offers "Play (1 GC)": one click posts the shot
   note and starts the quiz as soon as the note is on chain; the app then settles the shot (and
   claims the prize on a win).

Every transaction is built by the app (`web/src/lib/bread.ts`) and signed in Bread. Bread
accounts are guarded multisigs, so the request carries the multisig auth args (bound block,
salt, fee conversion info) and declares the bound block; the app checks its commitment against
the Rust reference at start-up in development ("auth-args self-check: ok").
Notes the wallet never synced travel with their inclusion proofs (`importNotes`).

## Web app without Bread (local test wallet)

`http://localhost:5173/?local=1` creates a private single-signature account in the app's own
store (fee-funded from the public faucet, ~1 min of proof-of-work on first use), remembers it in
`localStorage`, claims whatever is sent to it on connect, and signs the very same requests Bread
would. `?local=2` is a second wallet, so one browser can play both sides. Geocoins come from the
same button as with Bread; the local wallet claims the minted note itself.

Full rules-v1 round verified this way on 2026-10-09 morning (test wallets `0x071d3da3…` champion,
`0x35b6665a…` rival): prize `0x6c3143e9…` (target 900), shot posted from the shared link,
perfect play, prize + stake claimed in one transaction; a lost shot signed nothing and its stake
was collected by the champion after the deadline. Balances reconciled. The rules-v2 round is at
the top of this file.

Driving these tabs from Claude in Chrome: keep a tab under five minutes old (Chrome then throttles
a hidden tab's timers to once a minute and the quiz stalls), click the map with a dispatched
`MouseEvent` from `cities.json` coordinates, and read the note ids with `list_gq`.

Troubleshooting: `SummaryAnchorMismatchError: the transaction summary binds block commitment …
but the captured chain anchor is …` comes from Bread anchoring at its own sync height; the app
retries with a fresh block automatically (see design.md, Bread specifics). A `You need N GC`
error means the wallet has no Geocoin yet: press "Get Geocoins". A transaction that fails with
`assertion failed with error code: <number>` failed inside the note scripts;
`cargo run --release --bin probe` prints the code of every message (for example
`14434107113890732517` = "challenge: the deadline has passed", normal after ~6 min;
`gq: the advice map does not hold the answers the note argument commits to` when the answers
and their commitment disagree).
