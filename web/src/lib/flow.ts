// The app's decisions, as pure functions so they can be tested without React, WASM or Bread.
// Every rule here was once a bug in the component.

import type { GqNote } from "./chain";
import { shotDeadline, type AccountFelts } from "./notes";
import type { Place } from "./quiz";
import { roundScore, type Answer, type City } from "./rules";

export const sameAccount = (a: AccountFelts | null | undefined, b: AccountFelts | null | undefined) =>
  !!a && !!b && a.suffix === b.suffix && a.prefix === b.prefix;

export const isOpen = (n: GqNote, height: number) =>
  !n.consumed && height < (n.kind === "shot" ? shotDeadline(n.storage) : n.storage.expiryBlock);

/** My unconsumed, unexpired shot notes at `record`: one play settles all of them. */
export function myOpenShotsOn(notes: GqNote[], me: AccountFelts | null, record: GqNote, height: number): GqNote[] {
  if (!me) return [];
  return notes.filter(
    (n) =>
      n.kind === "shot" &&
      sameAccount(me, n.storage.rival) &&
      n.storage.recordId.every((f, i) => f === record.idWord[i]) &&
      isOpen(n, height),
  );
}

export type SharedRecordState = "open" | "claimed" | "expired" | "mine" | "already-challenged";

/** What a `?record=<id>` landing page should offer. */
export function sharedRecordState(record: GqNote, me: AccountFelts | null, myOpen: GqNote[], height: number): SharedRecordState {
  if (record.consumed) return "claimed";
  if (height >= record.storage.expiryBlock) return "expired";
  if (sameAccount(me, record.storage.champion)) return "mine";
  if (myOpen.length > 0) return "already-challenged";
  return "open";
}

/** Why a shot cannot be taken right now, or null when it can. */
export function shotRefusal(record: GqNote, height: number, minWindow: number): string | null {
  if (record.consumed) return "This one is over.";
  if (record.storage.expiryBlock - height < minWindow) return "Too late for this one.";
  return null;
}

export type SettlePlan = { won: boolean; claimPrize: boolean; text: string };

/**
 * After a play: a win settles the open shots (and claims the prize if it is still there);
 * a loss sends nothing to the chain, the Geocoin waits for the champion at the deadline.
 */
export function settlePlan(shots: GqNote[], record: GqNote | undefined, score: number, height: number): SettlePlan {
  if (shots.length === 0) throw new Error("no shot note to settle");
  const target = shots[0].storage.target;
  const won = score > target;
  const claimPrize = won && !!record && !record.consumed && record.storage.expiryBlock > height;
  const text = claimPrize
    ? `${score} points. You win!`
    : won
      ? `${score} points. You beat it, but the prize is gone. Your Geocoin comes back.`
      : `${score} points. Not enough. Your Geocoin goes to the champion.`;
  return { won, claimPrize, text };
}

/** The two block commitments in Bread's anchor-mismatch message: the one we bound, the one it anchored. */
export function parseAnchorMismatch(e: unknown): { bound: string; anchor: string } | null {
  const m = /binds block commitment (0x[0-9a-f]+) but the captured chain anchor is (0x[0-9a-f]+)/i.exec(e instanceof Error ? e.message : String(e));
  return m ? { bound: m[1].toLowerCase(), anchor: m[2].toLowerCase() } : null;
}

/**
 * Bread's height relative to the block we bound: the block near `boundBlock` whose commitment is
 * `anchor`. `commitmentOf(n)` reads a header from the node. Null when no nearby block matches.
 */
export async function learnBreadOffset(
  boundBlock: number,
  anchor: string,
  commitmentOf: (n: number) => Promise<string | null>,
  radius = 8,
): Promise<number | null> {
  for (let d = 0; d <= radius; d++) {
    for (const n of d === 0 ? [boundBlock] : [boundBlock + d, boundBlock - d]) {
      if (n < 0) continue;
      if ((await commitmentOf(n))?.toLowerCase() === anchor) return n - boundBlock;
    }
  }
  return null;
}

/**
 * The wallet took the request but the chain never showed its effect. Bread answers a dApp as soon
 * as the user approves and can still fail afterwards in its own queue, without telling the dApp.
 */
export const NOT_FINISHED = "Your wallet did not finish. Open it to see why, then try again.";

/** The outcome line after Bread accepted a request: only a chain-confirmed effect is "confirmed". */
export function outcomeText(action: string, seenOnChain: boolean): string {
  const sentence = /[.!?]$/.test(action) ? action : `${action}.`;
  return seenOnChain ? `${sentence} Done!` : `${action}… not done yet. Check your wallet.`;
}

/** Bread anchors its sync height a block or two after the dApp binds one; see bread.ts. */
export const isAnchorMismatch = (e: unknown) =>
  /SummaryAnchorMismatch|captured chain anchor|ChainBehindBoundBlock|has not reached that block/i.test(e instanceof Error ? e.message : String(e));

/**
 * Submits with a fresh bound block per attempt, retrying only on Bread's anchor mismatch.
 * `attempt(offset, n)` builds at the fresh tip plus `offset`, submits, and must throw on failure.
 * After a mismatch, `offsetFromError(e)` may tell by how many blocks Bread was off; the next
 * attempt corrects by that amount, otherwise it alternates offset and offset + 1.
 */
export async function submitWithRetry<T>(
  attempt: (offset: number, n: number) => Promise<T>,
  expectedLag: number,
  retries: number,
  offsetFromError: (e: unknown) => Promise<number | null> = async () => null,
): Promise<T> {
  let offset = expectedLag;
  for (let n = 1; ; n++) {
    try {
      return await attempt(offset, n);
    } catch (e) {
      if (!isAnchorMismatch(e) || n >= retries) throw e;
      const learned = await offsetFromError(e);
      offset = learned === null ? expectedLag + (n % 2) : offset + learned;
    }
  }
}

export type ReportRow = { name: string; seconds: string; points: number };

/** The run report: one row per city, time as the player saw it, points as the chain scores them. */
export function reportRows(cities: City[], answers: Answer[], places: Place[]): ReportRow[] {
  return cities.map((c, i) => ({
    name: places[c.idx]?.name ?? `city #${c.idx}`,
    seconds: `${(answers[i].t / 100).toFixed(1)}s`,
    points: roundScore(c, answers[i]),
  }));
}

/**
 * What a pasted code means: a record id from a GeoQuizz link, from our X share link (the GeoQuizz
 * link travels inside it, URL-encoded), or typed as is. A posted X status URL cannot be read from
 * the browser, so it gets a hint instead.
 */
export function parseCode(text: string): { id: string } | { hint: string } {
  const decoded = (() => {
    try {
      return decodeURIComponent(text);
    } catch {
      return text;
    }
  })();
  const id = /0x[0-9a-f]{64}/i.exec(decoded)?.[0];
  if (id) return { id: id.toLowerCase() };
  if (/x\.com\/[^/]+\/status\/|twitter\.com\/[^/]+\/status\//i.test(text)) return { hint: "Open the post and copy the GeoQuizz link." };
  return { hint: "That is not a GeoQuizz code." };
}
