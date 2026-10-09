// Past games and boards are read from the chain alone: one test per rule.
import { describe, expect, it } from "vitest";
import type { ChallengeNote } from "@/lib/chain";
import type { AccountFelts, ChallengeStorage } from "@/lib/notes";
import { boards, history, keyOf, lettersBackward, nicknames, playersInOrder, shotOutcome, triesLost, whenLabel } from "../hub";

const ME = { suffix: 1n, prefix: 1n };
const KQX = { suffix: 2n, prefix: 2n };
const MUD = { suffix: 3n, prefix: 3n };
const GC = 1_000_000n;
const name = (a: AccountFelts) => ({ [keyOf(ME)]: "JHT", [keyOf(KQX)]: "KQX", [keyOf(MUD)]: "MUD" })[keyOf(a)] ?? "???";

let n = 0;
const base: ChallengeStorage = { expiryBlock: 1000, target: 4100, minStake: GC, champion: ME, rival: null, recordId: [0n, 0n, 0n, 0n], shotRoot: [0n, 0n, 0n, 0n], game: [], shotDeadline: 0 };
function record(champion: AccountFelts, target: number, o: Partial<ChallengeNote> & { expiry?: number } = {}): ChallengeNote {
  const w = BigInt(++n);
  return { id: `0xr${n}`, idWord: [w, w, w, w], kind: "record", storage: { ...base, champion, target, expiryBlock: o.expiry ?? 1000 }, amount: GC, consumed: o.consumedAt !== undefined, createdAt: n, ...o };
}
function shot(at: ChallengeNote, rival: AccountFelts, deadline: number, o: Partial<ChallengeNote> = {}): ChallengeNote {
  return { id: `0xs${++n}`, idWord: [0n, 0n, 0n, BigInt(n)], kind: "shot", storage: { ...at.storage, rival, recordId: at.idWord, shotDeadline: deadline }, amount: GC, consumed: o.consumedAt !== undefined, createdAt: n, ...o };
}

describe("nicknames", () => {
  it("reads three letters backward from the address, digits and the wallet's routing part left out", () => {
    expect(lettersBackward("mtst1aryq2znjyt4wqq29lxwta3sjnqlnthj9_qr7qqq9wr6w").slice(0, 3)).toBe("JHT");
  });

  it("on a clash the first to play keeps the name; the next takes the next letter further back", () => {
    const players = [
      { key: "first", address: "mtst1aaanthj9" },
      { key: "second", address: "mtst1bbbnthj9" },
      { key: "third", address: "mtst1cccnthj9" },
    ];
    const names = nicknames(players);
    expect([names.get("first"), names.get("second"), names.get("third")]).toEqual(["JHT", "JHN", "JHC"]);
  });

  it("orders players by their first record or shot on chain", () => {
    const r = record(MUD, 100, { createdAt: 50 });
    const s = shot(r, KQX, 900, { createdAt: 10 });
    expect(playersInOrder([r, s, record(KQX, 100, { createdAt: 60 })])).toEqual([KQX, MUD]);
  });
});

describe("how games ended", () => {
  it("a shot used before its deadline was won, after it was taken by the champion, unused past it is lost", () => {
    const r = record(MUD, 100);
    expect(shotOutcome(shot(r, ME, 200, { consumedAt: 199 }), 500)).toBe("won");
    expect(shotOutcome(shot(r, ME, 200, { consumedAt: 200 }), 500)).toBe("lost");
    expect(shotOutcome(shot(r, ME, 200), 200)).toBe("lost");
    expect(shotOutcome(shot(r, ME, 200), 199)).toBe("open");
    expect(shotOutcome({ ...shot(r, ME, 200), consumed: true }, 500)).toBeUndefined();
  });

  it("a claim that lands after the shot deadline still won: it took the open record in the same block", () => {
    const r = record(MUD, 9690, { consumedAt: 82650, expiry: 111298 });
    const s = shot(r, KQX, 82645, { consumedAt: 82650 });
    expect(shotOutcome(s, 90000, r)).toBe("won");
    expect(history([r, s], MUD, 90000, name).map((h) => h.lines)).toEqual([["KQX beat it", "0 tries lost"]]);
    // the champion taking an expired record with a lost shot in one go is not a claim
    const old = record(MUD, 100, { consumedAt: 2000, expiry: 1000 });
    expect(shotOutcome(shot(old, KQX, 500, { consumedAt: 2000 }), 3000, old)).toBe("lost");
  });

  it("counts tries lost only once every shot is known", () => {
    const r = record(ME, 100);
    const notes = [r, shot(r, KQX, 200), shot(r, MUD, 900)];
    expect(triesLost(r, notes, 300)).toBe(1);
    expect(triesLost(r, [...notes, { ...shot(r, KQX, 200), consumed: true }], 300)).toBeNull();
  });
});

