import { describe, expect, it } from "vitest";
import { challengeStorage, decodeStorage, encodeStorage, isChallengeOf, NUM_STORAGE_ITEMS, ZERO_WORD, type ChallengeStorage } from "../notes";

const prize: ChallengeStorage = {
  expiryBlock: 1234,
  target: 2000,
  minStake: 1_000_000n,
  champion: { suffix: 11n, prefix: 22n },
  player: null,
  prizeId: ZERO_WORD,
  challengeRoot: [1n, 2n, 3n, 4n],
  seed: [5n, 6n, 7n, 8n],
  dataset: [9n, 9n, 9n, 9n],
  cities: [
    { idx: 0, lat: 13885, lon: 18235, cos: 66 },
    { idx: 1, lat: 6709, lon: 13683, cos: 92 },
    { idx: 2, lat: 12569, lon: 31969, cos: 81 },
    { idx: 3, lat: 5607, lon: 19842, cos: 83 },
  ],
  challengeDeadline: 0,
};

describe("challenge storage", () => {
  it("encodes 40 felts in the documented layout and round-trips", () => {
    const felts = encodeStorage(prize);
    expect(felts).toHaveLength(NUM_STORAGE_ITEMS);
    expect(felts.slice(0, 8)).toEqual([1n, 1234n, 2000n, 1_000_000n, 11n, 22n, 0n, 0n]);
    expect(felts.slice(24, 28)).toEqual([0n, 13885n, 18235n, 66n]);
    expect(felts.slice(40)).toEqual([0n, 0n, 0n, 0n]);
    expect(decodeStorage(felts)).toEqual(prize);
  });

  it("derives a challenge from a prize and recognises it", () => {
    const prizeId = [100n, 200n, 300n, 400n] as const;
    const challenge = challengeStorage(prize, { suffix: 33n, prefix: 44n }, [...prizeId], 1300);
    expect(encodeStorage(challenge)[40]).toBe(1300n);
    expect(decodeStorage(encodeStorage(challenge))).toEqual(challenge);
    expect(isChallengeOf(challenge, prize, [...prizeId])).toBe(true);
    expect(isChallengeOf({ ...challenge, target: 1999 }, prize, [...prizeId])).toBe(false);
    expect(isChallengeOf(challenge, prize, [0n, 0n, 0n, 1n])).toBe(false);
    expect(isChallengeOf(prize, prize, [...prizeId])).toBe(false);
  });
});
