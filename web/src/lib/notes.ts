// Host-side view of the challenge note storage (masm/challenge/challenge_core.masm) and the note
// argument. Mirrors integration/src/storage.rs. All felts are bigint.

import { packAnswers, type Answer, type City, ROUNDS } from "./rules";
import type { Word4 } from "./quiz";

/** One tag for every GQ note on chain; clients sync it and filter by script root. */
export const GQ_TAG = 0x47510001;
export const NUM_STORAGE_ITEMS = 40;
export const CHALLENGE_DEADLINE_INDEX = 7;

/** An account id as the two felts the scripts compare: [suffix, prefix]. */
export type AccountFelts = { suffix: bigint; prefix: bigint };

export type ChallengeStorage = {
  expiryBlock: number;
  target: number;
  minStake: bigint;
  champion: AccountFelts;
  /** zero in a prize note */
  player: AccountFelts | null;
  /** zero in a prize note */
  prizeId: Word4;
  challengeRoot: Word4;
  seed: Word4;
  dataset: Word4;
  cities: City[];
  /** block by which the player must settle; 0 in a prize note. Settleable before min(this, expiryBlock). */
  challengeDeadline: number;
};

export const ZERO_WORD: Word4 = [0n, 0n, 0n, 0n];

export function encodeStorage(s: ChallengeStorage): bigint[] {
  if (s.cities.length !== ROUNDS) throw new Error(`expected ${ROUNDS} cities`);
  const player = s.player ?? { suffix: 0n, prefix: 0n };
  const felts = [
    s.champion.suffix,
    s.champion.prefix,
    BigInt(s.target),
    s.minStake,
    BigInt(s.expiryBlock),
    player.suffix,
    player.prefix,
    BigInt(s.challengeDeadline),
    ...s.prizeId,
    ...s.challengeRoot,
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
  const player = { suffix: felts[5], prefix: felts[6] };
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
    player: player.suffix === 0n && player.prefix === 0n ? null : player,
    prizeId: word(8),
    challengeRoot: word(12),
    seed: word(16),
    dataset: word(20),
    cities,
    challengeDeadline: Number(felts[CHALLENGE_DEADLINE_INDEX]),
  };
}

/** The block a challenge stops being settleable (and the champion may collect). */
export const challengeDeadline = (s: ChallengeStorage) => Math.min(s.challengeDeadline, s.expiryBlock);

/** The challenge note's storage for `player` against the prize note `prizeId`, settleable until `deadline`. */
export function challengeStorage(prize: ChallengeStorage, player: AccountFelts, prizeId: Word4, deadline: number): ChallengeStorage {
  return { ...prize, player, prizeId, challengeDeadline: deadline };
}

/** True when `challenge` is a well-formed challenge of `prize` (same quiz, same terms). */
export function isChallengeOf(challenge: ChallengeStorage, prize: ChallengeStorage, prizeId: Word4): boolean {
  if (!challenge.player) return false;
  const expected = encodeStorage(challengeStorage(prize, challenge.player, prizeId, challenge.challengeDeadline));
  const actual = encodeStorage(challenge);
  return expected.every((f, i) => f === actual[i]);
}

/** The note argument for settling or claiming: four packed rounds. */
export function answerWord(answers: Answer[]): Word4 {
  return packAnswers(answers) as Word4;
}
