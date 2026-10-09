// Past games and the public leaderboards, read from the game's public notes: nobody reports a
// result, the chain tells how each record and shot ended. Pure: notes (with the blocks they were
// made and used in) come in, rows come out.

import type { ChallengeNote } from "./chain";
import { fmtGeocoin } from "./flow";
import { shotDeadline, type AccountFelts } from "./notes";
import { GC_DECIMALS } from "@/config";

export const keyOf = (a: AccountFelts) => `${a.prefix}:${a.suffix}`;
const same = (a: AccountFelts | null, b: AccountFelts | null) => !!a && !!b && keyOf(a) === keyOf(b);
const sameWord = (a: bigint[], b: bigint[]) => a.every((f, i) => f === b[i]);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Letters of an address read from its end: digits and the wallet's `_…` routing part left out. */
export function lettersBackward(address: string): string {
  const id = address.split("_")[0];
  return [...id.slice(id.lastIndexOf("1") + 1)]
    .reverse()
    .filter((c) => /[a-z]/i.test(c))
    .join("")
    .toUpperCase();
}

/**
 * Arcade names: the first three letters of the address read backward (…nthj9 → JHT). A name already
 * taken keeps its first two letters and takes the next letter further back (JHN, then JHL…), so
 * whoever played first keeps theirs. `players` come in the order they first played.
 * ponytail: when every third letter is taken (some 25 of them) the name repeats; vary the second letter then.
 */
export function nicknames(players: { key: string; address: string }[]): Map<string, string> {
  const names = new Map<string, string>();
  const taken = new Set<string>();
  for (const { key, address } of players) {
    if (names.has(key)) continue;
    const letters = lettersBackward(address);
    let name = letters.slice(0, 3);
    for (let i = 3; taken.has(name) && i < letters.length; i++) name = letters.slice(0, 2) + letters[i];
    taken.add(name);
    names.set(key, name);
  }
  return names;
}

/** Everyone who played, in the order they first did: a champion from a record, a rival from a shot. */
export function playersInOrder(notes: ChallengeNote[]): AccountFelts[] {
  const plays = notes
    .flatMap((n) => {
      const who = n.kind === "record" ? n.storage.champion : n.storage.rival;
      return who ? [{ who, at: n.createdAt ?? Infinity }] : [];
    })
    .sort((a, b) => a.at - b.at || (keyOf(a.who) < keyOf(b.who) ? -1 : 1));
  const seen = new Map<string, AccountFelts>();
  for (const { who } of plays) if (!seen.has(keyOf(who))) seen.set(keyOf(who), who);
  return [...seen.values()];
}

/**
 * How a shot ended. Before its deadline only its rival can use it, and only with a winning answer;
 * from the deadline on only its champion. A claim proved before the deadline can land a few blocks
 * after it (testnet, 2026-10-09: deadline 82645, claim in 82650), but it takes the shot together with
 * its `record`, which only a winner can take before the record expires. undefined while the node has
 * not said when it was used.
 * ponytail: a win without the prize (record already gone) that lands after the deadline reads as lost;
 * read the claim's reference block if the node ever serves it.
 */
export function shotOutcome(shot: ChallengeNote, height: number, record?: ChallengeNote): "won" | "lost" | "open" | undefined {
  const deadline = shotDeadline(shot.storage);
  if (!shot.consumed) return height >= deadline ? "lost" : "open";
  if (shot.consumedAt === undefined) return undefined;
  const claimedWithRecord = record?.consumedAt === shot.consumedAt && shot.consumedAt < record.storage.expiryBlock;
  return shot.consumedAt < deadline || claimedWithRecord ? "won" : "lost";
}

/** How a record ended: smashed (used before it expired, which only a winner can do), closed (expired) or open. */
export function recordOutcome(record: ChallengeNote, height: number): "smashed" | "closed" | "open" | undefined {
  const expiry = record.storage.expiryBlock;
  if (record.consumed) return record.consumedAt === undefined ? undefined : record.consumedAt < expiry ? "smashed" : "closed";
  return height >= expiry ? "closed" : "open";
}

const shotsAt = (record: ChallengeNote, notes: ChallengeNote[]) => notes.filter((n) => n.kind === "shot" && sameWord(n.storage.recordId, record.idWord));
const recordOf = (shot: ChallengeNote, notes: ChallengeNote[]) => notes.find((n) => n.kind === "record" && sameWord(n.idWord, shot.storage.recordId));

/** Shots at `record` lost so far, or null while one of them waits for the node. */
export function triesLost(record: ChallengeNote, notes: ChallengeNote[], height: number): number | null {
  const outcomes = shotsAt(record, notes).map((s) => shotOutcome(s, height, record));
  return outcomes.includes(undefined) ? null : outcomes.filter((o) => o === "lost").length;
}

/** Who smashed `record`: the rival of the winning shot used in the same transaction. */
function winner(record: ChallengeNote, notes: ChallengeNote[], height: number): AccountFelts | undefined {
  const shot = shotsAt(record, notes).find((s) => s.consumedAt === record.consumedAt && shotOutcome(s, height, record) === "won");
  return shot?.storage.rival ?? undefined;
}

export type HistoryItem = { id: string; kind: "record" | "shot"; at: number; title: string; lines: string[]; tone: "pink" | "mint" | "" };

