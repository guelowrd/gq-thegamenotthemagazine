// The app's decisions, as pure functions so they can be tested without React, WASM or Bread.

import type { ChallengeNote } from "./chain";
import { noteDeadline, shotDeadline, ZERO_WORD, type AccountFelts, type ChallengeStorage, type Word4 } from "./notes";
import type { Place } from "./quiz";
import { BLOCK_SECONDS, CLAIM_FUZZ, GC_DECIMALS, GC_FAUCET, MIN_SHOT_WINDOW_BLOCKS, RECORD_LIFETIME_BLOCKS, STAKE } from "@/config";
import { QUIZ_MAX, roundScore, type Answer, type City } from "./rules";
import { en, translator, type T } from "./i18n";
import type { Stage } from "./stages";

export const sameAccount = (a: AccountFelts | null | undefined, b: AccountFelts | null | undefined) =>
  !!a && !!b && a.suffix === b.suffix && a.prefix === b.prefix;

const isOpen = (n: ChallengeNote, height: number) => !n.consumed && height < noteDeadline(n);

/** My unconsumed, unexpired shot notes at `record`: one play settles all of them. */
export function myOpenShotsOn(notes: ChallengeNote[], me: AccountFelts | null, record: ChallengeNote, height: number): ChallengeNote[] {
  if (!me) return [];
  return notes.filter(
    (n) =>
      n.kind === "shot" &&
      sameAccount(me, n.storage.rival) &&
      sameWord(n.storage.recordId, record.idWord) &&
      isOpen(n, height),
  );
}

export type SharedRecordState = "open" | "claimed" | "expired" | "mine" | "already-challenged";

/** What a `?record=<id>` landing page should offer. */
export function sharedRecordState(record: ChallengeNote, me: AccountFelts | null, myOpen: ChallengeNote[], height: number): SharedRecordState {
  if (record.consumed) return "claimed";
  if (height >= record.storage.expiryBlock) return "expired";
  if (sameAccount(me, record.storage.champion)) return "mine";
  if (myOpen.length > 0) return "already-challenged";
  return "open";
}

/** Why a shot cannot be taken right now, or null when it can. */
export function shotRefusal(record: ChallengeNote, height: number, me?: AccountFelts | null): string | null {
  if (record.consumed) return "This one is over.";
  // the record script runs the champion's path for its own champion: a shot of theirs could never claim it
  if (sameAccount(me, record.storage.champion)) return "This one is yours.";
  if (record.storage.expiryBlock - height < MIN_SHOT_WINDOW_BLOCKS) return "Too late for this one.";
  const { target, minStake, expiryBlock } = record.storage;
  // terms this game never writes: an unbeatable target, another stake, a record that outlives its day
  if (target >= QUIZ_MAX || minStake !== STAKE || expiryBlock > height + RECORD_LIFETIME_BLOCKS) return "This one is rigged.";
  return null;
}

export const sameWord = (a: Word4, b: Word4) => a.every((f, i) => f === b[i]);

export type NoteKind = { kind: "record"; shotRoot: string } | { kind: "shot" };

/** What a note script root means to this app: a record (and the shot script its shots run), a shot, or null for a foreign note. */
export function noteKind(root: string, current: { recordRoot: string; shotRoot: string }): NoteKind | null {
  if (root === current.recordRoot) return { kind: "record", shotRoot: current.shotRoot };
  if (root === current.shotRoot) return { kind: "shot" };
  return null;
}

/**
 * Whether a note the node serves under our tag with one of our script roots is one of ours: posted
 * by the account it names (the sender is set by the kernel, the storage by whoever made the note),
 * carrying exactly one asset, a Gamecoin, and shaped the way this app writes it. A record names
 * `shotRoot`, the shot script of its own version, so no stranger's script gets to settle shots at it.
 */
export function acceptNote(n: { kind: "record" | "shot"; storage: ChallengeStorage; sender: AccountFelts; assets: { faucet: string; amount: bigint }[] }, shotRoot?: Word4): boolean {
  if (n.assets.length !== 1 || n.assets[0].faucet !== GC_FAUCET) return false;
  const s = n.storage;
  if (n.kind === "record") return sameAccount(n.sender, s.champion) && !s.rival && s.shotDeadline === 0 && sameWord(s.recordId, ZERO_WORD) && !!shotRoot && sameWord(s.shotRoot, shotRoot);
  return sameAccount(n.sender, s.rival) && !sameWord(s.recordId, ZERO_WORD);
}

