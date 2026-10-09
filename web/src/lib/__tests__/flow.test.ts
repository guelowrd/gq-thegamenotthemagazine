// One test per incident from the first Bread session.
import { describe, expect, it, vi } from "vitest";
import type { GqNote } from "../chain";
import type { ChallengeStorage } from "../notes";
import {
  shotRefusal,
  isAnchorMismatch,
  learnBreadOffset,
  myOpenShotsOn,
  outcomeText,
  parseAnchorMismatch,
  parseCode,
  reportRows,
  settlePlan,
  sharedRecordState,
  submitWithRetry,
} from "../flow";

const champion = { suffix: 1n, prefix: 2n };
const me = { suffix: 3n, prefix: 4n };
const other = { suffix: 5n, prefix: 6n };
const recordId = [9n, 9n, 9n, 9n] as const;

const base: ChallengeStorage = {
  expiryBlock: 1000,
  target: 2000,
  minStake: 1_000_000n,
  champion,
  rival: null,
  recordId: [0n, 0n, 0n, 0n],
  shotRoot: [1n, 1n, 1n, 1n],
  seed: [0n, 0n, 0n, 0n],
  dataset: [0n, 0n, 0n, 0n],
  cities: [],
  shotDeadline: 0,
};
const prize: GqNote = { id: "0x9", idWord: [...recordId], kind: "record", storage: base, amount: 1_000_000n, consumed: false };
const challenge = (rival: typeof me, deadline: number, consumed = false, id = "0xc"): GqNote => ({
  id,
  idWord: [1n, 2n, 3n, 4n],
  kind: "shot",
  storage: { ...base, rival, recordId: [...recordId], shotDeadline: deadline },
  amount: 1_000_000n,
  consumed,
});

describe("open shots at a record", () => {
  it("finds every open note of mine on that prize and nothing else", () => {
    const notes = [
      challenge(me, 500, false, "0xa"),
      challenge(me, 500, false, "0xb"),
      challenge(me, 500, true, "0xconsumed"),
      challenge(me, 90, false, "0xexpired"),
      challenge(other, 500, false, "0xtheirs"),
      { ...challenge(me, 500, false, "0xotherprize"), storage: { ...challenge(me, 500).storage, recordId: [7n, 7n, 7n, 7n] as [bigint, bigint, bigint, bigint] } },
    ];
    expect(myOpenShotsOn(notes, me, prize, 100).map((n) => n.id)).toEqual(["0xa", "0xb"]);
    expect(myOpenShotsOn(notes, null, prize, 100)).toEqual([]);
  });

  it("a challenge is closed from its own deadline or the prize expiry, whichever first", () => {
    expect(myOpenShotsOn([challenge(me, 2000)], me, prize, 999)).toHaveLength(1);
    expect(myOpenShotsOn([challenge(me, 2000)], me, prize, 1000)).toHaveLength(0);
    expect(myOpenShotsOn([challenge(me, 120)], me, prize, 120)).toHaveLength(0);
  });
});

describe("shared record page", () => {
  it("offers to challenge only an open prize I do not own and have not challenged", () => {
    expect(sharedRecordState(prize, me, [], 100)).toBe("open");
    expect(sharedRecordState({ ...prize, consumed: true }, me, [], 100)).toBe("claimed");
    expect(sharedRecordState(prize, me, [], 1000)).toBe("expired");
    expect(sharedRecordState(prize, champion, [], 100)).toBe("mine");
    expect(sharedRecordState(prize, me, [challenge(me, 500)], 100)).toBe("already-challenged");
    expect(sharedRecordState(prize, null, [], 100)).toBe("open");
  });
});

describe("taking a shot", () => {
  it("refuses a claimed record or one about to expire", () => {
    expect(shotRefusal(prize, 100, 140)).toBeNull();
    expect(shotRefusal(prize, 900, 140)).toMatch(/too late/i);
    expect(shotRefusal({ ...prize, consumed: true }, 100, 140)).toMatch(/over/);
  });
});

describe("settling after a play", () => {
  it("claims the prize with every open shot on a win", () => {
    const plan = settlePlan([challenge(me, 500, false, "0xa"), challenge(me, 500, false, "0xb")], prize, 2001, 100);
    expect(plan).toMatchObject({ won: true, claimPrize: true });
    expect(plan.text).toMatch(/You win!/);
  });

  it("only recovers the stake when the prize is gone, and forfeits on a loss or a tie", () => {
    expect(settlePlan([challenge(me, 500)], { ...prize, consumed: true }, 2001, 100)).toMatchObject({ won: true, claimPrize: false });
    expect(settlePlan([challenge(me, 500)], undefined, 2001, 100).text).toMatch(/Geocoin comes back/);
    expect(settlePlan([challenge(me, 500)], prize, 2000, 100)).toMatchObject({ won: false, claimPrize: false });
    expect(settlePlan([challenge(me, 500)], prize, 1999, 100).text).toMatch(/goes to the champion/);
    expect(() => settlePlan([], prize, 5000, 100)).toThrow();
  });
});

