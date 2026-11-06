// Past games and the public leaderboards, read from the game's public notes: nobody reports a
// result, the chain tells how each record and shot ended. Pure: notes (with the blocks they were
// made and consumed in) come in, rows come out.

import type { ChallengeNote } from "./chain";
import { fmtGamecoin, pad, sameAccount as same, toGc } from "./flow";
import { gameStage } from "./quiz";
import { isShotAt, noteDeadline, shotDeadline, type AccountFelts } from "./notes";
import { CLAIM_FUZZ } from "@/config";
import { en, type T } from "./i18n";

export const keyOf = (a: AccountFelts) => `${a.prefix}:${a.suffix}`;

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
 * How a shot ended. Before its deadline only its rival can consume it, and only with a winning
 * answer; a claim proved before the deadline lands at most CLAIM_FUZZ blocks after it, and the
 * champion may only collect from deadline + CLAIM_FUZZ on. So the block it was consumed in tells:
 * won up to there, taken after. undefined while the node has not said when it was consumed.
 */
export function shotOutcome(shot: ChallengeNote, height: number): "won" | "lost" | "open" | undefined {
  const deadline = shotDeadline(shot.storage);
  if (!shot.consumed) return height >= deadline ? "lost" : "open";
  if (shot.consumedAt === undefined) return undefined;
  return shot.consumedAt <= deadline + CLAIM_FUZZ ? "won" : "lost";
}

/**
 * What the champion `me` can take now: their open records and the lost shots at them, CLAIM_FUZZ
 * blocks past the deadline (a claim proved just before it lands until then). A shot I posted at
 * my own record never: its script serves the rival first.
 */
export function owed(notes: ChallengeNote[], height: number, me: AccountFelts | null): ChallengeNote[] {
  if (!me) return [];
  return notes.filter((n) => !n.consumed && same(me, n.storage.champion) && !(n.kind === "shot" && same(me, n.storage.rival)) && height >= noteDeadline(n) + CLAIM_FUZZ);
}

/** How a record ended: smashed (consumed before the champion could take it back, which only a winner can do), closed (expired) or open. */
export function recordOutcome(record: ChallengeNote, height: number): "smashed" | "closed" | "open" | undefined {
  const expiry = record.storage.expiryBlock;
  const takeBack = expiry + CLAIM_FUZZ + 1;
  if (record.consumed) return record.consumedAt === undefined ? undefined : record.consumedAt < takeBack ? "smashed" : "closed";
  return height >= expiry ? "closed" : "open";
}

// a shot belongs to a record by its full terms (isShotAt), not its record id alone
const shotsAt = (record: ChallengeNote, notes: ChallengeNote[]) => notes.filter((n) => n.kind === "shot" && isShotAt(n.storage, record.storage, record.idWord));
const recordOf = (shot: ChallengeNote, notes: ChallengeNote[]) => notes.find((n) => n.kind === "record" && isShotAt(shot.storage, n.storage, n.idWord));

/** Shots at `record` lost so far, or null while one of them waits for the node. */
export function triesLost(record: ChallengeNote, notes: ChallengeNote[], height: number): number | null {
  const outcomes = shotsAt(record, notes).map((s) => shotOutcome(s, height));
  return outcomes.includes(undefined) ? null : outcomes.filter((o) => o === "lost").length;
}

/** Who smashed `record`: the rival of the winning shot consumed in the same transaction. */
function winner(record: ChallengeNote, notes: ChallengeNote[], height: number): AccountFelts | undefined {
  const shot = shotsAt(record, notes).find((s) => s.consumedAt === record.consumedAt && shotOutcome(s, height) === "won");
  return shot?.storage.rival ?? undefined;
}

/** Gamecoins a champion took from shots lost at `record`: the lost ones already consumed. */
const collected = (record: ChallengeNote, notes: ChallengeNote[], height: number) =>
  shotsAt(record, notes).reduce((sum, s) => (s.consumedAt !== undefined && shotOutcome(s, height) === "lost" ? sum + s.amount : sum), 0n);

type Tone = "pink" | "mint" | "";
/**
 * A past game: the result leads, `context` is what comes before the score (whose record it was),
 * `money` is what came in or went out, `note` the small line under it. Never a rival's exact score.
 */
