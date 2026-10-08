import { useEffect, useState, useCallback, useRef } from "react";
import {
  useMiden, useMidenClient, useCreateWallet, useConsume,
  useTransaction, useWaitForCommit,
} from "@miden-sdk/react";
import {
  Package,
  NoteScript,
  Note,
  NoteAssets,
  NoteMetadata,
  NoteRecipient,
  NoteStorage,
  NoteTag,
  NoteType,
  NoteArray,
  FeltArray,
  Felt,
  Word,
  type Account,
} from "@miden-sdk/miden-sdk";
import { parseAccountId, randomWord } from "@/lib/miden";
import { fundAccounts } from "@/lib/funding";
import {
  COUNTER_SLOT_NAME,
  EXPLORER_BASE_URL,
  INCREMENT_NOTE_PACKAGE_URL,
  NETWORK_POLL_INTERVAL_MS,
  NETWORK_POLL_TIMEOUT_MS,
} from "@/config";

// Fixed storage key the counter component uses for its value: Word [0,0,0,1].
const countKey = () =>
  Word.newFromFelts([new Felt(0n), new Felt(0n), new Felt(0n), new Felt(1n)]);

// Read the counter value out of an account's storage map.
function readCount(account: Account): number {
  const value = account.storage().getMapItem(COUNTER_SLOT_NAME, countKey());
  return value ? Number(value.toU64s()[0]) : 0;
}

const pollOptions = {
  intervalMs: NETWORK_POLL_INTERVAL_MS,
  timeoutMs: NETWORK_POLL_TIMEOUT_MS,
};
const sleep = () => new Promise((resolve) => setTimeout(resolve, pollOptions.intervalMs));

/**
 * v0.17 counter increment.
 *
 * The counter is a public, `NoAuth` account, so anyone can execute a transaction
 * against it. Incrementing is a two-transaction flow (mirroring the
 * project-template `increment_count` reference):
 *   1. a sender publishes the increment note (built from `increment-note.masp`),
 *   2. the counter consumes that note, which runs `increment_count` on itself.
 * Both transactions are submitted by the local in-browser client. The sender
 * and counter need fee funding; BasicWallet lets the counter receive it.
 */
