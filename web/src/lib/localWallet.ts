// A wallet inside the app, for testing without Bread: open the page with `?local=1` (`?local=2` for a second one). The app's own
// Miden client creates a private single-signature account, funds its fees (testnet faucet; on mainnet the node pays a registered account, `&code=` an invite code)
// and signs every request itself. Same contracts, same flows, no popups.
//
// Mutations go through the SDK's own hooks (`useCreateWallet`, `useConsume`, `useTransaction`):
// they own the client lock and the configured prover. Never call them inside `runExclusive`.

import { AccountId, NoteFile, NoteScript, TransactionRequest } from "@miden-sdk/miden-sdk";
import { useConsume, useCreateWallet, useTransaction, type AuthScheme } from "@miden-sdk/react";
import type { Asset, Transaction } from "@miden-sdk/miden-wallet-adapter-base";
import { useCallback, useState } from "react";
import { MAINNET, MIDEN_FAUCET_URL } from "@/config";
import { loadScripts, type Client } from "./chain";
import { noteKind } from "./flow";
import { requestFaucetTokens } from "./funding";

const LOCAL = typeof location !== "undefined" ? new URLSearchParams(location.search).get("local") : null;
export const LOCAL_WALLET = LOCAL !== null;
// `?local=1` is the first wallet, `?local=2` a second one: a champion and a rival in two tabs
const KEY = LOCAL === "1" || LOCAL === "" ? "gq:local-wallet" : `gq:local-wallet:${LOCAL}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** The same surface the app uses from `useMidenFiWallet()`, backed by the local account. */
export function useLocalWallet(client: Client | null, runExclusive: <T>(fn: () => Promise<T>) => Promise<T>) {
  const { createWallet } = useCreateWallet();
  const { consume } = useConsume();
  const { execute } = useTransaction();
  // the id travels as hex: a WASM AccountId handed to a client call is consumed (freed) by it
  const [id, setId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [status, setStatus] = useState("");

  /**
   * Claims every consumable note that is not a GQ note (those need arguments and the app consumes
   * them), waiting up to `waitMs` for one to show up first (a mint just submitted takes a block).
   * Returns how many were claimed.
   */
  const claimIncoming = useCallback(
    async (hex: string, waitMs: number): Promise<number> => {
      if (!client) throw new Error("client not ready");
      const scripts = await loadScripts();
      const pswapRoot = NoteScript.pswap().root().toHex();
      const deadline = Date.now() + waitMs;
      let pending: string[] = [];
      for (;;) {
        pending = await runExclusive(async () => {
          await client.syncState();
          return (await client.getConsumableNotes(AccountId.fromHex(hex)))
            .flatMap((n) => n.inputNoteRecord() ?? [])
            .filter((r) => {
              const root = r.details()?.recipient().script().root().toHex();
              // game notes are not payments; a sale note of this wallet is consumable by it, which would cancel the sale
              return !root || (!noteKind(root, scripts) && root !== pswapRoot && root !== scripts.saleRoot);
            })
            .flatMap((r) => r.id()?.toString() ?? []);
        });
        if (pending.length > 0 || Date.now() >= deadline) break;
        await sleep(3000);
      }
      if (pending.length === 0) return 0;
      const r = await consume({ accountId: hex, notes: pending });
      console.info("[gq local] claimed", pending.length, "note(s)", r.transactionId);
      return pending.length;
    },
    [client, runExclusive, consume],
  );

  const connect = useCallback(async () => {
    if (!client) throw new Error("client not ready");
    setConnecting(true);
    const log = (...a: unknown[]) => console.info("[gq local]", ...a);
    try {
      // 1. the account: create once, then reuse
      let hex = localStorage.getItem(KEY);
      if (!hex || !(await runExclusive(() => client.getAccount(AccountId.fromHex(hex!))))) {
        setStatus("Creating wallet…");
        // 2 = AuthScheme.AuthRpoFalcon512; passing the enum object has resolved to undefined in
        // this build, and an undefined scheme makes newWallet hang instead of failing
        const account = await createWallet({ storageMode: "private", authScheme: 2 as AuthScheme });
        hex = account.id().toString();
        localStorage.setItem(KEY, hex);
      }
      log("wallet", hex);

      // 2. fees: the chain's fee asset, once: on mainnet the node pays a registered account (`?code=` an
      // invite code, one use), on testnet the public faucet does
      setStatus("Syncing…");
      const funded = await runExclusive(async () => {
        await client.syncState();
        const fee = await client.feeFaucetId();
        return (await (await client.getAccount(AccountId.fromHex(hex!)))!.vault().getBalance(fee)) > 0n;
      });
      log("funded", funded);
      if (!funded && MAINNET) {
        const code = new URLSearchParams(location.search).get("code");
        if (code) {
          setStatus("Registering…");
          await runExclusive(() => client.registerAccount(AccountId.fromHex(hex!), code));
          log("registered");
        }
        // the node's funding note (a public P2ID) reaches the store a sync or two after registration
        setStatus("Waiting for the funding note…");
        if ((await claimIncoming(hex, 90_000)) === 0) {
          throw new Error(code ? "The funding note never arrived." : "A new mainnet account needs an invite code: add ?code=… to the address.");
        }
      } else if (!funded) {
        setStatus("Getting test money…");
        const noteId = await requestFaucetTokens(MIDEN_FAUCET_URL, hex);
        log("faucet note", noteId);
        let seen = false;
        for (let i = 0; i < 60 && !seen; i++) {
          setStatus(`Waiting for test money… (${i + 1})`);
          seen = await runExclusive(async () => {
            await client.syncState();
            return !!(await client.getInputNote(noteId))?.inclusionProof();
          });
          if (!seen) await sleep(3000);
        }
        if (!seen) throw new Error("The faucet note never arrived.");
        setStatus("Claiming test money…");
        log("claiming");
        const r = await consume({ accountId: hex, notes: [noteId] });
        log("claimed", r.transactionId);
      }
      // 3. whatever was sent to this account (Gamecoin mints, prizes won): claim it, as Bread does by itself.
      setStatus("Claiming…");
      await claimIncoming(hex, 0);
      setId(hex);
      log("connected");
    } catch (e) {
      log("failed", e);
      throw e;
    } finally {
      setConnecting(false);
      setStatus("");
    }
  }, [client, runExclusive, createWallet, consume, claimIncoming]);

  /** Executes a dApp-built custom transaction with the local account (what Bread would do). */
  const requestTransaction = useCallback(
    async (tx: Transaction): Promise<string> => {
      if (!client || !id) throw new Error("local wallet not connected");
      const p = tx.payload as { transactionRequest: string; importNotes?: string[] };
      await runExclusive(async () => {
        for (const note of p.importNotes ?? []) await client.importNoteFile(NoteFile.deserialize(b64(note)));
      });
      const result = await execute({ accountId: id, request: TransactionRequest.deserialize(b64(p.transactionRequest)) });
      return result.transactionId;
    },
    [client, id, runExclusive, execute],
  );

  return {
    local: true as const,
    connected: !!id,
    connecting,
    status,
    address: id,
    wallet: { readyState: "Installed" },
    connect,
    disconnect: async () => setId(null),
    /** After a mint: wait for the note and claim it (Bread does this by itself). */
    claim: () => claimIncoming(id!, 90_000),
    requestTransaction,
    requestAssets: async (): Promise<Asset[]> =>
      runExclusive(async () =>
        (await client!.getAccount(AccountId.fromHex(id!)))!
          .vault()
          .fungibleAssets()
          .map((a) => ({ faucetId: a.faucetId().toString(), amount: a.amount().toString() })),
      ),
  };
}