export type HistoryItem = { id: string; kind: "record" | "shot"; at: number; result: string; context: string; score: number; /** the map, a t() key (stageTag) */ tag?: string; detail: string; money: string; note: string; tone: Tone; moneyTone: Tone };

/** My finished games, newest first: my records and my shots once consumed (live ones stay on the cards). Lines in the language of `t`. */
export function history(notes: ChallengeNote[], me: AccountFelts, height: number, name: (a: AccountFelts) => string, t: T = en): HistoryItem[] {
  const items: HistoryItem[] = [];
  const gc = (v: bigint) => fmtGamecoin(v, t);
  for (const n of notes) {
    // a shot of mine past its deadline is lost before anyone touches it: history from the deadline on
    const lostOnTable = n.kind === "shot" && !n.consumed && same(n.storage.rival, me) && shotOutcome(n, height) === "lost";
    if (lostOnTable) {
      const who = name(n.storage.champion);
      // the shot script serves its rival first: a shot at my own record stays locked past its deadline
      const note = same(n.storage.champion, me) ? t("Locked: this shot was at your own record.") : t("{who} can take the coin.", { who });
      items.push({ id: n.id, kind: "shot", at: shotDeadline(n.storage), score: n.storage.target, tag: stageTag(n.storage.game), result: t("You lost"), context: t("{who}'s record: ", { who }), detail: "", money: t("{gc} lost", { gc: gc(n.amount) }), note, tone: "pink", moneyTone: "pink" });
      continue;
    }
    if (n.consumedAt === undefined) continue;
    const base = { id: n.id, kind: n.kind, at: n.consumedAt, score: n.storage.target, tag: stageTag(n.storage.game), context: "", detail: "", note: "" };
    if (n.kind === "record" && same(n.storage.champion, me)) {
      const lost = triesLost(n, notes, height);
      if (lost === null) continue;
      const won = collected(n, notes, height);
      const tries = lost === 1 ? t("1 try lost") : t("{n} tries lost", { n: lost });
      if (recordOutcome(n, height) === "smashed") {
        const w = winner(n, notes, height);
        const who = w ? name(w) : t("Someone");
        // the prize is lost either way; what earlier losers paid stands next to it, never instead of it
        const money = won > 0n ? { money: t("{won} won, {lost} lost", { won: gc(won), lost: gc(n.amount) }), moneyTone: "" as const } : { money: t("{gc} lost", { gc: gc(n.amount) }), moneyTone: "pink" as const };
        items.push({ ...base, result: t("Beaten"), context: t("{who} beat ", { who }), detail: tries, tone: "pink", note: t("Prize went to {who}.", { who }), ...money });
      } else if (lost > 0) {
        const money = won > 0n ? { money: t("{gc} won", { gc: gc(won) }), moneyTone: "mint" as const, note: t("Your Gamecoin back.") } : { money: t("{gc} back", { gc: gc(n.amount) }), moneyTone: "" as const };
        items.push({ ...base, result: t("Defended"), detail: tries, tone: "mint", ...money });
      } else items.push({ ...base, result: t("Taken back"), detail: shotsAt(n, notes).length === 0 ? t("Nobody tried.") : "", money: t("{gc} back", { gc: gc(n.amount) }), tone: "", moneyTone: "" });
    } else if (n.kind === "shot" && same(n.storage.rival, me)) {
      const who = name(n.storage.champion);
      const record = recordOf(n, notes);
      const shot = { ...base, context: t("{who}'s record: ", { who }) };
      if (shotOutcome(n, height) === "lost") items.push({ ...shot, result: t("You lost"), money: t("{gc} lost", { gc: gc(n.amount) }), note: t("Went to {who}.", { who }), tone: "pink", moneyTone: "pink" });
      // the prize comes with the shot in one transaction: same block
      else if (record && record.consumedAt === n.consumedAt) items.push({ ...shot, result: t("You won"), money: t("{gc} won", { gc: gc(record.amount) }), note: t("Your Gamecoin back."), tone: "mint", moneyTone: "mint" });
      else items.push({ ...shot, result: t("You won"), detail: record && record.consumedAt !== undefined && record.consumedAt < n.consumedAt ? t("Prize already taken.") : "", money: t("{gc} back", { gc: gc(n.amount) }), tone: "mint", moneyTone: "" });
    }
  }
  return items.sort((a, b) => b.at - a.at);
}

