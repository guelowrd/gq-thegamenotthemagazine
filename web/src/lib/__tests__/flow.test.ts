// One test per incident from the first Bread session.
import { describe, expect, it, vi } from "vitest";
import type { ChallengeNote } from "../chain";
import type { ChallengeStorage, Word4 } from "../notes";
import { stageById, WORLD } from "../stages";
import { BLOCK_SECONDS, GC_FAUCET, MIN_SHOT_WINDOW_BLOCKS, RECORD_LIFETIME_BLOCKS } from "@/config";
import {
  acceptNote,
  blocksToClock,
  noteKind,
  claimVerdict,
  explain,
  NOT_FINISHED,
  withTimeout,
  shotRefusal,
  isChainBehind,
  myOpenShotsOn,
  fmtGamecoin,
  outcomeText,
  recordLinks,
  breadLink,
  withoutRecord,
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
  game: [],
  shotDeadline: 0,
};
const prize: ChallengeNote = { id: "0x9", idWord: [...recordId], kind: "record", storage: base, faucet: GC_FAUCET, amount: 1_000_000n, consumed: false };
const challenge = (rival: typeof me, deadline: number, consumed = false, id = "0xc"): ChallengeNote => ({
  id,
  idWord: [1n, 2n, 3n, 4n],
  kind: "shot",
  storage: { ...base, rival, recordId: [...recordId], shotDeadline: deadline },
  faucet: GC_FAUCET,
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
    expect(shotRefusal(prize, 100)).toBeNull();
    expect(shotRefusal(prize, 1000 - MIN_SHOT_WINDOW_BLOCKS)).toBeNull();
    expect(shotRefusal(prize, 1000 - MIN_SHOT_WINDOW_BLOCKS + 1)).toMatch(/too late/i);
    expect(shotRefusal({ ...prize, consumed: true }, 100)).toMatch(/over/);
  });

  it("refuses my own record: the claim would run the champion's path, which only opens after expiry", () => {
    expect(shotRefusal(prize, 100, champion)).toBe("This one is yours.");
    expect(shotRefusal(prize, 100, me)).toBeNull();
  });

  it("refuses a record whose terms the game could never produce", () => {
    const rigged = (storage: Partial<ChallengeStorage>) => shotRefusal({ ...prize, storage: { ...base, ...storage } }, 100);
    expect(rigged({ target: 9999 })).toBeNull();
    expect(rigged({ target: 10_000 })).toMatch(/rigged/);
    expect(rigged({ minStake: 999_999n })).toMatch(/rigged/);
    expect(rigged({ minStake: 1_000_001n })).toMatch(/rigged/);
    expect(rigged({ expiryBlock: 100 + RECORD_LIFETIME_BLOCKS })).toBeNull();
    expect(rigged({ expiryBlock: 100 + RECORD_LIFETIME_BLOCKS + 1 })).toMatch(/rigged/);
  });
});

describe("script roots", () => {
  const current = { recordRoot: "0xr2", shotRoot: "0xs2" };
  it("knows the two scripts: a record names the shot script its shots run; the testnet v1 roots are foreign", () => {
    expect(noteKind("0xr2", current)).toEqual({ kind: "record", shotRoot: "0xs2" });
    expect(noteKind("0xs2", current)).toEqual({ kind: "shot" });
    expect(noteKind("0xf5c76231f25a67b72beb4044d34387ef9f54e163303c896a2ca7847ace21227f", current)).toBeNull();
    expect(noteKind("0xother", current)).toBeNull();
  });
});

