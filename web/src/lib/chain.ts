// Reading the challenge notes (records and shots) with the app's local Miden client, and loading the
// assembled note scripts. Signing happens in Bread (see bread.ts).

import {
  AccountId,
  AccountInterface,
  Endpoint,
  Felt,
  FeltArray,
  FungibleAsset,
  InputNote,
  Note,
  NoteAssets,
  NoteFile,
  NoteFilter,
  NoteFilterTypes,
  NoteId,
  NoteMetadata,
  NoteRecipient,
  NoteScript,
  NoteStorage,
  NoteTag,
  NoteType,
  NetworkId,
  RpcClient,
  Word,
} from "@miden-sdk/miden-sdk";
import type { useMidenClient } from "@miden-sdk/react";
import { GC_FAUCET, MIDEN_RPC_URL, RECORD_SCRIPT_URL, SHOT_SCRIPT_URL } from "@/config";
import { decodeStorage, NOTE_TAG, type AccountFelts, type ChallengeStorage } from "./notes";
import type { Word4 } from "./quiz";

/** The app's local wasm client, as `useMidenClient()` returns it. */
export type Client = ReturnType<typeof useMidenClient>;

export type Scripts = { record: NoteScript; shot: NoteScript; recordRoot: string; shotRoot: string };

let scriptsPromise: Promise<Scripts> | undefined;
/** The two note scripts, assembled by `cargo run --bin build_scripts`. */
export function loadScripts(): Promise<Scripts> {
  scriptsPromise ??= (async () => {
    const [p, c] = await Promise.all(
      [RECORD_SCRIPT_URL, SHOT_SCRIPT_URL].map(async (url) => {
        const buf = await fetch(url).then((r) => {
          if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
          return r.arrayBuffer();
        });
        return NoteScript.deserialize(new Uint8Array(buf));
      }),
    );
    return { record: p, shot: c, recordRoot: p.root().toHex(), shotRoot: c.root().toHex() };
  })();
  return scriptsPromise;
}

export const wordFromFelts = (w: Word4) => Word.newFromFelts(w.map((v) => new Felt(v)));
export const feltsFromWord = (w: Word): Word4 => w.toFelts().map((f) => f.asInt()) as Word4;
export const wordFromHex = (hex: string): Word4 => feltsFromWord(Word.fromHex(hex));
export function feltArray(values: bigint[]): FeltArray {
  const arr = new FeltArray();
  for (const v of values) arr.push(new Felt(v));
  return arr;
}

export function accountFelts(id: AccountId): AccountFelts {
  return { suffix: id.suffix().asInt(), prefix: id.prefix().asInt() };
}

export function parseAccountId(s: string): AccountId {
  return s.startsWith("0x") ? AccountId.fromHex(s) : AccountId.fromBech32(s);
}

/** A record or shot note, decoded. */
export type ChallengeNote = {
  id: string;
  idWord: Word4;
  kind: "record" | "shot";
  storage: ChallengeStorage;
  amount: bigint;
  consumed: boolean;
  /** the block it was consumed in, when read from the node (fetchChallengeNote, withConsumedAt) */
  consumedAt?: number;
  /** the block it was included in, from the local store */
  createdAt?: number;
  nullifier?: string;
};

/** What a note script root means to this app, or null for a foreign note. */
function kindOf(root: string, { recordRoot, shotRoot }: Scripts): Pick<ChallengeNote, "kind"> | null {
  if (root === recordRoot) return { kind: "record" };
  if (root === shotRoot) return { kind: "shot" };
  return null;
}

/** Registers the app's note tag (idempotent) and syncs. */
export async function syncNotes(client: Client): Promise<number> {
  const tags = await client.listTags();
  if (!tags.includes(String(NOTE_TAG))) await client.addTag(String(NOTE_TAG));
  const summary = await client.syncState();
  return summary.blockNum();
}

/**
 * Every record/shot note the local store knows, newest first. Notes posted by others arrive
 * through the note tag as input notes; notes this client's own account posted exist only as output
 * notes, so both lists are read.
 */
export async function listChallengeNotes(client: Client): Promise<ChallengeNote[]> {
  const scripts = await loadScripts();
  type Located = { inclusionProof(): { location(): { blockNum(): number } } | undefined; nullifier(): string | undefined };
  const toNote = (id: NoteId | undefined, recipient: NoteRecipient | undefined, assets: NoteAssets, consumed: boolean, r: Located): ChallengeNote | null => {
    if (!id || !recipient) return null;
    const kind = kindOf(recipient.script().root().toHex(), scripts);
    if (!kind) return null;
    let storage: ChallengeStorage;
    try {
      storage = decodeStorage(recipient.storage().items().map((f) => f.asInt()));
    } catch {
      return null; // same script, foreign layout
    }
    const gq = assets.fungibleAssets().find((a) => a.faucetId().toString() === GC_FAUCET);
    const createdAt = r.inclusionProof()?.location().blockNum();
    return { id: id.toString(), idWord: wordFromHex(id.toString()), ...kind, storage, amount: gq?.amount() ?? 0n, consumed, createdAt, nullifier: r.nullifier() };
  };
  const seen = new Set<string>();
  const out: ChallengeNote[] = [];
  const add = (n: ChallengeNote | null) => {
    if (!n || seen.has(n.id)) return;
    seen.add(n.id);
    out.push(n);
  };
  for (const r of await client.getInputNotes(new NoteFilter(NoteFilterTypes.All))) {
    const d = r.details();
    add(toNote(r.id(), d.recipient(), d.assets(), r.isConsumed(), r));
  }
  for (const r of await client.getOutputNotes(new NoteFilter(NoteFilterTypes.All))) add(toNote(r.id(), r.recipient(), r.assets(), r.isConsumed(), r));
  return out.reverse();
}

