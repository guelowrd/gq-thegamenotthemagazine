// Building transactions for Bread to sign. Bread accounts are guarded multisigs; a request for one
// must carry the multisig auth args (bound block, salt, fee conversion info) and declare the bound
// block. The SDK's fee-aware builder only does that for accounts in the dApp's own store, which a
// private Bread account never is, so the words are rebuilt here (mirror of
// integration/src/auth_args.rs; both pinned by rules/auth_vectors.json in the tests).

import {
  AccountId,
  AdviceMap,
  Note,
  NoteArray,
  NoteRecipient,
  NoteType,
  Poseidon2,
  TransactionRequestBuilder,
  Word,
  type TransactionRequest,
} from "@miden-sdk/miden-sdk";
import { Transaction } from "@miden-sdk/miden-wallet-adapter-base";
import type { useMidenFiWallet } from "@miden-sdk/miden-wallet-adapter-react";
import { buildChallengeNote, fetchNotesWithProof, feltArray, loadScripts, parseAccountId, syncNotes, tip, wordFromFelts, type Client, type ChallengeNote } from "./chain";
import { SHOT_WINDOW_BLOCKS, GC_DECIMALS, GC_FAUCET, NETWORK_POLL_INTERVAL_MS, NETWORK_POLL_TIMEOUT_MS } from "@/config";
import { encodeStorage, SHOT_DEADLINE_INDEX, shotStorage, ZERO_WORD, type AccountFelts, type ChallengeStorage, type GameAnswer } from "./notes";
import { randomSeed, type Word4 } from "./quiz";
import { submitWithRetry, withTimeout } from "./flow";
import { payFor, type Sale } from "./shop";

/** What the app needs from a signer: Bread's adapter hook, or the local test wallet. */
export type Wallet = Pick<ReturnType<typeof useMidenFiWallet>, "address" | "requestTransaction" | "requestAssets"> & { local?: boolean };

/** The 12 felts a multisig account reads from its auth args (miden-standards `MultisigAuthArgs`), and their commitment. */
export function multisigAuthArgs(boundBlock: number, salt: Word4, feeFaucet: AccountId): { elements: bigint[]; commitment: Word } {
  const elements = [
    BigInt(boundBlock),
    0n, // no approval expiration
    0n,
    0n,
    ...salt,
    feeFaucet.suffix().asInt(),
    feeFaucet.prefix().asInt(),
    1n, // one-to-one fee conversion
    1n,
  ];
  return { elements, commitment: Poseidon2.hashElements(feltArray(elements)) };
}

/** A request builder carrying the auth args Bread's multisig needs, bound to `boundBlock`. */
function breadBuilder(boundBlock: number, feeFaucet: AccountId): TransactionRequestBuilder {
  const { elements, commitment } = multisigAuthArgs(boundBlock, randomSeed(), feeFaucet);
  const advice = new AdviceMap();
  advice.insert(commitment, feltArray(elements));
  return new TransactionRequestBuilder().withAuthArg(commitment).extendAdviceMap(advice).withBlockNumbers([boundBlock]);
}

type Assets = Awaited<ReturnType<NonNullable<Wallet["requestAssets"]>>>;

/** The wallet's own view of what it holds. */
async function walletAssets(wallet: Wallet): Promise<Assets> {
  if (!wallet.requestAssets) throw new Error("Bread is not connected");
  return withTimeout(wallet.requestAssets(), 30_000, "Reading your wallet's balance");
}

function balanceOf(assets: Assets, faucet: string): bigint {
  const id = AccountId.fromHex(faucet).toString();
  return assets.filter((a) => parseAccountId(a.faucetId).toString() === id).reduce((sum, a) => sum + BigInt(a.amount), 0n);
}

/** The wallet's own view of its Gamecoin balance. */
export async function gcBalance(wallet: Wallet): Promise<bigint> {
  return balanceOf(await walletAssets(wallet), GC_FAUCET);
}

/**
 * Polls the local client until `check` holds or the network timeout passes. A sync that fails on a
 * slow or busy network is just a missed look: the next one tries again.
 */
export async function waitFor(client: Client, runExclusive: <T>(fn: () => Promise<T>) => Promise<T>, check: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + NETWORK_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await runExclusive(() => syncNotes(client));
      if (await runExclusive(check)) return true;
    } catch (e) {
      console.warn("[gq] sync failed while waiting, trying again", e);
    }
    await new Promise((r) => setTimeout(r, NETWORK_POLL_INTERVAL_MS));
  }
  return false;
}

