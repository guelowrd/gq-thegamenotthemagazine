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
import { MAINNET, MIDEN_RPC_URL, RECORD_SCRIPT_URL, SALE_SCRIPT_URL, SHOT_SCRIPT_URL } from "@/config";
import { decodeStorage, NOTE_TAG, type AccountFelts, type ChallengeStorage } from "./notes";
import { acceptNote, noteKind } from "./flow";
import type { Word4 } from "./quiz";

/** The app's local wasm client, as `useMidenClient()` returns it. */
export type Client = ReturnType<typeof useMidenClient>;

export type Scripts = {
  record: NoteScript;
  shot: NoteScript;
  sale: NoteScript;
  recordRoot: string;
  shotRoot: string;
  saleRoot: string;
};

let scriptsPromise: Promise<Scripts> | undefined;
/** The note scripts, assembled by `cargo run --bin build_scripts`. */
export function loadScripts(): Promise<Scripts> {
  scriptsPromise ??= (async () => {
    const [p, c, s] = await Promise.all(
      [RECORD_SCRIPT_URL, SHOT_SCRIPT_URL, SALE_SCRIPT_URL].map(async (url) => {
        const buf = await fetch(url).then((r) => {
          if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
          return r.arrayBuffer();
        });
        return NoteScript.deserialize(new Uint8Array(buf));
      }),
    );
    return { record: p, shot: c, sale: s, recordRoot: p.root().toHex(), shotRoot: c.root().toHex(), saleRoot: s.root().toHex() };
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
  /** the asset it holds (config.ts GC_FAUCET): shots at a record stake the same one */
  faucet: string;
  amount: bigint;
  consumed: boolean;
  /** the block it was consumed in */
  consumedAt?: number;
  /** the block it was included in */
  createdAt?: number;
  nullifier?: string;
};

/** A record or shot of ours as the node serves it; null for a foreign root or layout, or a note not shaped as this app writes them (flow.ts acceptNote). */
function decodeNote(input: InputNote, scripts: Scripts): Pick<ChallengeNote, "kind" | "storage" | "faucet" | "amount"> | null {
  const note = input.note();
  const known = noteKind(note.recipient().script().root().toHex(), scripts);
  if (!known) return null;
  const { kind } = known;
  let storage: ChallengeStorage;
  try {
    storage = decodeStorage(note.recipient().storage().items().map((x) => x.asInt()));
  } catch {
    return null;
  }
  const assets = note.assets().fungibleAssets().map((a) => ({ faucet: a.faucetId().toString(), amount: a.amount() }));
  const shotRoot = known.kind === "record" ? wordFromHex(known.shotRoot) : undefined;
  if (!acceptNote({ kind, storage, sender: accountFelts(note.metadata().sender()), assets }, shotRoot)) return null;
  return { kind, storage, ...assets[0] };
}

/** Registers the app's note tag (idempotent) and syncs. */
export async function syncNotes(client: Client): Promise<number> {
  const tags = await client.listTags();
  if (!tags.includes(String(NOTE_TAG))) await client.addTag(String(NOTE_TAG));
  const summary = await client.syncState();
  return summary.blockNum();
}

/** A decoded note as `tagScanner` keeps it: when it was posted and whether (and since when) it is used. */
export type Scanned<T> = T & { createdAt?: number; consumed: boolean; consumedAt?: number; nullifier: string };

/**
 * Reads the public notes under `tag` straight from the node, not from the local store: its first sync
 * runs before the app adds a tag, so it only ever holds the notes posted after this browser first
 * opened the game. Each call looks at the blocks since the last one; a note never changes, only
 * whether it is used, and `decode` (null = not ours) runs once per note.
 * ponytail: one nullifier request per unused note per call; fine for tens, batch them for hundreds.
 */
export function tagScanner<T extends { id: string }>(tag: number) {
  const seen = new Map<string, Scanned<T>>();
  // the node answers the whole chain in one request
  let scannedTo = -1;
  return async (tip: number, decode: (input: InputNote, id: string) => T | null): Promise<Scanned<T>[]> => {
    const rpc = new RpcClient(endpoint());
    try {
      const ids: NoteId[] = [];
      while (scannedTo < tip) {
        const info = await rpc.syncNotes(scannedTo + 1, tip, [new NoteTag(tag)]);
        for (const block of info.blocks()) for (const n of block.notes()) ids.push(n.noteId());
        if (info.blockTo() <= scannedTo) break;
        scannedTo = info.blockTo();
      }
      for (let i = 0; i < ids.length; i += 50) {
        for (const f of await rpc.getNotesById(ids.slice(i, i + 50))) {
          const input = f.asInputNote();
          const decoded = input && decode(input, f.noteId.toString());
          if (!input || !decoded) continue;
          seen.set(decoded.id, { ...decoded, createdAt: input.location()?.blockNum(), consumed: false, nullifier: input.note().nullifier().toHex() });
        }
      }
      // which are used now, and since when
      for (const n of seen.values()) {
        if (n.consumed) continue;
        const at = await rpc.getNullifierCommitHeight(Word.fromHex(n.nullifier), n.createdAt ?? 0).catch(() => undefined);
        if (at !== undefined) seen.set(n.id, { ...n, consumed: true, consumedAt: at });
      }
    } finally {
      rpc.free();
    }
    return [...seen.values()];
  };
}

const scanGame = tagScanner<Pick<ChallengeNote, "id" | "idWord" | "kind" | "storage" | "faucet" | "amount">>(NOTE_TAG);
let scanning: Promise<ChallengeNote[]> | null = null;

/** Every record and shot note, newest first, read from the node (the game's notes are public, under its tag). */
export function listChallengeNotes(tip: number): Promise<ChallengeNote[]> {
  return (scanning ??= (async () => {
    const scripts = await loadScripts();
    const notes = await scanGame(tip, (input, id) => {
      const decoded = decodeNote(input, scripts);
      return decoded && { id, idWord: wordFromHex(id), ...decoded };
    });
    return notes.sort((a, b) => (b.createdAt ?? Infinity) - (a.createdAt ?? Infinity));
  })().finally(() => (scanning = null)));
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

/** An account id's canonical hex. */
export const hexOf = (a: AccountFelts) => AccountId.fromPrefixSuffix(new Felt(a.prefix), new Felt(a.suffix)).toString();

/** An account's address as wallets show it (Bread adds a `_…` routing part after it). */
export const bech32Of = (a: AccountFelts) =>
  AccountId.fromPrefixSuffix(new Felt(a.prefix), new Felt(a.suffix)).toBech32(MAINNET ? NetworkId.mainnet() : NetworkId.testnet(), AccountInterface.BasicWallet);

/** A public note as the node holds it, with the block its nullifier was committed in (the note fetch alone returns used notes too). */
async function nodeNote(id: string): Promise<{ input: InputNote; consumedAt?: number }> {
  const { inputs } = await fetchNotesWithProof([id]);
  const rpc = new RpcClient(endpoint());
  try {
    const at = await rpc.getNullifierCommitHeight(inputs[0].note().nullifier(), inputs[0].location()?.blockNum() ?? 0);
    return { input: inputs[0], consumedAt: at ?? undefined };
  } finally {
    rpc.free();
  }
}

/** What the node says about a note (any note: a sale note too): undefined while it is not on chain, else whether it is used. */
export async function knownNote(id: string): Promise<{ consumed: boolean } | undefined> {
  const n = await nodeNote(id).catch(() => undefined);
  return n && { consumed: n.consumedAt !== undefined };
}

/** Builds a record or shot note exactly as the contracts expect it; `serial` fixes its id. */
export function buildChallengeNote(sender: AccountId, script: NoteScript, storageFelts: bigint[], faucet: string, amount: bigint, serial: Word4): Note {
  const recipient = new NoteRecipient(wordFromFelts(serial), script, new NoteStorage(feltArray(storageFelts)));
  const metadata = new NoteMetadata(sender, NoteType.Public, new NoteTag(NOTE_TAG));
  const assets = new NoteAssets([new FungibleAsset(AccountId.fromHex(faucet), amount)]);
  return new Note(assets, metadata, recipient);
}

export const endpoint = (): Endpoint => (MAINNET ? new Endpoint(MIDEN_RPC_URL) : Endpoint.testnet());

/** The node's latest block. */
export async function tip(): Promise<number> {
  const rpc = new RpcClient(endpoint());
  try {
    return (await rpc.getBlockHeaderByNumber(undefined)).blockNum();
  } finally {
    rpc.free();
  }
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

/** Loads one record or shot straight from the node by id (no tag sync needed), e.g. from a shared link. */
export async function fetchChallengeNote(id: string): Promise<ChallengeNote> {
  const [scripts, { input, consumedAt }] = await Promise.all([loadScripts(), nodeNote(id)]);
  const decoded = decodeNote(input, scripts);
  if (!decoded) throw new Error("This note is not a record or shot of this game.");
  return { id, idWord: wordFromHex(id), ...decoded, consumed: consumedAt !== undefined, consumedAt };
}