describe("accepting a note from the chain", () => {
  const gc = { faucet: GC_FAUCET, amount: 1_000_000n };
  const shotRoot = base.shotRoot;
  const record = { kind: "record" as const, storage: base, sender: champion, assets: [gc] };
  const shot = { kind: "shot" as const, storage: { ...base, rival: me, recordId: [...recordId] as Word4, shotDeadline: 200 }, sender: me, assets: [gc] };

  it("takes a record only from its champion, a shot only from its rival", () => {
    expect(acceptNote(record, shotRoot)).toBe(true);
    expect(acceptNote(shot, shotRoot)).toBe(true);
    expect(acceptNote({ ...record, sender: other }, shotRoot)).toBe(false);
    expect(acceptNote({ ...shot, sender: champion }, shotRoot)).toBe(false);
  });

  it("wants exactly one asset, a Gamecoin: another faucet's coin is foreign", () => {
    expect(acceptNote({ ...record, assets: [{ faucet: "0x0123456789abcdef0123456789abcd", amount: 1_000_000n }] }, shotRoot)).toBe(false);
    expect(acceptNote({ ...record, assets: [] }, shotRoot)).toBe(false);
    expect(acceptNote({ ...record, assets: [{ faucet: "0xbad", amount: 1_000_000n }] }, shotRoot)).toBe(false);
    expect(acceptNote({ ...record, assets: [gc, { faucet: "0xbad", amount: 1n }] }, shotRoot)).toBe(false);
  });

  it("a record names this game's shot script and no rival, deadline or record id", () => {
    expect(acceptNote({ ...record, storage: { ...base, shotRoot: [2n, 2n, 2n, 2n] } }, shotRoot)).toBe(false);
    expect(acceptNote({ ...record, storage: { ...base, rival: me } }, shotRoot)).toBe(false);
    expect(acceptNote({ ...record, storage: { ...base, shotDeadline: 5 } }, shotRoot)).toBe(false);
    expect(acceptNote({ ...record, storage: { ...base, recordId: [...recordId] as Word4 } }, shotRoot)).toBe(false);
    // a shot points at a record
    expect(acceptNote({ ...shot, storage: { ...shot.storage, recordId: [0n, 0n, 0n, 0n] } }, shotRoot)).toBe(false);
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
    expect(settlePlan([challenge(me, 500)], undefined, 2001, 100).text).toMatch(/Gamecoin comes back/);
    expect(settlePlan([challenge(me, 500)], prize, 2000, 100)).toMatchObject({ won: false, claimPrize: false, again: true });
    expect(settlePlan([challenge(me, 500)], prize, 1999, 100).text).toMatch(/Not enough\.$/);
    // the shot ended during the play: nothing to try again at
    expect(settlePlan([challenge(me, 50)], prize, 1999, 100)).toMatchObject({ won: false, again: false });
    expect(settlePlan([challenge(me, 50)], prize, 1999, 100).text).toMatch(/goes to the champion/);
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
  const behind = new Error("ChainBehindBoundBlockError: the Miden client synced to block 5, below block 6 the proposal binds; its node has not reached that block yet");

  it("retries only while Bread is behind the bound block, up to the budget", async () => {
    const attempt = vi.fn<(n: number) => Promise<string>>().mockRejectedValueOnce(behind).mockResolvedValue("tx");
    await expect(submitWithRetry(attempt, 3)).resolves.toBe("tx");
    expect(attempt.mock.calls.map(([n]) => n)).toEqual([1, 2]);
    const always = vi.fn().mockRejectedValue(behind);
    await expect(submitWithRetry(always, 3)).rejects.toBe(behind);
    expect(always).toHaveBeenCalledTimes(3);
    const other = vi.fn().mockRejectedValue(new Error("You need 1 GC"));
    await expect(submitWithRetry(other, 3)).rejects.toThrow(/GC/);
    expect(other).toHaveBeenCalledTimes(1);
  });

  it("recognises Bread being behind, and nothing else", () => {
    expect(isChainBehind(behind)).toBe(true);
    expect(isChainBehind(new Error("insufficient balance"))).toBe(false);
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

describe("Gamecoin in words", () => {
  it("spells the token out, singular and plural", () => {
    expect(fmtGamecoin(1_000_000n)).toBe("1 Gamecoin");
    expect(fmtGamecoin(10_000_000n)).toBe("10 Gamecoins");
  });
  it("shares a record as a ?record= link, inside the X post too, with the expiry in UTC; the Weibo post carries the same link", () => {
    const { url, x, weibo } = recordLinks("0xabc", 9690, Date.UTC(2026, 9, 13, 14, 5));
    expect(url).toMatch(/\?record=0xabc$/);
    expect(decodeURIComponent(x)).toContain(url);
    expect(new URL(weibo).searchParams.get("url")).toBe(url);
    expect(new URL(weibo).searchParams.get("title")).toBe("我在 GeoQuizz 得了 9690 分。来挑战我的纪录！");
    const text = new URL(x).searchParams.get("text")!;
    expect(text).toContain("9690");
    expect(text).toContain("13 Oct 14:05 UTC");
    expect(text).toContain("@joinbread");
    // the link on its own line after a full stop: X swaps it for the card, so no colon is left hanging
    expect(text).toMatch(new RegExp(`\\.\n${url.replace(/[?.]/g, "\\$&")}$`));
    expect(new URL(x).searchParams.get("url")).toBeNull();
  });
  it("opens a page in Bread's phone app through Bread's open link, the page in the fragment", () => {
    const page = "https://gq-thegamenotthemagazine.app/?record=0xabc";
    const link = new URL(breadLink(page));
    expect(link.origin + link.pathname).toBe("https://bread.miden.xyz/open");
    expect(new URLSearchParams(link.hash.slice(1)).get("url")).toBe(page);
  });
  it("names the map of a stage record: GQ Asia in the X post, the Chinese name in the Weibo post", () => {
    const at = Date.UTC(2026, 9, 13, 14, 5);
    const { x, weibo } = recordLinks("0xabc", 6239, at, [], stageById("asia"));
    expect(new URL(x).searchParams.get("text")).toContain("GQ Asia");
    expect(new URL(weibo).searchParams.get("title")).toBe("我在 GeoQuizz 亚洲得了 6239 分。来挑战我的纪录！");
    expect(new URL(recordLinks("0xabc", 6239, at, [], WORLD).x).searchParams.get("text")).not.toContain("GQ ");
  });
  it("brags about a hard city, teases with an easy one, says nothing about the rest", () => {
    const at = Date.UTC(2026, 9, 13, 14, 5);
    const text = (id: string, cities: string[]) => new URL(recordLinks(id, 9690, at, cities).x).searchParams.get("text")!;
    expect(text("0xa", ["Paris", "Funafuti", "Lagos"])).toContain("Funafuti");
    expect(text("0xa", ["Paris", "Lagos"])).toContain("Paris");
    expect(text("0xa", ["Lagos", "Kigali"])).not.toMatch(/Lagos|Kigali/);
    const hard = new Set(["0xa", "0xb", "0xc", "0xd"].map((id) => text(id, ["Funafuti"])));
    expect(hard.size).toBeGreaterThan(1);
  });
  it("does not always say it the same way: the record picks the line", () => {
    const at = Date.UTC(2026, 9, 13, 14, 5);
    const texts = new Set(["0xa", "0xb", "0xc", "0xd"].map((id) => new URL(recordLinks(id, 9690, at).x).searchParams.get("text")));
    expect(texts.size).toBeGreaterThan(1);
    expect(recordLinks("0xa", 9690, at).x).toBe(recordLinks("0xa", 9690, at).x);
  });
});

describe("errors in plain words", () => {
  const cases: [unknown, string][] = [
    [new Error("NOT_GRANTED"), "said-no"],
    [Object.assign(new Error("NETWORK_NOT_GRANTED"), { name: "WalletConnectionError" }), "refused"],
    [Object.assign(new Error("User rejected the request"), { name: "WalletTransactionError" }), "said-no"],
    [Object.assign(new Error(""), { name: "WalletNotReadyError" }), "no-wallet"],
    [Object.assign(new Error(""), { name: "WalletNotConnectedError" }), "no-wallet"],
    [new Error("Bread is not connected"), "no-wallet"],
    [new Error("SummaryAnchorMismatchError: the transaction summary binds block commitment 0x1 but the captured chain anchor is 0x2"), "out-of-step"],
    [new Error("failed to capture chain anchor: storage error: block header for block 85053 not found"), "out-of-step"],
    [new Error(NOT_FINISHED), "not-finished"],
    [new TypeError("Failed to fetch"), "network"],
    [new Error("rpc error: status: Unavailable, transport error"), "network"],
    [new Error("Loading the record timed out after 30 s"), "network"],
    [new Error("The faucet note never arrived."), "network"],
    [new Error("transaction conflicts with current mempool state\ncaused by: output notes already exist: [NoteId(1)]"), "network"],
    [new Error("some notes were not found on chain"), "not-found"],
    [new Error("This note is not a record or shot of this game."), "not-found"],
    [new Error("failed to execute transaction kernel program: assertion failed with error code: 14434107113890732517"), "refused"],
    [new Error("challenge: the deadline has passed"), "too-late"],
    [new Error("This record's quiz does not match the dataset."), "other-cities"],
    [new Error("failed to execute transaction: invalid transaction request: note with details commitment 0x1238 has already been consumed"), "already-done"],
    [new Error("something odd"), "unknown"],
  ];
  it.each(cases)("%s", (e, kind) => {
    const t = explain(e);
    expect(t.kind).toBe(kind);
    expect(t.title).not.toMatch(/0x|Error:|NOT_GRANTED/);
  });
  it("keeps the raw text for 'What happened?', but not when the sentence is already the message", () => {
    expect(explain(new TypeError("Failed to fetch")).detail).toBe("TypeError: Failed to fetch");
    expect(explain(new Error("rpc error: transport error")).detail).toBe("rpc error: transport error");
    expect(explain(new Error(NOT_FINISHED)).detail).toBeUndefined();
  });
  it("times out a read that hangs, as a network trouble", async () => {
    vi.useFakeTimers();
    const late = withTimeout(new Promise(() => undefined), 30_000, "Loading the record");
    vi.advanceTimersByTime(30_000);
    await expect(late).rejects.toThrow(/timed out/);
    vi.useRealTimers();
    expect(explain(await late.catch((e) => e)).kind).toBe("network");
    await expect(withTimeout(Promise.resolve(7), 1000, "x")).resolves.toBe(7);
  });
});

describe("leaving a record behind", () => {
  it("drops ?record= and keeps the rest", () => {
    expect(withoutRecord("http://localhost:5173/?record=0xabc")).toBe("http://localhost:5173/");
    expect(withoutRecord("http://localhost:5173/?local=2&record=0xabc")).toBe("http://localhost:5173/?local=2");
  });
});

describe("before sending a claim", () => {
  it("knows a shot used up to CLAIM_FUZZ past its deadline was claimed by its rival, and one used later was taken", () => {
    expect(claimVerdict([{ deadline: 100 }])).toBe("open");
    expect(claimVerdict([{ consumedAt: 99, deadline: 100 }])).toBe("claimed");
    expect(claimVerdict([{ consumedAt: 164, deadline: 100 }])).toBe("claimed");
    expect(claimVerdict([{ consumedAt: 165, deadline: 100 }])).toBe("lost");
    expect(claimVerdict([{ consumedAt: 90, deadline: 100 }, { deadline: 100 }])).toBe("open");
  });
  it("shows block counts as a clock", () => {
    expect(blocksToClock(81)).toBe("4:23"); // 263.25 s: whole seconds
    expect(blocksToClock(-5)).toBe("0:00");
    expect(blocksToClock(26_400)).toBe("23:50:00");
    expect(blocksToClock(Math.round(3603 / BLOCK_SECONDS))).toMatch(/^1:00:0\d$/);
  });
});
