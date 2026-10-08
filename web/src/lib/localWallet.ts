// A wallet inside the app, for testing without Bread: open the page with `?local=1`. The app's own
// Miden client creates a private single-signature account, funds its fees from the testnet faucet
// and signs every request itself. Same contracts, same flows, no popups.

import { AccountId, AccountStorageMode, AuthScheme, NoteFile, TransactionProver, TransactionRequest } from "@miden-sdk/miden-sdk";
import type { Asset, Transaction } from "@miden-sdk/miden-wallet-adapter-base";
import { useCallback, useState } from "react";
import { MIDEN_FAUCET_URL } from "@/config";
import type { Client } from "./chain";
import { requestFaucetTokens } from "./funding";

export const LOCAL_WALLET = typeof location !== "undefined" && new URLSearchParams(location.search).has("local");
const KEY = "gq:local-wallet";
/** Proving in the page blocks it for minutes; the testnet prover does it in seconds. */
const prover = () => TransactionProver.newRemoteProver("https://tx-prover.testnet.miden.io");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
/** A client call that never resolves would leave the button spinning forever; surface it instead. */
const within = <T>(ms: number, what: string, p: Promise<T>) =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} took more than ${ms / 1000} s`)), ms))]);

/** Creates (once) or reopens the local account and makes sure it can pay fees. */
async function open(client: Client, onStatus: (s: string) => void): Promise<AccountId> {
  let hex = localStorage.getItem(KEY);
  if (!hex || !(await client.getAccount(AccountId.fromHex(hex)))) {
    onStatus("Creating wallet…");
    const seed = crypto.getRandomValues(new Uint8Array(32));
    // 2 = AuthScheme.AuthRpoFalcon512; the enum import has resolved to undefined in some builds,
    // and an undefined scheme makes newWallet hang instead of failing
    console.info("[gq] AuthScheme.AuthRpoFalcon512 =", AuthScheme.AuthRpoFalcon512);
    const account = await within(60_000, "creating the wallet", client.newWallet(AccountStorageMode.private(), 2 as AuthScheme, seed));
    hex = account.id().toString();
    localStorage.setItem(KEY, hex);
  }
  const id = AccountId.fromHex(hex);
  console.info(`[gq] local wallet ${hex}`);

  onStatus("Syncing…");
  await within(60_000, "syncing", client.syncState());
  const fee = await client.feeFaucetId();
  if ((await (await client.getAccount(id))!.vault().getBalance(fee)) > 0n) return id;

  onStatus("Getting test money…");
  const noteId = await requestFaucetTokens(MIDEN_FAUCET_URL, hex);
  for (let i = 0; i < 60; i++) {
    await client.syncState();
    const rec = (await client.getConsumableNotes(id)).find((n) => n.inputNoteRecord().id()?.toString() === noteId);
    if (rec) {
      onStatus("Claiming test money…");
      const request = await client.newConsumeTransactionRequest([rec.inputNoteRecord().toNote()], id);
      await client.submitNewTransactionWithProver(id, request, prover());
      return id;
    }
    onStatus(`Waiting for test money… (${i + 1})`);
    await sleep(3000);
  }
  throw new Error("The faucet note never arrived.");
}

/** Executes a dApp-built custom transaction with the local account (what Bread would do). */
async function execute(client: Client, id: AccountId, tx: Transaction): Promise<string> {
  const p = tx.payload as { transactionRequest: string; importNotes?: string[] };
  for (const note of p.importNotes ?? []) await client.importNoteFile(NoteFile.deserialize(b64(note)));
  const request = TransactionRequest.deserialize(b64(p.transactionRequest));
  return (await client.submitNewTransactionWithProver(id, request, prover())).toString();
}

/** The same surface the app uses from `useMidenFiWallet()`, backed by the local account. */
export function useLocalWallet(client: Client | null, runExclusive: <T>(fn: () => Promise<T>) => Promise<T>) {
  const [id, setId] = useState<AccountId | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [status, setStatus] = useState("");

  const connect = useCallback(async () => {
    if (!client) throw new Error("client not ready");
    setConnecting(true);
    try {
      setId(await runExclusive(() => open(client, setStatus)));
    } finally {
      setConnecting(false);
      setStatus("");
    }
  }, [client, runExclusive]);

  return {
    local: true as const,
    connected: !!id,
    connecting,
    status,
    address: id?.toString() ?? null,
    wallet: { readyState: "Installed" },
    connect,
    disconnect: async () => setId(null),
    requestTransaction: (tx: Transaction) => runExclusive(() => execute(client!, id!, tx)),
    requestAssets: async (): Promise<Asset[]> =>
      runExclusive(async () =>
        (await client!.getAccount(id!))!
          .vault()
          .fungibleAssets()
          .map((a) => ({ faucetId: a.faucetId().toString(), amount: a.amount().toString() })),
      ),
  };
}
