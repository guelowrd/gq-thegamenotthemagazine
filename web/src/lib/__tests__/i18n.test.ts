// English is the key: every line the code hands to t() has an entry in every dictionary with the same placeholders,
// and lines libraries hand back (refusals, trouble titles) too.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DICTS, en, translator } from "../i18n";
import { TAB_LABEL } from "../tabs";
import { explain, NOT_FINISHED, parseCode, SHOT_LOST, shotRefusal } from "../flow";
import type { ChallengeNote } from "../chain";

const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? (f === "__tests__" ? [] : files(join(dir, f))) : /\.tsx?$/.test(f) ? [join(dir, f)] : []));
const literals = files(join(__dirname, "../..")).flatMap((f) => [...readFileSync(f, "utf8").matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]));
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

// UK English only overrides a line or two, the rest is the key itself
describe.each((Object.keys(DICTS) as (keyof typeof DICTS)[]).filter((l) => !l.startsWith("en")))("%s dictionary", (lang) => {
  const D = DICTS[lang]!;
  it("has every line the code hands to t(), with the same placeholders", () => {
    const missing = literals.filter((k) => !(k in D));
    expect(missing).toEqual([]);
    for (const k of literals) if (k !== "{dd} {MMM} {time}") expect(placeholders(D[k]), k).toEqual(placeholders(k));
  });

  it("has the lines libraries hand back as text", () => {
    const record = { consumed: true, storage: { expiryBlock: 0, target: 0, minStake: 0n, champion: { suffix: 1n, prefix: 1n } } } as unknown as ChallengeNote;
    const fromLibs = [
      ...Object.values(TAB_LABEL),
      "All",
      "My records",
      "My shots",
      "{n} Gamecoin",
      "{n} Gamecoins",
      "The game could not start.",
      NOT_FINISHED,
      SHOT_LOST,
      shotRefusal(record, 0)!,
      "This one is yours.",
      "Too late for this one.",
      "This one is rigged.",
      (parseCode("https://x.com/a/status/1") as { hint: string }).hint,
      (parseCode("nope") as { hint: string }).hint,
      ...["NOT_GRANTED", "NETWORK_NOT_GRANTED", "WalletNotReady", "WalletNotConnected", "SummaryAnchorMismatch", "already consumed", "deadline has passed", "dataset", "Not found", "assertion failed", "timed out", "???"].map((raw) => explain(new Error(raw)).title),
    ];
    expect(fromLibs.filter((k) => !(k in D))).toEqual([]);
  });
});

describe("a translator", () => {
  it("translates whole sentences, fills placeholders after, and falls back to English", () => {
    const zh = translator("zh-Hans");
    expect(zh("{who} can take the coin.", { who: "JHT" })).toBe("JHT 可以领走游戏币。");
    expect(zh("Defended|board")).toBe("守住纪录最多");
    expect(zh("no such line {x}", { x: 1 })).toBe("no such line 1");
    expect(en("Defended|board")).toBe("Defended");
    expect(en("{n} pts", { n: "4,100" })).toBe("4,100 pts");
  });
});
