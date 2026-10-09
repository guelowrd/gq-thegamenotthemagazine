// Building transactions for Bread to sign. Bread accounts are guarded multisigs; a request for one
// must carry the multisig auth args (bound block, salt, fee conversion info) and declare the bound
// block. The SDK's fee-aware builder only does that for accounts in the dApp's own store, which a
// private Bread account never is, so the words are rebuilt here (mirror of
// integration/src/auth_args.rs, pinned by rules/auth_vectors.json).

import {
  AccountId,
  AdviceMap,
  Felt,
  NoteAndArgs,
  NoteAndArgsArray,
  NoteArray,
  Poseidon2,
  RpcClient,
  TransactionRequestBuilder,
  Word,
  type TransactionRequest,
} from "@miden-sdk/miden-sdk";
import { Transaction } from "@miden-sdk/miden-wallet-adapter-base";
import type { useMidenFiWallet } from "@miden-sdk/miden-wallet-adapter-react";
import { answerCommitment, buildGqNote, endpoint, fetchNotesWithProof, feltArray, loadScripts, parseAccountId, syncGq, type Client, type GqNote } from "./chain";
import { SHOT_WINDOW_BLOCKS, GC_FAUCET, NETWORK_POLL_INTERVAL_MS, NETWORK_POLL_TIMEOUT_MS } from "@/config";
import { shotStorage, encodeStorage, type AccountFelts, type ChallengeStorage } from "./notes";
import { SHOT_DEADLINE_INDEX } from "./notes";
import { randomSeed, type Word4 } from "./quiz";
import { packAnswers, type Answer } from "./rules";
import { fmtGeocoin, learnBreadOffset, nextDelayIndex, parseAnchorMismatch, SEND_DELAYS_MS, submitWithRetry, withTimeout } from "./flow";
import authVectors from "../../../rules/auth_vectors.json";

/** What the app needs from a signer: Bread's adapter hook, or the local test wallet. */
export type Wallet = Pick<ReturnType<typeof useMidenFiWallet>, "address" | "requestTransaction" | "requestAssets"> & { local?: boolean };

/** The 12 felts a multisig account reads from its auth args (miden-standards `MultisigAuthArgs`). */
export function authArgElements(boundBlock: number, salt: Word4, feeFaucet: { suffix: bigint; prefix: bigint }): bigint[] {
  return [
    BigInt(boundBlock),
    0n, // no approval expiration
    0n,
    0n,
    ...salt,
    feeFaucet.suffix,
    feeFaucet.prefix,
    1n, // one-to-one fee conversion
    1n,
  ];
}

export function multisigAuthArgs(boundBlock: number, salt: Word4, feeFaucet: AccountId): { elements: bigint[]; commitment: Word } {
  const elements = authArgElements(boundBlock, salt, { suffix: feeFaucet.suffix().asInt(), prefix: feeFaucet.prefix().asInt() });
  return { elements, commitment: Poseidon2.hashElements(feltArray(elements)) };
}

/** Development check: the browser-side commitment must equal the Rust reference's. */
export function selfCheckAuthArgs(): boolean {
  return authVectors.every((v) => {
    const salt = v.salt.map(BigInt) as Word4;
    const { commitment } = multisigAuthArgs(v.bound_block, salt, AccountId.fromHex(v.fee_faucet));
    const ok = commitment.toHex() === v.commitment;
    if (!ok) console.error("[gq] multisig auth-arg commitment differs from the Rust reference", commitment.toHex(), v.commitment);
    return ok;
  });
}

/** A request builder carrying the auth args Bread's multisig needs, bound to `boundBlock`. */
function breadBuilder(boundBlock: number, feeFaucet: AccountId): TransactionRequestBuilder {
  const { elements, commitment } = multisigAuthArgs(boundBlock, randomSeed(), feeFaucet);
  const advice = new AdviceMap();
  advice.insert(commitment, feltArray(elements));
  return new TransactionRequestBuilder().withAuthArg(commitment).extendAdviceMap(advice).withBlockNumbers([boundBlock]);
}

/** The commitment of block `n` as the node reports it (null when the node has no such block yet). */
async function blockCommitment(n: number): Promise<string | null> {
  const rpc = new RpcClient(endpoint());
  try {
    return (await rpc.getBlockHeaderByNumber(n)).commitment().toHex();
  } catch {
    return null;
  } finally {
    rpc.free();
  }
}

/** Bread's view of the Geocoin balance; throws a readable error when it is below `needed`. */
export async function requireGc(wallet: Wallet, needed: bigint): Promise<void> {
  if (!wallet.requestAssets) throw new Error("Bread is not connected");
  const assets = await withTimeout(wallet.requestAssets(), 30_000, "Reading your wallet's balance");
  const faucet = AccountId.fromHex(GC_FAUCET).toString();
  const balance = assets
    .filter((a) => parseAccountId(a.faucetId).toString() === faucet)
    .reduce((sum, a) => sum + BigInt(a.amount), 0n);
  if (balance < needed) {
    throw new Error(
      `You need ${fmtGeocoin(needed)} and your wallet holds ${fmtGeocoin(balance)}. Get Geocoins first.`,
    );
  }
}