/** `gc`: how the wallet's Gamecoin moves once the transaction lands (the shop line follows it instead of asking the wallet again). */
export type Submitted = { txId: string; noteIds: string[]; gc: bigint };

const RETRIES = 3;

/** Progress callback for the UI: which attempt is running. */
let onSubmitAttempt: (attempt: number, total: number) => void = () => {};
export const setSubmitAttemptListener = (fn: typeof onSubmitAttempt) => (onSubmitAttempt = fn);
/** Progress callback for the UI: "prepare" while the request is built, "wallet" once the wallet has it. */
let onSubmitStage: (stage: "prepare" | "wallet") => void = () => {};
export const setSubmitStageListener = (fn: typeof onSubmitStage) => (onSubmitStage = fn);

/**
 * Builds the request from a fresh builder and submits it to Bread. Bread 1.17.2 runs it at its own
 * tip and only refuses a bound block its sync has not reached, so it binds the node's tip: Bread's
 * fresh sync is at least there. When Bread's node was a block behind ours, the next try rebuilds.
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
    // single-signature account in our own store: the SDK's builder does the fee work
    const builder = await client.feeAwareTransactionRequestBuilder(AccountId.fromHex(address));
    const tx = Transaction.createCustomTransaction(address, address, await build(builder), inputNoteIds, importNotes);
    onSubmitStage("wallet");
    return requestTransaction(tx);
  }
  const feeFaucet = await client.feeFaucetId();
  return submitWithRetry(async (attempt) => {
    onSubmitAttempt(attempt, RETRIES);
    onSubmitStage("prepare");
    const tx = Transaction.createCustomTransaction(address, address, await build(breadBuilder(await tip(), feeFaucet)), inputNoteIds, importNotes);
    onSubmitStage("wallet");
    return requestTransaction(tx);
  }, RETRIES);
}

/** Champion: post a record note. `storage.shotRoot` is filled from the loaded script. */
export async function postRecord(client: Client, wallet: Wallet, storage: ChallengeStorage, amount: bigint): Promise<Submitted> {
  const { record, shot } = await loadScripts();
  const root = shot.root().toFelts().map((f) => f.asInt()) as Word4;
  const felts = encodeStorage({ ...storage, shotRoot: root });
  const serial = randomSeed();
  // WASM objects are consumed by the builder, so every attempt builds its own note (same serial,
  // hence the same note id)
  const make = () => buildChallengeNote(parseAccountId(wallet.address!), record, felts, GC_FAUCET, amount, serial);
  const noteId = make().id().toString();
  const txId = await submit(client, wallet, (b) => {
    const notes = new NoteArray();
    notes.push(make());
    return b.withOwnOutputNotes(notes).build();
  });
  return { txId, noteIds: [noteId], gc: -amount };
}

/** Rival: post a shot note at `record`, staking `record.storage.minStake`. */
export async function postShot(client: Client, wallet: Wallet, record: ChallengeNote, me: AccountFelts): Promise<Submitted & { deadline: number }> {
  const { shot } = await loadScripts();
  const deadline = (await client.getSyncHeight()) + SHOT_WINDOW_BLOCKS;
  const storage = shotStorage(record.storage, me, record.idWord, deadline);
  const felts = encodeStorage(storage);
  const serial = randomSeed();
  const make = () => buildChallengeNote(parseAccountId(wallet.address!), shot, felts, record.faucet, record.storage.minStake, serial);
  const noteId = make().id().toString();
  const txId = await submit(client, wallet, (b) => {
    const notes = new NoteArray();
    notes.push(make());
    return b.withOwnOutputNotes(notes).build();
  });
  return { txId, noteIds: [noteId], gc: -record.storage.minStake, deadline };
}

/**
 * Settle the rival's open shots at one record with their answers (same quiz, same answers for
 * all of them); when `record` is given, claim it in the same transaction. The notes travel with
 * their inclusion proofs so Bread needs no prior sync of them.
 */