/** `again`: a lost shot still open, so the same quiz can be played once more for free. */
export type SettlePlan = { won: boolean; claimPrize: boolean; again: boolean; text: string };

/**
 * After a play: a win settles the open shots (and claims the prize if it is still there);
 * a loss sends nothing to the chain, the Gamecoin waits for the champion at the deadline.
 */
export function settlePlan(shots: ChallengeNote[], record: ChallengeNote | undefined, score: number, height: number, t: T = en): SettlePlan {
  if (shots.length === 0) throw new Error("no shot note to settle");
  const target = shots[0].storage.target;
  const won = score > target;
  const claimPrize = won && !!record && !record.consumed && record.storage.expiryBlock > height;
  const again = !won && height < shotDeadline(shots[0].storage);
  const text = claimPrize
    ? t("{score} points. You win!", { score })
    : won
      ? t("{score} points. You beat it, but the prize is gone. Your Gamecoin comes back.", { score })
      : again
        ? t("{score} points. Not enough.", { score })
        : t("{score} points. Not enough. Your Gamecoin goes to the champion.", { score });
  return { won, claimPrize, again, text };
}

/**
 * The wallet took the request but the chain never showed its effect. Bread answers a dApp as soon
 * as the user approves and can still fail afterwards in its own queue, without telling the dApp.
 */
export const NOT_FINISHED = "It did not go through yet. Nothing is spent until it does, so try again.";

/** A block count as m:ss, at testnet's ~3 s per block. */
export const blocksToClock = (blocks: number) => secondsToClock(Math.round(Math.max(0, blocks) * BLOCK_SECONDS));

/** When `block` lands, in ms, counting from `height` (the chain's current block) at testnet's pace. */
export const blockToMs = (block: number, height: number) => Date.now() + (block - height) * BLOCK_SECONDS * 1000;

export const pad = (v: number) => String(v).padStart(2, "0");

