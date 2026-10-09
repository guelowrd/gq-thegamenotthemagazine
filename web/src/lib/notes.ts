// Host-side view of the challenge mechanic's note storage (masm/challenge/challenge_core.masm) and the note
// argument. Mirrors integration/src/storage.rs. All felts are bigint.

import { type City, ROUNDS } from "./rules";
import type { Word4 } from "./quiz";

/** One tag for every GQ note on chain; clients sync it and filter by script root. */
export const GQ_TAG = 0x47510001;
export const NUM_STORAGE_ITEMS = 16 + 8 + 4 * ROUNDS;
export const SHOT_DEADLINE_INDEX = 7;

/** An account id as the two felts the scripts compare: [suffix, prefix]. */
export type AccountFelts = { suffix: bigint; prefix: bigint };

export type ChallengeStorage = {
  expiryBlock: number;
  target: number;
  minStake: bigint;
  champion: AccountFelts;
  /** zero in a record note */
  rival: AccountFelts | null;
  /** zero in a record note */
  recordId: Word4;
  shotRoot: Word4;
  seed: Word4;
  dataset: Word4;
  cities: City[];
  /** block by which the rival must settle; 0 in a record note. Settleable before min(this, expiryBlock). */
  shotDeadline: number;
};

export const ZERO_WORD: Word4 = [0n, 0n, 0n, 0n];

export function encodeStorage(s: ChallengeStorage): bigint[] {
  if (s.cities.length !== ROUNDS) throw new Error(`expected ${ROUNDS} cities`);
  const rival = s.rival ?? { suffix: 0n, prefix: 0n };
  const felts = [
    s.champion.suffix,
    s.champion.prefix,
    BigInt(s.target),
    s.minStake,
    BigInt(s.expiryBlock),
    rival.suffix,
    rival.prefix,
    BigInt(s.shotDeadline),
    ...s.recordId,
    ...s.shotRoot,
    ...s.seed,
    ...s.dataset,
    ...s.cities.flatMap((c) => [c.idx, c.lat, c.lon, c.cos].map(BigInt)),
  ];
  if (felts.length !== NUM_STORAGE_ITEMS) throw new Error("bad storage length");
  return felts;
}

export function decodeStorage(felts: bigint[]): ChallengeStorage {
  if (felts.length !== NUM_STORAGE_ITEMS) throw new Error(`expected ${NUM_STORAGE_ITEMS} felts, got ${felts.length}`);
  const word = (at: number): Word4 => [felts[at], felts[at + 1], felts[at + 2], felts[at + 3]];
  const rival = { suffix: felts[5], prefix: felts[6] };
  const cities: City[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    const b = 24 + 4 * i;
    cities.push({ idx: Number(felts[b]), lat: Number(felts[b + 1]), lon: Number(felts[b + 2]), cos: Number(felts[b + 3]) });
  }
  return {
    champion: { suffix: felts[0], prefix: felts[1] },
    target: Number(felts[2]),
    minStake: felts[3],
    expiryBlock: Number(felts[4]),
    rival: rival.suffix === 0n && rival.prefix === 0n ? null : rival,
    recordId: word(8),
    shotRoot: word(12),
    seed: word(16),
    dataset: word(20),
    cities,
    shotDeadline: Number(felts[SHOT_DEADLINE_INDEX]),
  };
}

/** The block a shot stops being settleable (and the champion may collect). */
export const shotDeadline = (s: ChallengeStorage) => Math.min(s.shotDeadline, s.expiryBlock);

/** The shot note's storage for `rival` at the record note `recordId`, settleable until `deadline`. */
export function shotStorage(record: ChallengeStorage, rival: AccountFelts, recordId: Word4, deadline: number): ChallengeStorage {
  return { ...record, rival, recordId, shotDeadline: deadline };
}

/** True when `shot` is a well-formed shot at `record` (same quiz, same terms). */
export function isShotAt(shot: ChallengeStorage, record: ChallengeStorage, recordId: Word4): boolean {
  if (!shot.rival) return false;
  const expected = encodeStorage(shotStorage(record, shot.rival, recordId, shot.shotDeadline));
  const actual = encodeStorage(shot);
  return expected.every((f, i) => f === actual[i]);
}
