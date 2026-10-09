// Reading the challenge notes (records and shots) from the node, and loading the
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
  /** the block it was consumed in */
  consumedAt?: number;
  /** the block it was included in */
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

// every GQ note the node has shown this page, decoded once: a note never changes, only whether it is used
const known = new Map<string, ChallengeNote>();
// the node answers the whole chain in one request (testnet 2026-10-09: 40 notes up to block 94 404)
let scannedTo = -1;
let scanning: Promise<ChallengeNote[]> | null = null;

/**
 * Every record and shot note, newest first, read from the node: the game's notes are public, under
 * its note tag. Not from the local store: its first sync runs before the app adds the tag, so it
 * only ever holds the notes posted after this browser first opened the game.
 * ponytail: one nullifier request per unused note per call; fine for tens, batch them for hundreds.
 */
export function listChallengeNotes(tip: number): Promise<ChallengeNote[]> {
  return (scanning ??= scanNotes(tip).finally(() => (scanning = null)));
}

async function scanNotes(tip: number): Promise<ChallengeNote[]> {
  const scripts = await loadScripts();
  const rpc = new RpcClient(endpoint());
  try {
    // notes posted since the last look
    const ids: NoteId[] = [];
    while (scannedTo < tip) {
      const info = await rpc.syncNotes(scannedTo + 1, tip, [new NoteTag(NOTE_TAG)]);
      for (const block of info.blocks()) for (const n of block.notes()) ids.push(n.noteId());
      if (info.blockTo() <= scannedTo) break;
      scannedTo = info.blockTo();
    }
    for (let i = 0; i < ids.length; i += 50) {
      for (const f of await rpc.getNotesById(ids.slice(i, i + 50))) {
        const input = f.asInputNote();
        const note = input?.note();
        const kind = note && kindOf(note.recipient().script().root().toHex(), scripts);
        if (!input || !note || !kind) continue;
        let storage: ChallengeStorage;
        try {
          storage = decodeStorage(note.recipient().storage().items().map((x) => x.asInt()));
        } catch {
          continue; // same script, foreign layout
        }
        const id = f.noteId.toString();
        const gq = note.assets().fungibleAssets().find((a) => a.faucetId().toString() === GC_FAUCET);
        const createdAt = input.location()?.blockNum();
        known.set(id, { id, idWord: wordFromHex(id), ...kind, storage, amount: gq?.amount() ?? 0n, consumed: false, createdAt, nullifier: note.nullifier().toHex() });
      }
    }
    // which are used now, and since when
    for (const n of known.values()) {
      if (n.consumed) continue;
      const at = await rpc.getNullifierCommitHeight(Word.fromHex(n.nullifier!), n.createdAt ?? 0).catch(() => undefined);
      if (at !== undefined) known.set(n.id, { ...n, consumed: true, consumedAt: at });
    }
  } finally {
    rpc.free();
  }
  return [...known.values()].sort((a, b) => (b.createdAt ?? Infinity) - (a.createdAt ?? Infinity));
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

/** What the node says about a note: undefined while it is not on chain, else whether it is used. */
export async function knownNote(id: string): Promise<{ consumed: boolean } | undefined> {
  return fetchChallengeNote(id).then(
    (n) => ({ consumed: n.consumed }),
    () => undefined,
  );
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
