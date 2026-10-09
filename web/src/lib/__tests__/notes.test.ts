import { describe, expect, it } from "vitest";
import { decodeStorage, encodeStorage, HEADER_ITEMS, isShotAt, shotStorage, ZERO_WORD, type ChallengeStorage } from "../notes";
import { decodeGame, encodeGame } from "../quiz";

const cities = Array.from({ length: 10 }, (_, idx) => ({ idx, lat: 13885 - idx * 100, lon: 18235 + idx * 100, cos: 66 }));
const record: ChallengeStorage = {
  expiryBlock: 1234,
  target: 2000,
  minStake: 1_000_000n,
  champion: { suffix: 11n, prefix: 22n },
  rival: null,
  recordId: ZERO_WORD,
  shotRoot: [1n, 2n, 3n, 4n],
  game: encodeGame({ seed: [5n, 6n, 7n, 8n], dataset: [9n, 9n, 9n, 9n], cities }),
  shotDeadline: 0,
};

describe("challenge storage (any game)", () => {
  it("is a 16-felt header followed by the game's own data, and round-trips", () => {
    const felts = encodeStorage(record);
    expect(felts).toHaveLength(HEADER_ITEMS + 48);
    expect(felts.slice(0, 8)).toEqual([11n, 22n, 2000n, 1_000_000n, 1234n, 0n, 0n, 0n]);
    expect(decodeStorage(felts)).toEqual(record);
    // another game, other data: the header does not care
    const other = { ...record, game: [1n, 2n, 3n, 4n] };
    expect(decodeStorage(encodeStorage(other))).toEqual(other);
    expect(() => encodeStorage({ ...record, game: [1n] })).toThrow(/whole words/);
  });

  it("derives a shot from a record and recognises it", () => {
    const recordId = [100n, 200n, 300n, 400n] as const;
    const shot = shotStorage(record, { suffix: 33n, prefix: 44n }, [...recordId], 1300);
    expect(encodeStorage(shot).slice(5, 8)).toEqual([33n, 44n, 1300n]);
    expect(isShotAt(shot, record, [...recordId])).toBe(true);
    expect(isShotAt({ ...shot, target: 1999 }, record, [...recordId])).toBe(false);
    expect(isShotAt(shot, record, [0n, 0n, 0n, 1n])).toBe(false);
    expect(isShotAt(record, record, [...recordId])).toBe(false);
  });
});

describe("GeoQuizz game data", () => {
  it("is seed, dataset, then [idx, lat, lon, cos] per city, and round-trips", () => {
    const g = { seed: [5n, 6n, 7n, 8n] as [bigint, bigint, bigint, bigint], dataset: [9n, 9n, 9n, 9n] as [bigint, bigint, bigint, bigint], cities };
    const felts = encodeGame(g);
    expect(felts.slice(8, 12)).toEqual([0n, 13885n, 18235n, 66n]);
    expect(decodeGame(felts)).toEqual(g);
    expect(() => decodeGame([1n, 2n, 3n, 4n])).toThrow(/not GeoQuizz/);
  });
});
