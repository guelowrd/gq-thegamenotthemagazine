// A wallet inside the app, for testing without Bread: open the page with `?local=1` (`?local=2` for a second one). The app's own
// Miden client creates a private single-signature account, funds its fees from the testnet faucet
// and signs every request itself. Same contracts, same flows, no popups.
//
// Mutations go through the SDK's own hooks (`useCreateWallet`, `useConsume`, `useTransaction`):
// they own the client lock and the configured prover. Never call them inside `runExclusive`.

import { AccountId, NoteFile, TransactionRequest } from "@miden-sdk/miden-sdk";
import { useConsume, useCreateWallet, useTransaction, type AuthScheme } from "@miden-sdk/react";
import type { Asset, Transaction } from "@miden-sdk/miden-wallet-adapter-base";
import { useCallback, useState } from "react";
import { MIDEN_FAUCET_URL } from "@/config";
import { loadScripts, type Client } from "./chain";
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

      // 2. fees: the chain's fee asset from the public faucet, once
      setStatus("Syncing…");
      const funded = await runExclusive(async () => {
        await client.syncState();
        const fee = await client.feeFaucetId();
        return (await (await client.getAccount(AccountId.fromHex(hex!)))!.vault().getBalance(fee)) > 0n;
      });
      log("funded", funded);
      if (!funded) {
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
      // 3. whatever was sent to this account (Geocoin mints, prizes won): claim it, as Bread does by itself.
      //    GQ notes are left alone, they need arguments and the app consumes them.
      const { recordRoot, shotRoot } = await loadScripts();
      const pending = await runExclusive(async () =>
        (await client.getConsumableNotes(AccountId.fromHex(hex!)))
          .flatMap((n) => n.inputNoteRecord() ?? [])
          .filter((r) => {
            const root = r.details().recipient().script().root().toHex();
            return root !== recordRoot && root !== shotRoot;
          })
          .map((r) => r.id().toString()),
      );
      if (pending.length > 0) {
        setStatus("Claiming…");
        const r = await consume({ accountId: hex, notes: pending });
        log("claimed", pending.length, "note(s)", r.transactionId);
      }
      setId(hex);
      log("connected");
    } catch (e) {
      log("failed", e);
      throw e;
    } finally {
      setConnecting(false);
      setStatus("");
    }
  }, [client, runExclusive, createWallet, consume]);

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