/** m:ss, or h:mm:ss from an hour on. */
export const secondsToClock = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h ? `${h}:${pad(m)}` : m}:${pad(s % 60)}`;
};

/**
 * Before sending a claim: what the chain already says about the shot(s). Before its deadline only
 * the rival can consume a shot, and only with a winning answer; from deadline + CLAIM_FUZZ on only
 * the champion. So a shot consumed up to there was claimed by its rival, one consumed later was taken.
 */
export function claimVerdict(shots: { consumedAt?: number; deadline: number }[]): "open" | "claimed" | "lost" {
  // the champion collects from deadline + CLAIM_FUZZ; a shot consumed earlier was ours
  if (shots.some((s) => s.consumedAt !== undefined && s.consumedAt >= s.deadline + CLAIM_FUZZ + 1)) return "lost";
  if (shots.length > 0 && shots.every((s) => s.consumedAt !== undefined)) return "claimed";
  return "open";
}
export const SHOT_LOST = "Too late: your shot ended before the claim. The champion can take your Gamecoin.";

export type TroubleKind =
  | "said-no"
  | "no-wallet"
  | "funds"
  | "out-of-step"
  | "not-finished"
  | "network"
  | "not-found"
  | "already-done"
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
  const trouble = (kind: TroubleKind, title: string, withDetail = true): Trouble => (withDetail && raw && raw !== title ? { kind, title, detail: raw } : { kind, title });
  if (raw.includes(NOT_FINISHED)) return trouble("not-finished", NOT_FINISHED, false);
  if (/NETWORK_NOT_GRANTED/.test(raw)) return trouble("refused", "Your wallet is on another network.");
  if (/NOT_GRANTED|reject|declin|denied|cancel/i.test(raw)) return trouble("said-no", "You said no in your wallet. Nothing was sent.");
  if (/WalletNotReady|not installed/i.test(raw)) return trouble("no-wallet", "Bread is your wallet: it inserts your Gamecoin to post a record or take a shot, and keeps track of your games.");
  if (/WalletNotConnected|not connected|WalletDisconnected/i.test(raw)) return trouble("no-wallet", "Connect your wallet first.");
  if (/SummaryAnchorMismatch|chain anchor|ChainBehindBoundBlock|block header for block \d+ not found/i.test(raw))
    return trouble("out-of-step", "Your wallet was out of step with the network. Try again.");
  if (/^Too late: /.test(raw)) return trouble("too-late", raw, false);
  if (/already been consumed|already consumed/i.test(raw)) return trouble("already-done", "This was already done.");
  if (/deadline has passed|too late|is over/i.test(raw)) return trouble("too-late", "Too late: this one is over.");
  if (/quiz does not match|dataset/i.test(raw)) return trouble("other-cities", "This record uses another city list. It can't be played here.");
  if (/not found on chain|is not public|not a record or shot|not GeoQuizz game data|Not found/i.test(raw)) return trouble("not-found", "We can't find that record. Check the link.");
  if (/assertion failed|error code/i.test(raw)) return trouble("refused", "The game said no to this move.");
  if (/fetch|network|timed out|timeout|deadline exceeded|unavailable|transport|ECONN|50[234]|load failed|faucet|mempool|transaction expired|expired at block/i.test(raw)) // expired: a mainnet transaction has about 65 s to land
    return trouble("network", "The game is slow right now. Try again in a moment.");
  return trouble("unknown", "Something went wrong.");
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
export function outcomeText(action: string, seenOnChain: boolean, t: T = en): string {
  const sentence = /[.!?]$/.test(action) ? action : `${action}.`;
  return seenOnChain ? t("{sentence} Done!", { sentence }) : t("{action}… not done yet. Check your wallet.", { action });
}

/** Bread had not synced up to the block the request binds yet. */
export const isChainBehind = (e: unknown) => /ChainBehindBoundBlock|has not reached that block/i.test(e instanceof Error ? e.message : String(e));

/** Submits up to `retries` times, retrying only while Bread is behind; `attempt(n)` rebuilds at the fresh tip. */
export async function submitWithRetry<T>(attempt: (n: number) => Promise<T>, retries: number): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await attempt(n);
    } catch (e) {
      if (!isChainBehind(e) || n >= retries) throw e;
    }
  }
}

/** Base units to Gamecoins: 1_000_000n is 1. */
export const toGc = (v: bigint) => Number(v) / 10 ** GC_DECIMALS;

/** An amount of Gamecoin in words: "1 Gamecoin", "10 Gamecoins". */
export function fmtGamecoin(v: bigint, t: T = en): string {
  const n = toGc(v);
  return t(n === 1 ? "{n} Gamecoin" : "{n} Gamecoins", { n: n.toLocaleString(undefined, { maximumFractionDigits: GC_DECIMALS }) });
}

/** The page's address without the record it was opened for (other parameters, like ?local=, stay). */
export function withoutRecord(href: string): string {
  const url = new URL(href);
  url.searchParams.delete("record");
  return url.toString();
}

/** A moment in UTC, for readers anywhere: 13 Oct 14:05 UTC. */
function utcLabel(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCDate())} ${d.toLocaleString("en", { month: "short", timeZone: "UTC" })} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

// the X post: one of these, the record picks which (so a record always shares the same line); the link follows on its own line
const POSTS: ((score: number, until: string, gq: string) => string)[] = [
  (score, until, gq) => `${score} points on ${gq} 😎\nInstall @joinbread & beat my record before ${until}.`,
  (score, until, gq) => `My ${gq} record: ${score} points, open until ${until}.\nInstall @joinbread & beat it.`,
  (score, until, gq) => `${score} points on ${gq}. One Gamecoin says you can't beat it before ${until}.\nInstall @joinbread & prove me wrong.`,
  (score, until, gq) => `Know your geography? ${score} points to beat on ${gq} until ${until}.\nInstall @joinbread & take a shot.`,
  (score, until, gq) => `10 cities, 15 seconds each, ${score} points on ${gq}. Your move, until ${until}.\nInstall @joinbread & play.`,
  (score, until, gq) => `Champion of ${gq} with ${score} points, for now. Record expires ${until}.\nInstall @joinbread & come take it.`,
  (score, until, gq) => `I set ${score} points on ${gq}. Beat it before ${until} and my Gamecoin is yours.\nInstall @joinbread & try.`,
  (score, until, gq) => `Rivals wanted: ${score} points on ${gq}, open until ${until} 🌍\nInstall @joinbread & take your shot.`,
];

