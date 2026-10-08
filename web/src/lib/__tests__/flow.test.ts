// One test per incident from the first Bread session.
import { describe, expect, it, vi } from "vitest";
import type { GqNote } from "../chain";
import type { ChallengeStorage } from "../notes";
import {
  challengeRefusal,
  isAnchorMismatch,
  learnBreadOffset,
  myOpenChallengesOn,
  outcomeText,
  parseAnchorMismatch,
  settlePlan,
  sharedPrizeState,
  submitWithRetry,
} from "../flow";

const champion = { suffix: 1n, prefix: 2n };
const me = { suffix: 3n, prefix: 4n };
const other = { suffix: 5n, prefix: 6n };
const prizeId = [9n, 9n, 9n, 9n] as const;

const base: ChallengeStorage = {
  expiryBlock: 1000,
  target: 2000,
  minStake: 1_000_000n,
  champion,
  player: null,
  prizeId: [0n, 0n, 0n, 0n],
  challengeRoot: [1n, 1n, 1n, 1n],
  seed: [0n, 0n, 0n, 0n],
  dataset: [0n, 0n, 0n, 0n],
  cities: [],
  challengeDeadline: 0,
};
const prize: GqNote = { id: "0x9", idWord: [...prizeId], kind: "prize", storage: base, amount: 1_000_000n, consumed: false };
const challenge = (player: typeof me, deadline: number, consumed = false, id = "0xc"): GqNote => ({
  id,
  idWord: [1n, 2n, 3n, 4n],
  kind: "challenge",
  storage: { ...base, player, prizeId: [...prizeId], challengeDeadline: deadline },
  amount: 1_000_000n,
  consumed,
});

describe("open challenges on a prize", () => {
  it("finds every open note of mine on that prize and nothing else", () => {
    const notes = [
      challenge(me, 500, false, "0xa"),
      challenge(me, 500, false, "0xb"),
      challenge(me, 500, true, "0xconsumed"),
      challenge(me, 90, false, "0xexpired"),
      challenge(other, 500, false, "0xtheirs"),
      { ...challenge(me, 500, false, "0xotherprize"), storage: { ...challenge(me, 500).storage, prizeId: [7n, 7n, 7n, 7n] as [bigint, bigint, bigint, bigint] } },
    ];
    expect(myOpenChallengesOn(notes, me, prize, 100).map((n) => n.id)).toEqual(["0xa", "0xb"]);
    expect(myOpenChallengesOn(notes, null, prize, 100)).toEqual([]);
  });

  it("a challenge is closed from its own deadline or the prize expiry, whichever first", () => {
    expect(myOpenChallengesOn([challenge(me, 2000)], me, prize, 999)).toHaveLength(1);
    expect(myOpenChallengesOn([challenge(me, 2000)], me, prize, 1000)).toHaveLength(0);
    expect(myOpenChallengesOn([challenge(me, 120)], me, prize, 120)).toHaveLength(0);
  });
});

describe("shared prize page", () => {
  it("offers to challenge only an open prize I do not own and have not challenged", () => {
    expect(sharedPrizeState(prize, me, [], 100)).toBe("open");
    expect(sharedPrizeState({ ...prize, consumed: true }, me, [], 100)).toBe("claimed");
    expect(sharedPrizeState(prize, me, [], 1000)).toBe("expired");
    expect(sharedPrizeState(prize, champion, [], 100)).toBe("mine");
    expect(sharedPrizeState(prize, me, [challenge(me, 500)], 100)).toBe("already-challenged");
    expect(sharedPrizeState(prize, null, [], 100)).toBe("open");
  });
});

describe("posting a challenge", () => {
  it("refuses a claimed prize or one about to expire", () => {
    expect(challengeRefusal(prize, 100, 140)).toBeNull();
    expect(challengeRefusal(prize, 900, 140)).toMatch(/too soon/);
    expect(challengeRefusal({ ...prize, consumed: true }, 100, 140)).toMatch(/already been claimed/);
  });
});

describe("settling after a play", () => {
  it("claims the prize with every open challenge on a win", () => {
    const plan = settlePlan([challenge(me, 500, false, "0xa"), challenge(me, 500, false, "0xb")], prize, 2001, 100);
    expect(plan).toMatchObject({ won: true, claimPrize: true });
    expect(plan.text).toMatch(/Claiming the prize and your stake \(2 challenge notes\)/);
  });

  it("only recovers the stake when the prize is gone, and forfeits on a loss or a tie", () => {
    expect(settlePlan([challenge(me, 500)], { ...prize, consumed: true }, 2001, 100)).toMatchObject({ won: true, claimPrize: false });
    expect(settlePlan([challenge(me, 500)], undefined, 2001, 100).text).toMatch(/Recovering your stake/);
    expect(settlePlan([challenge(me, 500)], prize, 2000, 100)).toMatchObject({ won: false, claimPrize: false });
    expect(settlePlan([challenge(me, 500)], prize, 1999, 100).text).toMatch(/goes to the champion when the challenge expires \(block 500, 400 blocks from now\)/);
    expect(() => settlePlan([], prize, 5000, 100)).toThrow();
  });
});

describe("outcome wording", () => {
  it("never says committed before the chain shows the effect", () => {
    expect(outcomeText("Posting your prize", true)).toBe("Posting your prize: confirmed on chain");
    expect(outcomeText("Posting your prize", false)).toMatch(/does not show it yet/);
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
    const other = vi.fn().mockRejectedValue(new Error("You need 1 GQ"));
    await expect(submitWithRetry(other, 0, 3)).rejects.toThrow(/GQ/);
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