/** Polls the local client until `check` holds or the network timeout passes. */
/**
 * Polls the local client until `check` holds or the network timeout passes. A sync that fails on a
 * slow or busy network is just a missed look: the next one tries again.
 */
export async function waitFor(client: Client, runExclusive: <T>(fn: () => Promise<T>) => Promise<T>, check: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + NETWORK_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await runExclusive(() => syncGq(client));
      if (await runExclusive(check)) return true;
    } catch (e) {
      console.warn("[gq] sync failed while waiting, trying again", e);
    }
    await new Promise((r) => setTimeout(r, NETWORK_POLL_INTERVAL_MS));
  }
  return false;
}

export type Submitted = { txId: string; noteIds: string[] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits for the node's tip to move and returns the new block and when it was seen. A header call
 * (~60 ms) every 100 ms sees a block within ~0.15 s of its production; testnet makes one every 3 s.
 */
async function nextBlock(): Promise<{ block: number; seenAt: number }> {
  const rpc = new RpcClient(endpoint());
  try {
    const start = (await rpc.getBlockHeaderByNumber(undefined)).blockNum();
    const deadline = Date.now() + 6_000;
    while (Date.now() < deadline) {
      await sleep(100);
      const block = (await rpc.getBlockHeaderByNumber(undefined)).blockNum();
      if (block > start) return { block, seenAt: Date.now() };
    }
    return { block: start, seenAt: Date.now() };
  } finally {
    rpc.free();
  }
}

const ANCHOR_RETRIES = 10;

// The hand-over delay that last worked in this browser (an index into SEND_DELAYS_MS); see flow.ts.
const DELAY_KEY = "gq:bread-send-delay";
let delayIndex = (() => {
  try {
    return (Number(localStorage.getItem(DELAY_KEY)) || 0) % SEND_DELAYS_MS.length;
  } catch {
    return 0;
  }
})();
let delayPending = false;

/** After a Bread request: did its effect show on chain? Sets the hand-over delay for the next one. */
export function reportBreadOutcome(landed: boolean) {
  if (!delayPending) return;
  delayPending = false;
  delayIndex = nextDelayIndex(delayIndex, landed);
  try {
    localStorage.setItem(DELAY_KEY, String(delayIndex));
  } catch {
    /* private window */
  }
}
/** Progress callback for the UI: which attempt is running. */
export let onSubmitAttempt: (attempt: number, total: number) => void = () => {};
export const setSubmitAttemptListener = (fn: typeof onSubmitAttempt) => (onSubmitAttempt = fn);
/** Progress callback for the UI: "prepare" while the request is timed, "wallet" once the wallet has it. */
export let onSubmitStage: (stage: "prepare" | "wallet") => void = () => {};
export const setSubmitStageListener = (fn: typeof onSubmitStage) => (onSubmitStage = fn);

/**
 * Builds the request from a fresh builder and submits it to Bread, retrying on an anchor mismatch.
 *
 * Bread 1.17.1 anchors the request at its own sync height when its queue turns it into a Guardian
 * proposal, after the user approves, and fails it unless that is the bound block. It answers the
 * dApp at approval, so that failure never reaches us (see docs/bread-anchor-mismatch.md): the retry
 * below only covers a mismatch reported before approval. The fix belongs in the wallet.
 */
async function submit(
  client: Client,
  wallet: Wallet,
  build: (builder: TransactionRequestBuilder) => TransactionRequest | Promise<TransactionRequest>,
  inputNoteIds?: string[],
  importNotes?: Uint8Array[],
): Promise<string> {
  if (!wallet.address || !wallet.requestTransaction) throw new Error("Bread is not connected");
  const address = wallet.address;
  const requestTransaction = wallet.requestTransaction;
  if (wallet.local) {
    // single-signature account in our own store: the SDK's builder does the fee work, no anchor dance
    const builder = await client.feeAwareTransactionRequestBuilder(AccountId.fromHex(address));
    const tx = Transaction.createCustomTransaction(address, address, await build(builder), inputNoteIds, importNotes);
    onSubmitStage("wallet");
    return requestTransaction(tx);
  }
  let lastBound = 0;
  const feeFaucet = await client.feeFaucetId();
  const delay = SEND_DELAYS_MS[delayIndex];
  // Bread imports shipped notes (with their proofs) before it syncs, a few seconds more: one block
  // further. Measured 2026-10-09: a claim bound one block ahead and handed over 1 s into the block
  // was anchored one block later still (86603 → 86604).
  const offset = importNotes?.length ? 2 : 1;
  const txId = await submitWithRetry(
    async (shift, attempt) => {
      onSubmitAttempt(attempt, ANCHOR_RETRIES);
      onSubmitStage("prepare");
      const { block, seenAt } = await nextBlock();
      const boundBlock = block + shift;
      lastBound = boundBlock;
      const tx = Transaction.createCustomTransaction(address, address, await build(breadBuilder(boundBlock, feeFaucet)), inputNoteIds, importNotes);
      await sleep(seenAt + delay - Date.now());
      onSubmitStage("wallet");
      return requestTransaction(tx);
    },
    offset,
    ANCHOR_RETRIES,
    async (e) => {
      const parsed = parseAnchorMismatch(e);
      const learned = parsed ? await learnBreadOffset(lastBound, parsed.anchor, blockCommitment) : null;
      console.warn(`[gq] Bread anchored ${learned === null ? "at an unknown block" : `${learned} block(s) from the bound one`}; rebuilding`);
      return learned;
    },
  );
  delayPending = true;
  return txId;
}

/** Champion: post a record note. `storage.shotRoot` is filled from the loaded script. */
export async function postRecord(client: Client, wallet: Wallet, storage: ChallengeStorage, amount: bigint): Promise<Submitted> {
  await requireGc(wallet, amount);
  const { record, shot } = await loadScripts();
  const root = shot.root().toFelts().map((f) => f.asInt()) as Word4;
  const felts = encodeStorage({ ...storage, shotRoot: root });
  const serial = randomSeed();
  // WASM objects are consumed by the builder, so every attempt builds its own note (same serial,
  // hence the same note id)
  const make = () => buildGqNote(parseAccountId(wallet.address!), record, felts, amount, serial);
  const noteId = make().id().toString();
  const txId = await submit(client, wallet, (b) => {
    const notes = new NoteArray();
    notes.push(make());
    return b.withOwnOutputNotes(notes).build();
  });
  return { txId, noteIds: [noteId] };
}

/** Rival: post a shot note at `record`, staking `record.storage.minStake`. */
export async function postShot(client: Client, wallet: Wallet, record: GqNote, me: AccountFelts): Promise<Submitted & { deadline: number }> {
  await requireGc(wallet, record.storage.minStake);
  const { shot } = await loadScripts();
  const deadline = (await client.getSyncHeight()) + SHOT_WINDOW_BLOCKS;
  const storage = shotStorage(record.storage, me, record.idWord, deadline);
  const felts = encodeStorage(storage);
  const serial = randomSeed();
  const make = () => buildGqNote(parseAccountId(wallet.address!), shot, felts, record.storage.minStake, serial);
  const noteId = make().id().toString();
  const txId = await submit(client, wallet, (b) => {
    const notes = new NoteArray();
    notes.push(make());
    return b.withOwnOutputNotes(notes).build();
  });
  return { txId, noteIds: [noteId], deadline };
}

/**
 * Settle the rival's open shots at one record with their answers (same quiz, same answers for
 * all of them); when `record` is given, claim it in the same transaction. The notes travel with
 * their inclusion proofs so Bread needs no prior sync of them.
 */
export async function settle(client: Client, wallet: Wallet, shots: GqNote[], record: GqNote | undefined, answers: Answer[]): Promise<Submitted> {
  if (shots.length === 0) throw new Error("no shot note to settle");
  const ids = [...(record ? [record.id] : []), ...shots.map((c) => c.id)];
  const { files } = await fetchNotesWithProof(ids);
  const { shotRoot } = await loadScripts();
  // every WASM object below is consumed by the builder: build them inside each attempt
  const build = async (b: TransactionRequestBuilder) => {
    const { inputs } = await fetchNotesWithProof(ids);
    const advice = new AdviceMap();
    // the note argument commits to the answers; the scripts read them from the advice map
    advice.insert(answerCommitment(answers), feltArray(packAnswers(answers)));
    for (const input of inputs) {
      // the record script learns each shot's deadline from the advice map and proves it by commitment
      if (input.note().recipient().script().root().toHex() === shotRoot) {
        const items = input.note().recipient().storage().items();
        advice.insert(Word.fromHex(input.id().toString()), feltArray([items[SHOT_DEADLINE_INDEX].asInt()]));
      }
      b = b.withExplicitInputNote(input, answerCommitment(answers));
    }
    return b.extendAdviceMap(advice).build();
  };
  return { txId: await submit(client, wallet, build, ids, files), noteIds: ids };
}

/** Champion after expiry: reclaim a record note or collect a lost shot's stake. */
export async function collect(client: Client, wallet: Wallet, note: GqNote): Promise<Submitted> {
  const { files } = await fetchNotesWithProof([note.id]);
  const build = async (b: TransactionRequestBuilder) => {
    const { inputs } = await fetchNotesWithProof([note.id]);
    return b.withExplicitInputNote(inputs[0], Word.newFromFelts(feltsOf([0n, 0n, 0n, 0n]))).build();
  };
  return { txId: await submit(client, wallet, build, [note.id], files), noteIds: [note.id] };
}

function feltsOf(w: Word4): Felt[] {
  return w.map((v) => new Felt(v));
}

// keep the unused-import linter honest about the types this file relies on
export type { NoteAndArgs, NoteAndArgsArray };