describe("history", () => {
  it("tells each ending in a line or two, newest first, and leaves live games out", () => {
    const smashed = record(ME, 4100, { consumedAt: 300 });
    const defended = record(ME, 6800, { consumedAt: 1200 });
    const nobody = record(ME, 3900, { consumedAt: 1100 });
    const live = record(ME, 5000);
    const theirs = record(MUD, 6200, { consumedAt: 400 });
    const other = record(KQX, 5500, { consumedAt: 50 });
    const notes = [
      smashed,
      shot(smashed, MUD, 200),
      shot(smashed, KQX, 400, { consumedAt: 300 }),
      defended,
      shot(defended, KQX, 200, { consumedAt: 1150 }),
      shot(defended, MUD, 300),
      nobody,
      live,
      theirs,
      shot(theirs, ME, 450, { consumedAt: 400 }),
      other,
      shot(other, ME, 600, { consumedAt: 500 }),
      shot(record(MUD, 8400), ME, 100, { consumedAt: 700 }),
    ];
    const rows = history(notes, ME, 2000, name).map((h) => [h.title, ...h.lines]);
    expect(rows).toEqual([
      ["6,800 pts", "2 tries lost"],
      ["3,900 pts", "Nobody tried", "Taken back"],
      ["MUD / 8,400", "Lost 1 Geocoin"],
      ["KQX / 5,500", "Got my Geocoin back"],
      ["MUD / 6,200", "Smashed it!", "Got 2 Geocoins"],
      ["4,100 pts", "KQX beat it", "1 try lost"],
    ]);
  });
});

describe("boards", () => {
  it("Geocoins won: lost shots a champion took plus prizes, never a winner's own Geocoin back", () => {
    const mine = record(ME, 100, { consumedAt: 2000 });
    const theirs = record(MUD, 100, { consumedAt: 150 });
    const notes = [mine, shot(mine, KQX, 200, { consumedAt: 1500 }), shot(mine, MUD, 300, { consumedAt: 1600 }), theirs, shot(theirs, KQX, 200, { consumedAt: 150 })];
    const { coins, smashed, defended } = boards(notes, 3000, ME);
    expect(coins.top.map((r) => [name(r.who), r.value])).toEqual([["JHT", 2], ["KQX", 1]]);
    expect(smashed.top.map((r) => [name(r.who), r.value])).toEqual([["KQX", 1]]);
    expect(defended.top.map((r) => [name(r.who), r.value])).toEqual([["JHT", 2]]);
  });

  it("defended counts every rival who lost, on records still open too", () => {
    const open = record(ME, 5382, { expiry: 5000 });
    const notes = [open, shot(open, KQX, 200, { consumedAt: 900 }), shot(open, MUD, 300), shot(open, MUD, 800)];
    expect(boards(notes, 400, ME).defended.top.map((r) => [name(r.who), r.value])).toEqual([["JHT", 2]]);
  });

  it("best records: top 10 by score, names may repeat, a tie goes to the first posted, my best row below with its real rank", () => {
    const notes = [record(ME, 50), ...Array.from({ length: 11 }, (_, i) => record(i % 2 ? KQX : MUD, 1000 - i * 10)), record(ME, 40)];
    notes.push(record(MUD, 1000, { createdAt: 999 }));
    const { records } = boards(notes, 0, ME);
    expect(records.top).toHaveLength(10);
    expect(records.top.slice(0, 3).map((r) => [name(r.who), r.value])).toEqual([["MUD", 1000], ["MUD", 1000], ["KQX", 990]]);
    expect(records.top[1].at).toBe(999);
    expect(records.mine && [records.mine.rank, records.mine.value]).toEqual([13, 50]);
  });
});

describe("history times", () => {
  it("say today, yesterday, tomorrow, or the date, in local time", () => {
    const now = new Date(2026, 9, 9, 22, 0).getTime();
    expect(whenLabel(new Date(2026, 9, 9, 18, 42).getTime(), now)).toBe("TODAY 18:42");
    expect(whenLabel(new Date(2026, 9, 8, 21, 10).getTime(), now)).toBe("YESTERDAY 21:10");
    expect(whenLabel(new Date(2026, 9, 7, 8, 5).getTime(), now)).toBe("07 OCT 08:05");
    expect(whenLabel(new Date(2026, 9, 10, 9, 5).getTime(), now)).toBe("TOMORROW 09:05");
  });
});