// a run with one of these gets a line about it: hard ones to brag, easy ones to tease
const HARD_CITIES = ["Funafuti", "Palikir", "Melekeok", "Majuro", "Tarawa", "Nuku'alofa", "Apia", "Honiara", "Port Vila", "Moroni", "Malé", "Bir Lehlou", "Lobamba", "Mbabane", "Maseru", "Sri Jayawardenepura Kotte", "Bandar Seri Begawan", "Naypyidaw", "Thimphu", "Ashgabat", "Dushanbe", "Bishkek", "Nur-Sultan", "Dili", "Basseterre", "Castries", "Roseau", "Kingstown", "Saint George's", "Saint John's", "Belmopan", "Paramaribo", "Bujumbura", "Lilongwe", "Gaborone", "Bissau", "Banjul", "Praia", "São Tomé", "Malabo", "Hargeisa", "Laayoune", "Vaduz", "Podgorica", "Chișinău", "Sucre", "Putrajaya", "Ürümqi", "Baguio", "Dodoma", "Bloemfontein"];
const EASY_CITIES = ["Paris", "London", "New York", "Tokyo", "Rome", "Berlin", "Madrid", "Moscow", "Beijing", "Sydney", "Cairo", "Rio de Janeiro", "Los Angeles", "San Francisco", "Dubai", "Istanbul", "Amsterdam", "Singapore", "Hong Kong", "Mexico City", "Buenos Aires", "Lisbon", "Athens", "Mumbai", "Bangkok", "Seoul", "Shanghai", "Cape Town", "Toronto", "Chicago", "Miami", "Vienna", "Prague", "Dublin"];
const HARD_POSTS: ((score: number, until: string, city: string, gq: string) => string)[] = [
  (score, until, city, gq) => `${city}. Yes, I know where that is. ${score} points on ${gq} until ${until}.\nInstall @joinbread & find it faster.`,
  (score, until, city, gq) => `Can you place ${city} in 15 seconds? I did. ${score} points on ${gq} to beat before ${until}.\nInstall @joinbread & try.`,
];
const EASY_POSTS: ((score: number, until: string, city: string, gq: string) => string)[] = [
  (score, until, city, gq) => `You know where ${city} is, right? ${score} points to beat before ${until}.\nInstall @joinbread & play ${gq}.`,
  (score, until, city, gq) => `My run had ${city} in it. ${score} points on ${gq}, open until ${until}.\nInstall @joinbread & do better.`,
];

// the Weibo post, one line, the map's Chinese name after the game's
const WEIBO_POST = (score: number, map?: string) => `我在 GeoQuizz ${map ?? ""}得了 ${score} 分。来挑战我的纪录！`;

/**
 * The shareable link to a record, and the X post that carries it (the Weibo one too); `expiresAt`
 * is the record's expiry in ms, `cities` the English names of its run, `stage` the stage it was
 * played on (a region names the game: "GQ Europe", in Chinese on Weibo). A hard city gets bragged
 * about, an easy one teased with.
 */
/** The page inside Bread's phone app: Bread opens it from this link. The page rides in the fragment, which no server sees. */
export const breadLink = (page: string) => `https://bread.miden.xyz/open#url=${encodeURIComponent(page)}`;

export function recordLinks(recordId: string, score: number, expiresAt: number, cities: string[] = [], stage?: Stage) {
  const url = `${location.origin}${location.pathname}?record=${recordId}`;
  const pick = [...recordId].reduce((sum, c) => sum + c.charCodeAt(0), 0);
  const hard = cities.filter((c) => HARD_CITIES.includes(c));
  const easy = cities.filter((c) => EASY_CITIES.includes(c));
  const until = utcLabel(expiresAt);
  const region = stage && stage.id !== "world" ? stage.name : undefined;
  const gq = region ? `GQ ${region}` : "GQ";
  const text = hard.length
    ? HARD_POSTS[pick % HARD_POSTS.length](score, until, hard[pick % hard.length], gq)
    : easy.length
      ? EASY_POSTS[pick % EASY_POSTS.length](score, until, easy[pick % easy.length], gq)
      : POSTS[pick % POSTS.length](score, until, gq);
  return {
    url,
    // the link inside the text, on its own line: X turns it into the card, nothing is left hanging before it
    x: `https://x.com/intent/post?text=${encodeURIComponent(`${text}\n${url}`)}`,
    weibo: `https://service.weibo.com/share/share.php?url=${encodeURIComponent(url)}&title=${encodeURIComponent(WEIBO_POST(score, region && translator("zh-Hans")(region)))}`,
  };
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