export async function settle(client: Client, wallet: Wallet, shots: ChallengeNote[], record: ChallengeNote | undefined, answer: GameAnswer): Promise<Submitted> {
  if (shots.length === 0) throw new Error("no shot note to settle");
  const ids = [...(record ? [record.id] : []), ...shots.map((c) => c.id)];
  const { files } = await fetchNotesWithProof(ids);
  const shotRoot = (await loadScripts()).shotRoot;
  // every WASM object below is consumed by the builder: build them inside each attempt
  const build = async (b: TransactionRequestBuilder) => {
    const { inputs } = await fetchNotesWithProof(ids);
    const advice = new AdviceMap();
    // whatever the game reads besides the note argument (GeoQuizz: its ten answers)
    for (const [key, felts] of answer.advice) advice.insert(wordFromFelts(key), feltArray(felts));
    for (const input of inputs) {
      // the record script learns each shot's deadline from the advice map and proves it by commitment
      if (input.note().recipient().script().root().toHex() === shotRoot) {
        const items = input.note().recipient().storage().items();
        advice.insert(Word.fromHex(input.id().toString()), feltArray([items[SHOT_DEADLINE_INDEX].asInt()]));
      }
      b = b.withExplicitInputNote(input, wordFromFelts(answer.arg));
    }
    return b.extendAdviceMap(advice).build();
  };
  const gc = [...(record ? [record] : []), ...shots].reduce((sum, n) => sum + n.amount, 0n);
  return { txId: await submit(client, wallet, build, ids, files), noteIds: ids, gc };
}

/**
 * Champion after expiry: reclaim records and collect lost shots' stakes, all in one transaction. Also the
 * admin's take-back of a sale note: the seller takes it with no amount.
 */
export async function collect(client: Client, wallet: Wallet, notes: Pick<ChallengeNote, "id" | "amount">[]): Promise<Submitted> {
  const ids = notes.map((n) => n.id);
  const { files } = await fetchNotesWithProof(ids);
  const build = async (b: TransactionRequestBuilder) => {
    const { inputs } = await fetchNotesWithProof(ids);
    for (const input of inputs) b = b.withExplicitInputNote(input, wordFromFelts(ZERO_WORD));
    return b.build();
  };
  return { txId: await submit(client, wallet, build, ids, files), noteIds: ids, gc: notes.reduce((sum, n) => sum + n.amount, 0n) };
}

/**
 * Admin: put `gc` Gamecoin (base units) on sale in one public sale note, asking `pricePerGc` base
 * units of `faucet` per whole Gamecoin. Buyers fill it bit by bit (buyGamecoin); each fill pays the
 * admin a P2ID note of `faucet`; the rest stays on sale until it is gone or the admin cancels.
 * The note is the SDK's PSWAP note with GQ's sale script in its place (masm/sale/sale.masm).
 */
export async function openSale(client: Client, wallet: Wallet, gc: bigint, pricePerGc: bigint, faucet: string): Promise<Submitted> {
  const creator = parseAccountId(wallet.address!);
  const asked = (gc * pricePerGc) / 10n ** BigInt(GC_DECIMALS);
  // the SDK draws the serial here: one request, so every attempt makes the same note
  const request = await client.newPswapCreateTransactionRequest(creator, AccountId.fromHex(GC_FAUCET), gc, AccountId.fromHex(faucet), asked, NoteType.Public, NoteType.Public);
  const { sale } = await loadScripts();
  const saleNote = () => {
    const pswap = request.expectedOutputOwnNotes()[0];
    return new Note(pswap.assets(), pswap.metadata(), new NoteRecipient(pswap.recipient().serialNum(), sale, pswap.recipient().storage()));
  };
  const noteId = saleNote().id().toString();
  const txId = await submit(client, wallet, (b) => {
    const notes = new NoteArray();
    notes.push(saleNote());
    return b.withOwnOutputNotes(notes).build();
  });
  return { txId, noteIds: [noteId], gc: -gc };
}

/** Player: buy `gc` Gamecoin (base units) from `sale`, paying its price in the pay asset (shop.ts payFor). */
export async function buyGamecoin(client: Client, wallet: Wallet, sale: Sale, gc: bigint): Promise<Submitted> {
  const pay = payFor(gc, sale);
  const { files } = await fetchNotesWithProof([sale.id]);
  const txId = await submit(
    client,
    wallet,
    async (b) => {
      const { inputs } = await fetchNotesWithProof([sale.id]);
      // note args: [account fill, note fill, 0, 0] (miden-standards PswapNote::create_args)
      return b.withExplicitInputNote(inputs[0], wordFromFelts([pay, 0n, 0n, 0n])).build();
    },
    [sale.id],
    files,
  );
  return { txId, noteIds: [sale.id], gc };
}