/** My finished games, newest first: my records and my shots once used (live ones stay on the cards). */
export function history(notes: ChallengeNote[], me: AccountFelts, height: number, name: (a: AccountFelts) => string): HistoryItem[] {
  const items: HistoryItem[] = [];
  for (const n of notes) {
    if (n.consumedAt === undefined) continue;
    const base = { id: n.id, kind: n.kind, at: n.consumedAt };
    if (n.kind === "record" && same(n.storage.champion, me)) {
      const lost = triesLost(n, notes, height);
      if (lost === null) continue;
      const title = `${n.storage.target.toLocaleString()} pts`;
      if (recordOutcome(n, height) === "smashed") {
        const w = winner(n, notes, height);
        items.push({ ...base, title, lines: [`${w ? name(w) : "Someone"} beat it`, plural(lost, "try lost", "tries lost")], tone: "pink" });
      } else if (lost > 0) items.push({ ...base, title, lines: [plural(lost, "try lost", "tries lost")], tone: "mint" });
      else items.push({ ...base, title, lines: shotsAt(n, notes).length === 0 ? ["Nobody tried", "Taken back"] : ["Taken back"], tone: "" });
    } else if (n.kind === "shot" && same(n.storage.rival, me)) {
      const title = `${name(n.storage.champion)} / ${n.storage.target.toLocaleString()}`;
      const record = recordOf(n, notes);
      if (shotOutcome(n, height, record) === "lost") {
        items.push({ ...base, title, lines: [`Lost ${fmtGeocoin(n.amount)}`], tone: "pink" });
        continue;
      }
      // the prize comes with the shot in one transaction: same block
      if (record && record.consumedAt === n.consumedAt) items.push({ ...base, title, lines: ["Smashed it!", `Got ${fmtGeocoin(n.amount + record.amount)}`], tone: "mint" });
      else items.push({ ...base, title, lines: ["Got my Geocoin back"], tone: "" });
    }
  }
  return items.sort((a, b) => b.at - a.at);
}

export type Ranked = { key: string; who: AccountFelts; value: number; at: number; rank: number };
/** The top 10, and my best row when I am not among them. */
export type Board = { top: Ranked[]; mine: Ranked | null };
type Event = { who: AccountFelts; value: number; at: number };

/** Totals per player; a total's `at` is the block it reached its final value. */
function tally(events: Event[]): Omit<Ranked, "rank">[] {
  const rows = new Map<string, Omit<Ranked, "rank">>();
  for (const e of [...events].sort((a, b) => a.at - b.at)) {
    const key = keyOf(e.who);
    rows.set(key, { key, who: e.who, value: (rows.get(key)?.value ?? 0) + e.value, at: e.at });
  }
  return [...rows.values()];
}

/** High to low; a tie goes to whoever got there first. */
function rank(rows: Omit<Ranked, "rank">[], me: AccountFelts | null): Board {
  const sorted = [...rows].sort((a, b) => b.value - a.value || a.at - b.at || (a.key < b.key ? -1 : 1)).map((r, i) => ({ ...r, rank: i + 1 }));
  const top = sorted.slice(0, 10);
  const mine = top.some((r) => same(r.who, me)) ? null : (sorted.find((r) => same(r.who, me)) ?? null);
  return { top, mine };
}

/**
 * The four boards. Geocoins won: lost shots a champion took, plus prizes (a winner's own Geocoin
 * coming back is not a win). Best records: every record posted, by its score. Defended: every rival who lost at
 * one of the champion's records, open or not. Smashed: records a rival took.
 */
export function boards(notes: ChallengeNote[], height: number, me: AccountFelts | null) {
  const gc = (v: bigint) => Number(v) / 10 ** GC_DECIMALS;
  const coins: Event[] = [];
  const defended: Event[] = [];
  const smashed: Event[] = [];
  for (const n of notes) {
    if (n.kind === "shot") {
      if (shotOutcome(n, height, recordOf(n, notes)) !== "lost") continue;
      defended.push({ who: n.storage.champion, value: 1, at: shotDeadline(n.storage) });
      if (n.consumedAt !== undefined) coins.push({ who: n.storage.champion, value: gc(n.amount), at: n.consumedAt });
      continue;
    }
    const outcome = recordOutcome(n, height);
    const w = outcome === "smashed" ? winner(n, notes, height) : undefined;
    if (w) {
      coins.push({ who: w, value: gc(n.amount), at: n.consumedAt! });
      smashed.push({ who: w, value: 1, at: n.consumedAt! });
    }
  }
  const records = notes.filter((n) => n.kind === "record").map((n) => ({ key: n.id, who: n.storage.champion, value: n.storage.target, at: n.createdAt ?? Infinity }));
  return { coins: rank(tally(coins), me), records: rank(records, me), defended: rank(tally(defended), me), smashed: rank(tally(smashed), me) };
}

/** A time, arcade style and local: TODAY 18:42, YESTERDAY 21:10, TOMORROW 09:05, 08 OCT 20:14. */
export function whenLabel(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const pad = (v: number) => String(v).padStart(2, "0");
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const midnight = (t: Date) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const days = Math.round((midnight(new Date(now)) - midnight(d)) / 86_400_000);
  if (days === 0) return `TODAY ${time}`;
  if (days === 1) return `YESTERDAY ${time}`;
  if (days === -1) return `TOMORROW ${time}`;
  return `${pad(d.getDate())} ${d.toLocaleString("en", { month: "short" }).toUpperCase()} ${time}`;
}
