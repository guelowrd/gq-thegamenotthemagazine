# GQ walkthrough

(Work in progress; the web part is added as it lands.)

## Testnet run of the challenge mechanic (2026-10-08, protocol 0.17.1)

`cargo run --release --bin testnet_flow` with three fresh private wallets, GQ faucet
`0x02a14387adb68f516e57cc5aa65891`:

| step | tx | block |
|---|---|---|
| champion posts prize note `0x3a4cdefd…` (3 GQ in that Rust run; the app uses the 1 GQ stake, target 2000) | `0x605937cd2e30d9334e10e76c4d50b3bc72386c0e21ee5306c7775e2e98b9315d` | 56406 |
| loser posts challenge note (1 GQ) | `0xc959a2388f7ada28883066b5f19278a286327d6ba4fc43ddfb5f26c00567e190` | 56409 |
| loser settles with a losing answer → stake forfeited to champion (public P2ID) | `0x002140106cb6e56586edad0c5a5c2801f75fa149ddb56919e66820b1114e7b90` | 56411 |
| winner posts challenge note (1 GQ) | `0xb15a34b7ccb6758684b2a6c2646510f24e8ae6afd3923665f4cad77dc1a44f49` | 56414 |
| winner claims prize + stake in one tx (prize note + own challenge note) | `0x8913d0e9cd9f4b0a387002556793bd0e4d2b3d85a40e697bd8674bb2f869fe11` | 56416 |

Balances after (GQ): champion 2 (+1 GQ forfeit still sitting in its P2ID note), loser 4, winner 8.
Explorer: `https://testnet.midenscan.com/tx/<id>`.

## Web app (Bread wallet)

```sh
cargo run --release --bin build_scripts     # once, and after any change under masm/
cd web && yarn install && yarn dev          # http://localhost:5173
```

1. Install Bread (latest release at https://www.miden.xyz/bread, v1.17.1+, testnet build), create a wallet, fund fees ("Fund your wallet": 0.01 USDCx).
2. Get GQ: `cargo run --release --bin gq_faucet mint <your mtst1… address> 10` (anyone with the
   faucet key; ask Gaylord). Bread auto-claims the public P2ID note. The stake is 1 GQ: the champion
   stakes it as the prize, each challenger stakes it to play.
3. Connect, play, "Post prize". Another Bread account: "Challenge", play, the app settles (win →
   stake back, plus the prize if you claimed first; loss → stake forfeited to the champion).
4. After expiry the champion sees "Reclaim prize" / "Collect stake".

Every transaction is built by the app (`web/src/lib/bread.ts`) and signed in Bread. Bread
accounts are guarded multisigs, so the request carries the multisig auth args (bound block,
salt, fee conversion info) and declares the bound block; the app checks its commitment against
the Rust reference at start-up in development ("auth-args self-check: ok").
Notes the wallet never synced travel with their inclusion proofs (`importNotes`).
