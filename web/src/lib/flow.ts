// The app's decisions, as pure functions so they can be tested without React, WASM or Bread.
// Every rule here was once a bug in the component.

import type { GqNote } from "./chain";
import { shotDeadline, type AccountFelts } from "./notes";
import type { Place } from "./quiz";
import { GC_DECIMALS } from "@/config";
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
 * When to hand a Bread request over, in ms after the app sees a new block N; the request binds
 * block N + 1. Bread 1.17.1 fails a dApp request unless the bound block is the height its
 * pre-approval check synced to (its queue anchors there after approval, without syncing again),
 * and the dApp never hears of the failure. Measured 2026-10-09: blocks every 3.00 s (±40 ms);
 * sending right at a new block, Bread synced to that block once and to the next one three times,
 * so its sync lands ~2-3 s after the hand-over, on a block edge. Handing over ~2 s into block N
 * puts it in the middle of block N + 1. A delay that landed is kept; after one that never showed
 * on chain the next candidate is tried (earlier, then later), remembered per browser.
 */
export const SEND_DELAYS_MS = [2000, 1000, 2700];
export const nextDelayIndex = (index: number, landed: boolean) => (landed ? index : (index + 1) % SEND_DELAYS_MS.length);

/**
 * The wallet took the request but the chain never showed its effect. Bread answers a dApp as soon
 * as the user approves and can still fail afterwards in its own queue, without telling the dApp.
 */
export const NOT_FINISHED = "Your wallet did not finish. Open it to see why, then try again.";

export type TroubleKind =
  | "said-no"
  | "no-wallet"
  | "funds"
  | "out-of-step"
  | "not-finished"
  | "network"
  | "not-found"
  | "too-late"
  | "other-cities"
  | "refused"
  | "unknown";
/** What went wrong, in one plain sentence, plus the raw text for "What happened?". */
export type Trouble = { kind: TroubleKind; title: string; detail?: string };

const message = (e: unknown) => (e instanceof Error ? `${e.name !== "Error" ? `${e.name}: ` : ""}${e.message}` : String(e));

/** Turns any failure into words a player understands. The raw text stays in `detail`. */
export function explain(e: unknown): Trouble {
  const raw = message(e);
  const t = (kind: TroubleKind, title: string, withDetail = true): Trouble => (withDetail && raw && raw !== title ? { kind, title, detail: raw } : { kind, title });
  if (raw.includes(NOT_FINISHED)) return t("not-finished", NOT_FINISHED, false);
  if (/NOT_GRANTED|reject|declin|denied|cancel/i.test(raw)) return t("said-no", "You said no in your wallet. Nothing was sent.");
  if (/WalletNotReady|not installed/i.test(raw)) return t("no-wallet", "We can't find the Bread wallet. Install it, then try again.");
  if (/WalletNotConnected|not connected|WalletDisconnected/i.test(raw)) return t("no-wallet", "Connect your wallet first.");
  if (/^(\w+: )?You need .*Geocoin/.test(raw)) return t("funds", raw.replace(/^\w+: /, ""), false);
  if (/SummaryAnchorMismatch|chain anchor|ChainBehindBoundBlock|block header for block \d+ not found/i.test(raw))
    return t("out-of-step", "Your wallet was out of step with the network. Try again.");
  if (/deadline has passed|too late|is over/i.test(raw)) return t("too-late", "Too late: this one is over.");
  if (/quiz does not match|dataset/i.test(raw)) return t("other-cities", "This record uses another city list. It can't be played here.");
  if (/not found on chain|is not public|not a GeoQuizz|Not found/i.test(raw)) return t("not-found", "We can't find that record. Check the link.");
  if (/assertion failed|error code/i.test(raw)) return t("refused", "The game said no to this move.");
  if (/fetch|network|timed out|timeout|deadline exceeded|unavailable|transport|ECONN|50[234]|load failed|faucet/i.test(raw))
    return t("network", "The Miden network is slow or busy right now. Try again in a moment.");
  return t("unknown", "Something went wrong.");
}

/** Rejects with "<what> timed out" (a network trouble) when `p` takes longer than `ms`. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

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

/** An amount of Geocoin in words: "1 Geocoin", "10 Geocoins". */
export function fmtGeocoin(v: bigint): string {
  const n = Number(v) / 10 ** GC_DECIMALS;
  return `${n.toLocaleString(undefined, { maximumFractionDigits: GC_DECIMALS })} Geocoin${n === 1 ? "" : "s"}`;
}

/** The page's address without the record it was opened for (other parameters, like ?local=, stay). */
export function withoutRecord(href: string): string {
  const url = new URL(href);
  url.searchParams.delete("record");
  url.searchParams.delete("prize");
  return url.toString();
}

/** The shareable link to a record, and the X post that carries it. */
export function recordLinks(recordId: string, score: number) {
  const url = `${location.origin}${location.pathname}?record=${recordId}`;
  const text = `${score} points on GeoQuizz (@0xMiden). Beat my record:`;
  return { url, x: `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}` };
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