export type Ranked = { key: string; who: AccountFelts; value: number; at: number; rank: number; /** a record's map, a t() key (stageTag) */ tag?: string };
/** The top ten rows, and my best row when I am not among them. */
type Board = { top: Ranked[]; mine: Ranked | null; /** the records board again, per map */ byMap?: Record<string, Board> };
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

/** High to low, the first `limit` rows; a tie goes to whoever got there first. */
function rank(rows: Omit<Ranked, "rank">[], me: AccountFelts | null, limit = 10): Board {
  const sorted = [...rows].sort((a, b) => b.value - a.value || a.at - b.at || (a.key < b.key ? -1 : 1)).map((r, i) => ({ ...r, rank: i + 1 }));
  const top = sorted.slice(0, limit);
  const mine = top.some((r) => same(r.who, me)) ? null : (sorted.find((r) => same(r.who, me)) ?? null);
  return { top, mine };
}

/** A record's map for a row: the stage's name, a t() key; none for an unknown list. */
export const stageTag = (game: bigint[]): string | undefined => gameStage(game)?.name;

/**
 * The four boards. Gamecoins won: lost shots a champion took, plus prizes (a winner's own Gamecoin
 * coming back is not a win). Best records: every record posted, by its score. Defended: every rival who lost at
 * one of the champion's records, open or not. Smashed: records a rival took. Losers: shots a rival
 * lost, the other side of Defended.
 */
export function boards(notes: ChallengeNote[], height: number, me: AccountFelts | null) {
  const coins: Event[] = [];
  const defended: Event[] = [];
  const smashed: Event[] = [];
  const losers: Event[] = [];
  for (const n of notes) {
    if (n.kind === "shot") {
      const record = recordOf(n, notes);
      if (!record || shotOutcome(n, height) !== "lost") continue;
      defended.push({ who: n.storage.champion, value: 1, at: shotDeadline(n.storage) });
      if (n.storage.rival) losers.push({ who: n.storage.rival, value: 1, at: shotDeadline(n.storage) });
      if (n.consumedAt !== undefined) coins.push({ who: n.storage.champion, value: toGc(n.amount), at: n.consumedAt });
      continue;
    }
    const outcome = recordOutcome(n, height);
    const w = outcome === "smashed" ? winner(n, notes, height) : undefined;
    if (w) {
      coins.push({ who: w, value: toGc(n.amount), at: n.consumedAt! });
      smashed.push({ who: w, value: 1, at: n.consumedAt! });
    }
  }
  const records = notes.filter((n) => n.kind === "record").map((n) => ({ key: n.id, who: n.storage.champion, value: n.storage.target, at: n.createdAt ?? Infinity, tag: stageTag(n.storage.game) }));
  const maps = [...new Set(records.map((r) => r.tag).filter((tag): tag is string => !!tag))];
  const byMap = Object.fromEntries(maps.map((tag) => [tag, rank(records.filter((r) => r.tag === tag), me)]));
  return { coins: rank(tally(coins), me), records: { ...rank(records, me), byMap }, defended: rank(tally(defended), me), smashed: rank(tally(smashed), me), losers: rank(tally(losers), me) };
}

/** A time, arcade style and local: TODAY 18:42, YESTERDAY 21:10, TOMORROW 09:05, 08 OCT 20:14 (in Chinese 10月08日 20:14). */
export function whenLabel(ms: number, now = Date.now(), t: T = en): string {
  const d = new Date(ms);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(new Date(now)) - midnight(d)) / 86_400_000);
  if (days === 0) return t("TODAY {time}", { time });
  if (days === 1) return t("YESTERDAY {time}", { time });
  if (days === -1) return t("TOMORROW {time}", { time });
  return t("{dd} {MMM} {time}", { dd: pad(d.getDate()), MMM: d.toLocaleString("en", { month: "short" }).toUpperCase(), mm: d.getMonth() + 1, time });
}
