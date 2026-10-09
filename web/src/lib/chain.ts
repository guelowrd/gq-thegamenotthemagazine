// Reading GQ notes from chain with the app's local (read-only) Miden client, and loading the
// assembled note scripts. Signing happens in Bread (see bread.ts).

import {
  AccountId,
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
  RpcClient,
  Word,
} from "@miden-sdk/miden-sdk";
import type { useMidenClient } from "@miden-sdk/react";
import { CHALLENGE_SCRIPT_URL, GQ_FAUCET, LEGACY_PRIZE_ROOTS, MIDEN_RPC_URL, PRIZE_SCRIPT_URL } from "@/config";
import { decodeStorage, GQ_TAG, type AccountFelts, type ChallengeStorage } from "./notes";
import type { Word4 } from "./quiz";

/** The app's local wasm client, as `useMidenClient()` returns it. */
export type Client = ReturnType<typeof useMidenClient>;

export type Scripts = { prize: NoteScript; challenge: NoteScript; prizeRoot: string; challengeRoot: string };

let scriptsPromise: Promise<Scripts> | undefined;
/** The two note scripts, assembled by `cargo run --bin build_scripts`. */
export function loadScripts(): Promise<Scripts> {
  scriptsPromise ??= (async () => {
    const [p, c] = await Promise.all(
      [PRIZE_SCRIPT_URL, CHALLENGE_SCRIPT_URL].map(async (url) => {
        const buf = await fetch(url).then((r) => {
          if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
          return r.arrayBuffer();
        });
        return NoteScript.deserialize(new Uint8Array(buf));
      }),
    );
    return { prize: p, challenge: c, prizeRoot: p.root().toHex(), challengeRoot: c.root().toHex() };
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

/** A GQ note as the lobby shows it. */
export type GqNote = {
  id: string;
  idWord: Word4;
  kind: "prize" | "challenge";
  storage: ChallengeStorage;
  amount: bigint;
  consumed: boolean;
  /** Posted with a prize script this app has since replaced: collect and reclaim only. */
  legacy?: boolean;
};

/** What a note script root means to this app, or null for a foreign note. */
function kindOf(root: string, { prizeRoot, challengeRoot }: Scripts): Pick<GqNote, "kind" | "legacy"> | null {
  if (root === prizeRoot) return { kind: "prize" };
  if (root === challengeRoot) return { kind: "challenge" };
  if (LEGACY_PRIZE_ROOTS.includes(root)) return { kind: "prize", legacy: true };
  return null;
}

/** Registers the GQ tag (idempotent) and syncs. */
export async function syncGq(client: Client): Promise<number> {
  const tags = await client.listTags();
  if (!tags.includes(String(GQ_TAG))) await client.addTag(String(GQ_TAG));
  const summary = await client.syncState();
  return summary.blockNum();
}

/**
 * Every prize/challenge note the local store knows, newest first. Notes posted by others arrive
 * through the GQ tag as input notes; notes this client's own account posted exist only as output
 * notes, so both lists are read.
 */
export async function listGqNotes(client: Client): Promise<GqNote[]> {
  const scripts = await loadScripts();
  const toGqNote = (id: NoteId | undefined, recipient: NoteRecipient | undefined, assets: NoteAssets, consumed: boolean): GqNote | null => {
    if (!id || !recipient) return null;
    const kind = kindOf(recipient.script().root().toHex(), scripts);
    if (!kind) return null;
    let storage: ChallengeStorage;
    try {
      storage = decodeStorage(recipient.storage().items().map((f) => f.asInt()));
    } catch {
      return null; // same script, foreign layout
    }
    const gq = assets.fungibleAssets().find((a) => a.faucetId().toString() === GQ_FAUCET);
    return { id: id.toString(), idWord: wordFromHex(id.toString()), ...kind, storage, amount: gq?.amount() ?? 0n, consumed };
  };
  const seen = new Set<string>();
  const out: GqNote[] = [];
  const add = (n: GqNote | null) => {
    if (!n || seen.has(n.id)) return;
    seen.add(n.id);
    out.push(n);
  };
  for (const r of await client.getInputNotes(new NoteFilter(NoteFilterTypes.All))) {
    const d = r.details();
    add(toGqNote(r.id(), d.recipient(), d.assets(), r.isConsumed()));
  }
  for (const r of await client.getOutputNotes(new NoteFilter(NoteFilterTypes.All))) add(toGqNote(r.id(), r.recipient(), r.assets(), r.isConsumed()));
  return out.reverse();
}

/** The store's record of a note, whether it came in (input) or went out (output); undefined if unknown. */
export async function knownNote(client: Client, id: string): Promise<{ consumed: boolean } | undefined> {
  const input = await client.getInputNote(id);
  if (input) return { consumed: input.isConsumed() };
  const output = await client.getOutputNote(id).catch(() => undefined);
  return output ? { consumed: output.isConsumed() } : undefined;
}

/** Builds a prize or challenge note exactly as the contracts expect it; `serial` fixes its id. */
export function buildGqNote(sender: AccountId, script: NoteScript, storageFelts: bigint[], amount: bigint, serial: Word4): Note {
  const recipient = new NoteRecipient(wordFromFelts(serial), script, new NoteStorage(feltArray(storageFelts)));
  const metadata = new NoteMetadata(sender, NoteType.Public, new NoteTag(GQ_TAG));
  const assets = new NoteAssets([new FungibleAsset(AccountId.fromHex(GQ_FAUCET), amount)]);
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
 * Loads one GQ note straight from the node by id (no tag sync needed), e.g. from a shared link,
 * and asks the node whether its nullifier is already committed (the note fetch alone returns
 * consumed notes too).
 */
export async function fetchGqNote(id: string): Promise<GqNote> {
  const scripts = await loadScripts();
  const { inputs } = await fetchNotesWithProof([id]);
  const note = inputs[0].note();
  const kind = kindOf(note.recipient().script().root().toHex(), scripts);
  if (!kind) throw new Error("This note is not a GQ prize or challenge.");
  const storage = decodeStorage(note.recipient().storage().items().map((f) => f.asInt()));
  const gq = note.assets().fungibleAssets().find((a) => a.faucetId().toString() === GQ_FAUCET);
  const rpc = new RpcClient(endpoint());
  let consumed = false;
  try {
    const creationBlock = inputs[0].location()?.blockNum() ?? 0;
    consumed = (await rpc.getNullifierCommitHeight(note.nullifier(), creationBlock)) != null;
  } finally {
    rpc.free();
  }
  return { id, idWord: wordFromHex(id), ...kind, storage, amount: gq?.amount() ?? 0n, consumed };
}

/** The shareable link to a prize, and the X post that carries it. */
export function prizeLinks(prizeId: string, score: number) {
  const url = `${location.origin}${location.pathname}?prize=${prizeId}`;
  const text = `I scored ${score} on GQ, a GeoQuiz on @0xMiden. Beat my score and take my prize:`;
  return { url, x: `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}` };
}