export function useIncrementCounter(counterAddress: string) {
  const [error, setError] = useState<string | null>(null);
  // Non-null while an increment is in flight; also drives the button label.
  const [status, setStatus] = useState<string | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const inFlight = useRef(false);
  const { runExclusive, isReady } = useMiden();
  const client = useMidenClient();
  const { createWallet } = useCreateWallet();
  const { consume } = useConsume();
  const { execute } = useTransaction();
  const { waitForCommit } = useWaitForCommit();

  // Fetch the on-chain counter value: import the public counter on first call,
  // sync, and read its storage map. All WASM calls are serialized via
  // runExclusive to avoid "recursive use of an object" errors.
  const loadCount = useCallback(async (): Promise<number | null> => {
    if (!isReady || !counterAddress) return null;
    return await runExclusive(async () => {
      const counterId = parseAccountId(counterAddress);
      if (!(await client.getAccount(counterId))) {
        await client.importAccountById(counterId);
      }
      await client.syncState();
      const account = await client.getAccount(counterId);
      if (!account) {
        setCount(null);
        setError(
          `Counter account not found on-chain (${counterAddress}). Check VITE_MIDEN_COUNTER_ADDRESS / src/config.ts and confirm the counter is deployed on the configured network.`,
        );
        return null;
      }
      const newCount = readCount(account);
      setCount(newCount);
      setError(null);
      return newCount;
    });
  }, [isReady, client, runExclusive, counterAddress]);

  useEffect(() => {
    loadCount().catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [loadCount]);

  const increment = useCallback(async () => {
    if (!isReady || !counterAddress || inFlight.current) return;
    inFlight.current = true;
    setStatus("Preparing increment...");
    setError(null);
    try {
      // SDK mutation hooks own their locks: never call them inside runExclusive.
      // useWaitForCommit doesn't lock internally in this SDK; serialize it here.
      const committed = (txId: string) => runExclusive(() => waitForCommit(txId, pollOptions));
      const readSetting = (key: string) => runExclusive(async () => {
        const bytes = await client.getSetting(key) as number[] | undefined;
        return bytes ? new TextDecoder().decode(Uint8Array.from(bytes)) : undefined;
      });
      const writeSetting = (key: string, value: string) => runExclusive(() =>
        client.setSetting(key, Array.from(new TextEncoder().encode(value))));
      // Keep this key to recover senders funded by earlier versions of the example.
      let senderId = await readSetting("counter:sender:rc7");
      if (!senderId || !await runExclusive(() => client.getAccount(parseAccountId(senderId!)))) {
        // Explicit numeric Falcon discriminant avoids the SDK's invalid default.
        const sender = await createWallet({ storageMode: "private", authScheme: 2 });
        senderId = sender.id().toString();
        await writeSetting("counter:sender:rc7", senderId);
      }

      await runExclusive(() => client.importAccountById(parseAccountId(counterAddress)));
      await fundAccounts([
        { id: senderId, label: "sender" },
        { id: counterAddress, label: "counter" },
      ], { client, runExclusive, consume, waitForCommit, onStatus: setStatus });

      const response = await fetch(INCREMENT_NOTE_PACKAGE_URL);
      if (!response.ok) throw new Error(`Cannot load increment note: HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const { request, noteId } = await runExclusive(async () => {
        const pkg = Package.deserialize(bytes);
        const noteScript = NoteScript.fromPackage(pkg);
        const recipient = new NoteRecipient(
          randomWord(),
          noteScript,
          new NoteStorage(new FeltArray()),
        );
        const metadata = new NoteMetadata(
          parseAccountId(senderId),
          NoteType.Public,
          new NoteTag(0),
        );
        const note = new Note(new NoteAssets(), metadata, recipient);
        // Capture the note id BEFORE `note` is moved into the publish request:
        // wasm-bindgen takes ownership of value-class args (here `new NoteArray([note])`),
        // zeroing the JS handle, so the object can't be reused afterwards.
        const noteId = note.id().toString();
        const request = (await client.feeAwareTransactionRequestBuilder(parseAccountId(senderId)))
          .withOwnOutputNotes(new NoteArray([note])).build();
        return { request, noteId };
      });
      setStatus("Publishing increment note...");
      const published = await execute({ accountId: senderId, request });
      await committed(published.transactionId);

      // Re-import registers the updated public counter in this client's SMT forest.
      await runExclusive(() => client.importAccountById(parseAccountId(counterAddress)));
      setStatus("Waiting for increment note...");
      const deadline = Date.now() + pollOptions.timeoutMs;
      let found = false;
      while (!found && Date.now() < deadline) {
        found = await runExclusive(async () => {
          await client.syncState();
          // A fresh AccountId is required because getConsumableNotes moves it.
          const notes = await client.getConsumableNotes(parseAccountId(counterAddress));
          return notes.some((note) => note.inputNoteRecord().toNote().id().toString() === noteId);
        });
        if (!found) await sleep();
      }
      if (!found) throw new Error("Increment note did not become consumable in time. Refresh and try again.");
      setStatus("Incrementing (consuming note)...");
      const consumed = await consume({ accountId: counterAddress, notes: [noteId] });
      setStatus("Confirming new count...");
      await committed(consumed.transactionId);
      await loadCount();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.current = false;
      setStatus(null);
    }
  }, [isReady, counterAddress, client, runExclusive, createWallet, consume, execute, waitForCommit, loadCount]);

  return {
    increment,
    count,
    isSubmitting: status !== null,
    status,
    error,
    explorerUrl: `${EXPLORER_BASE_URL}/account/${counterAddress}`,
  };
}