describe("outcome wording", () => {
  it("never says committed before the chain shows the effect", () => {
    expect(outcomeText("Posting", true)).toBe("Posting. Done!");
    expect(outcomeText("5200 points. You win!", true)).toBe("5200 points. You win! Done!");
    expect(outcomeText("Posting", false)).toMatch(/not done yet/);
  });
});

describe("submitting through Bread", () => {
  const mismatch = new Error("SummaryAnchorMismatchError: the transaction summary binds block commitment 0x1 but the captured chain anchor is 0x2");

  it("retries only on an anchor mismatch, alternating the block offset", async () => {
    const attempt = vi.fn<(offset: number, n: number) => Promise<string>>().mockRejectedValueOnce(mismatch).mockRejectedValueOnce(mismatch).mockResolvedValue("tx");
    await expect(submitWithRetry(attempt, 1, 8)).resolves.toBe("tx");
    expect(attempt.mock.calls.map(([offset]) => offset)).toEqual([1, 2, 1]);
  });

  it("gives up after the retry budget and rethrows other errors at once", async () => {
    const always = vi.fn().mockRejectedValue(mismatch);
    await expect(submitWithRetry(always, 0, 3)).rejects.toBe(mismatch);
    expect(always).toHaveBeenCalledTimes(3);
    const other = vi.fn().mockRejectedValue(new Error("You need 1 GC"));
    await expect(submitWithRetry(other, 0, 3)).rejects.toThrow(/GC/);
    expect(other).toHaveBeenCalledTimes(1);
  });

  it("learns Bread's block from its error and corrects the next attempt by that offset", async () => {
    const e = new Error("SummaryAnchorMismatchError: the transaction summary binds block commitment 0xAAA but the captured chain anchor is 0xBBB; retry");
    expect(parseAnchorMismatch(e)).toEqual({ bound: "0xaaa", anchor: "0xbbb" });
    expect(parseAnchorMismatch(new Error("other"))).toBeNull();
    const headers: Record<number, string> = { 100: "0xaaa", 101: "0xccc", 102: "0xbbb" };
    expect(await learnBreadOffset(100, "0xbbb", async (n) => headers[n] ?? null)).toBe(2);
    expect(await learnBreadOffset(100, "0xzzz", async (n) => headers[n] ?? null)).toBeNull();

    const attempt = vi.fn<(offset: number, n: number) => Promise<string>>().mockRejectedValueOnce(e).mockResolvedValue("tx");
    await expect(submitWithRetry(attempt, 1, 5, async () => 2)).resolves.toBe("tx");
    expect(attempt.mock.calls.map(([offset]) => offset)).toEqual([1, 3]);
  });

  it("recognises Bread's anchor errors", () => {
    expect(isAnchorMismatch(mismatch)).toBe(true);
    expect(isAnchorMismatch(new Error("ChainBehindBoundBlockError: synced to block 5, below block 7"))).toBe(true);
    expect(isAnchorMismatch(new Error("insufficient balance"))).toBe(false);
  });
});

describe("the run report", () => {
  it("names each city with the time and the points the chain gives", () => {
    const cities = [
      { idx: 0, lat: 13885, lon: 18235, cos: 66 },
      { idx: 1, lat: 6709, lon: 13683, cos: 92 },
    ];
    const places = [
      { name: "Paris", country: "France", lat: 48.85, lon: 2.35 },
      { name: "Rio", country: "Brazil", lat: -22.91, lon: -43.17 },
    ];
    const rows = reportRows(cities, [{ lat: 13885, lon: 18235, t: 120 }, { lat: 0, lon: 0, t: 1500 }], places);
    expect(rows).toEqual([
      { name: "Paris", seconds: "1.2s", points: 988 },
      { name: "Rio", seconds: "15.0s", points: 0 },
    ]);
  });
});

describe("a pasted code", () => {
  const id = "0x" + "ab".repeat(32);
  it("finds the record id in a link, in our X share link, or bare", () => {
    expect(parseCode(`http://localhost:5173/?record=${id}`)).toEqual({ id });
    expect(parseCode(`https://x.com/intent/post?text=hi&url=${encodeURIComponent(`http://gq/?record=${id}`)}`)).toEqual({ id });
    expect(parseCode(id.toUpperCase())).toEqual({ id });
  });
  it("cannot read a posted X status and says what to do", () => {
    expect(parseCode("https://x.com/someone/status/1234567890")).toEqual({ hint: "Open the post and copy the GeoQuizz link." });
    expect(parseCode("hello")).toEqual({ hint: "That is not a GeoQuizz code." });
  });
});
