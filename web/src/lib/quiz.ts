// Deterministic quiz selection from a seed, and the dataset identity.
// Mirrored by integration/src/quiz.rs and checked against rules/quiz_vectors.json.

import { cosX100, latToCd, lonToCd, ROUNDS, type City } from "./rules";
import type { Word4 } from "./notes";

export type { Word4 };
export type Place = { name: string; country: string; lat: number; lon: number };

/** GeoQuizz's game data in a note: seed, dataset hash, then [idx, lat, lon, cos] per city (48 felts). */
export type GqGame = { seed: Word4; dataset: Word4; cities: City[] };
const GAME_ITEMS = 8 + 4 * ROUNDS;

export function encodeGame(g: GqGame): bigint[] {
  if (g.cities.length !== ROUNDS) throw new Error(`expected ${ROUNDS} cities`);
  return [...g.seed, ...g.dataset, ...g.cities.flatMap((c) => [c.idx, c.lat, c.lon, c.cos].map(BigInt))];
}

export function decodeGame(felts: bigint[]): GqGame {
  if (felts.length !== GAME_ITEMS) throw new Error(`not GeoQuizz game data (${felts.length} felts)`);
  const word = (at: number): Word4 => [felts[at], felts[at + 1], felts[at + 2], felts[at + 3]];
  const cities: City[] = [];
  for (let b = 8; b < GAME_ITEMS; b += 4) cities.push({ idx: Number(felts[b]), lat: Number(felts[b + 1]), lon: Number(felts[b + 2]), cos: Number(felts[b + 3]) });
  return { seed: word(0), dataset: word(4), cities };
}

/** A seed's byte form: its four field elements as u64 little-endian. */
export function seedBytes(seed: Word4): Uint8Array {
  const out = new Uint8Array(32);
  const view = new DataView(out.buffer);
  seed.forEach((f, i) => view.setBigUint64(i * 8, f, true));
  return out;
}

export function randomSeed(): Word4 {
  const r = crypto.getRandomValues(new Uint8Array(32));
  const view = new DataView(r.buffer);
  // keep every element below 2^63 so it is a valid field element
  return [0, 1, 2, 3].map((i) => view.getBigUint64(i * 8, true) >> 1n) as Word4;
}

/**
 * Picks ROUNDS distinct dataset indices: for counter = 0, 1, ..., take
 * `sha256(seedBytes || counter as u32 BE)`, read the first 4 bytes as u32 BE, mod the dataset size,
 * skipping repeats.
 */
export async function pickIndices(seed: Word4, datasetSize: number): Promise<number[]> {
  const picked: number[] = [];
  const bytes = seedBytes(seed);
  for (let counter = 0; picked.length < ROUNDS; counter++) {
    const input = new Uint8Array(36);
    input.set(bytes);
    new DataView(input.buffer).setUint32(32, counter, false);
    const digest = new DataView(await crypto.subtle.digest("SHA-256", input));
    const idx = digest.getUint32(0, false) % datasetSize;
    if (!picked.includes(idx)) picked.push(idx);
  }
  return picked;
}

/** The cities a seed selects, as the note stores them. */
export async function quizCities(seed: Word4, dataset: Place[]): Promise<City[]> {
  const idxs = await pickIndices(seed, dataset.length);
  return idxs.map((idx) => {
    const p = dataset[idx];
    return { idx, lat: latToCd(p.lat), lon: lonToCd(p.lon), cos: cosX100(p.lat) };
  });
}

/** Dataset identity: sha256 of the exact file bytes, first 16 bytes as four u32 little-endian. */
export async function datasetWord(fileBytes: Uint8Array): Promise<Word4> {
  const digest = new DataView(await crypto.subtle.digest("SHA-256", fileBytes));
  return [0, 1, 2, 3].map((i) => BigInt(digest.getUint32(i * 4, true))) as Word4;
}
