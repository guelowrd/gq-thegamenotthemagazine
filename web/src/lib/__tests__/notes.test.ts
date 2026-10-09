import { describe, expect, it } from "vitest";
import { shotStorage, decodeStorage, encodeStorage, isShotAt, NUM_STORAGE_ITEMS, ZERO_WORD, type ChallengeStorage } from "../notes";

const prize: ChallengeStorage = {
  expiryBlock: 1234,
  target: 2000,
  minStake: 1_000_000n,
  champion: { suffix: 11n, prefix: 22n },
  rival: null,
  recordId: ZERO_WORD,
  shotRoot: [1n, 2n, 3n, 4n],
  seed: [5n, 6n, 7n, 8n],
  dataset: [9n, 9n, 9n, 9n],
  cities: Array.from({ length: 10 }, (_, idx) => ({ idx, lat: 13885 - idx * 100, lon: 18235 + idx * 100, cos: 66 })),
  shotDeadline: 0,
};

describe("challenge storage", () => {
  it("encodes 64 felts in the documented layout and round-trips", () => {
    const felts = encodeStorage(prize);
    expect(felts).toHaveLength(NUM_STORAGE_ITEMS);
    expect(felts.slice(0, 8)).toEqual([11n, 22n, 2000n, 1_000_000n, 1234n, 0n, 0n, 0n]);
    expect(felts.slice(24, 28)).toEqual([0n, 13885n, 18235n, 66n]);
    expect(decodeStorage(felts)).toEqual(prize);
  });

  it("derives a shot from a record and recognises it", () => {
    const recordId = [100n, 200n, 300n, 400n] as const;
    const challenge = shotStorage(prize, { suffix: 33n, prefix: 44n }, [...recordId], 1300);
    expect(encodeStorage(challenge).slice(5, 8)).toEqual([33n, 44n, 1300n]);
    expect(decodeStorage(encodeStorage(challenge))).toEqual(challenge);
    expect(isShotAt(challenge, prize, [...recordId])).toBe(true);
    expect(isShotAt({ ...challenge, target: 1999 }, prize, [...recordId])).toBe(false);
    expect(isShotAt(challenge, prize, [0n, 0n, 0n, 1n])).toBe(false);
    expect(isShotAt(prize, prize, [...recordId])).toBe(false);
  });
});