// the block a note was consumed in never changes: asked once per note per page load
const consumedAtCache = new Map<string, number>();

/**
 * Fills `consumedAt` on consumed notes from the node (the store only says whether). A note the node
 * cannot answer for yet stays without one and is asked again next time.
 * ponytail: one request at a time, ~0.1 s per consumed note on the first load; batch them when the
 * game's history grows into the hundreds.
 */
export async function withConsumedAt(notes: ChallengeNote[]): Promise<ChallengeNote[]> {
  const missing = notes.filter((n) => n.consumed && n.nullifier && !consumedAtCache.has(n.id));
  if (missing.length > 0) {
    const rpc = new RpcClient(endpoint());
    try {
      for (const n of missing) {
        const at = await rpc.getNullifierCommitHeight(Word.fromHex(n.nullifier!), n.createdAt ?? 0).catch(() => undefined);
        if (at !== undefined) consumedAtCache.set(n.id, at);
      }
    } finally {
      rpc.free();
    }
  }
  return notes.map((n) => (consumedAtCache.has(n.id) ? { ...n, consumedAt: consumedAtCache.get(n.id) } : n));
}

const blockTimeCache = new Map<number, number>();

/** When block `n` was made, in ms since the epoch. */
export async function blockTime(n: number): Promise<number> {
  const cached = blockTimeCache.get(n);
  if (cached !== undefined) return cached;
  const rpc = new RpcClient(endpoint());
  try {
    const ms = (await rpc.getBlockHeaderByNumber(n)).timestamp() * 1000;
    blockTimeCache.set(n, ms);
    return ms;
  } finally {
    rpc.free();
  }
}

/** An account's address as wallets show it (Bread adds a `_…` routing part after it). */
export const bech32Of = (a: AccountFelts) =>
  AccountId.fromPrefixSuffix(new Felt(a.prefix), new Felt(a.suffix)).toBech32(MIDEN_RPC_URL === "devnet" ? NetworkId.devnet() : NetworkId.testnet(), AccountInterface.BasicWallet);

/** The store's record of a note, whether it came in (input) or went out (output); undefined if unknown. */
export async function knownNote(client: Client, id: string): Promise<{ consumed: boolean } | undefined> {
  const input = await client.getInputNote(id);
  if (input) return { consumed: input.isConsumed() };
  const output = await client.getOutputNote(id).catch(() => undefined);
  return output ? { consumed: output.isConsumed() } : undefined;
}

/** Builds a record or shot note exactly as the contracts expect it; `serial` fixes its id. */
export function buildChallengeNote(sender: AccountId, script: NoteScript, storageFelts: bigint[], amount: bigint, serial: Word4): Note {
  const recipient = new NoteRecipient(wordFromFelts(serial), script, new NoteStorage(feltArray(storageFelts)));
  const metadata = new NoteMetadata(sender, NoteType.Public, new NoteTag(NOTE_TAG));
  const assets = new NoteAssets([new FungibleAsset(AccountId.fromHex(GC_FAUCET), amount)]);
  return new Note(assets, metadata, recipient);
}

export function endpoint(): Endpoint {
  return MIDEN_RPC_URL === "testnet"
    ? Endpoint.testnet()
    : MIDEN_RPC_URL === "devnet"
      ? Endpoint.devnet()
      : MIDEN_RPC_URL === "localhost"
        ? Endpoint.localhost()
        : new Endpoint(MIDEN_RPC_URL);
}

/**
 * Fetches public notes with their inclusion proofs straight from the node, so a wallet that never
 * synced them can still consume them: returns the authenticated input notes and the serialized
 * NoteFiles to hand to Bread as `importNotes`.
 */
export async function fetchNotesWithProof(ids: string[]): Promise<{ inputs: InputNote[]; files: Uint8Array[] }> {
  const rpc = new RpcClient(endpoint());
  try {
    const fetched = await rpc.getNotesById(ids.map((id) => NoteId.fromHex(id)));
    const inputs: InputNote[] = [];
    const files: Uint8Array[] = [];
    for (const f of fetched) {
      const input = f.asInputNote();
      if (!input) throw new Error(`note ${f.noteId.toString()} is not public`);
      inputs.push(input);
      files.push(NoteFile.fromInputNote(input).serialize());
    }
    if (inputs.length !== ids.length) throw new Error("some notes were not found on chain");
    return { inputs, files };
  } finally {
    rpc.free();
  }
}

/**
 * Loads one record or shot straight from the node by id (no tag sync needed), e.g. from a shared link,
 * and asks the node whether its nullifier is already committed (the note fetch alone returns
 * consumed notes too).
 */
export async function fetchChallengeNote(id: string): Promise<ChallengeNote> {
  const scripts = await loadScripts();
  const { inputs } = await fetchNotesWithProof([id]);
  const note = inputs[0].note();
  const kind = kindOf(note.recipient().script().root().toHex(), scripts);
  if (!kind) throw new Error("This note is not a record or shot of this game.");
  const storage = decodeStorage(note.recipient().storage().items().map((f) => f.asInt()));
  const gq = note.assets().fungibleAssets().find((a) => a.faucetId().toString() === GC_FAUCET);
  const rpc = new RpcClient(endpoint());
  let consumedAt: number | undefined;
  try {
    const creationBlock = inputs[0].location()?.blockNum() ?? 0;
    consumedAt = (await rpc.getNullifierCommitHeight(note.nullifier(), creationBlock)) ?? undefined;
  } finally {
    rpc.free();
  }
  return { id, idWord: wordFromHex(id), ...kind, storage, amount: gq?.amount() ?? 0n, consumed: consumedAt !== undefined, consumedAt };
}
