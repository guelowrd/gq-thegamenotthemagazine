// The app's decisions, as pure functions so they can be tested without React, WASM or Bread.
// Every rule here was once a bug in the component.

import type { GqNote } from "./chain";
import { challengeDeadline, type AccountFelts } from "./notes";

export const sameAccount = (a: AccountFelts | null | undefined, b: AccountFelts | null | undefined) =>
  !!a && !!b && a.suffix === b.suffix && a.prefix === b.prefix;

export const isOpen = (n: GqNote, height: number) =>
  !n.consumed && height < (n.kind === "challenge" ? challengeDeadline(n.storage) : n.storage.expiryBlock);

/** My unconsumed, unexpired challenge notes on `prize`: one play settles all of them. */
export function myOpenChallengesOn(notes: GqNote[], me: AccountFelts | null, prize: GqNote, height: number): GqNote[] {
  if (!me) return [];
  return notes.filter(
    (n) =>
      n.kind === "challenge" &&
      sameAccount(me, n.storage.player) &&
      n.storage.prizeId.every((f, i) => f === prize.idWord[i]) &&
      isOpen(n, height),
  );
}

export type SharedPrizeState = "open" | "claimed" | "expired" | "mine" | "already-challenged";

/** What a `?prize=<id>` landing page should offer. */
export function sharedPrizeState(prize: GqNote, me: AccountFelts | null, myOpen: GqNote[], height: number): SharedPrizeState {
  if (prize.consumed) return "claimed";
  if (height >= prize.storage.expiryBlock) return "expired";
  if (sameAccount(me, prize.storage.champion)) return "mine";
  if (myOpen.length > 0) return "already-challenged";
  return "open";
}

/** Why a challenge cannot be posted right now, or null when it can. */
export function challengeRefusal(prize: GqNote, height: number, minWindow: number): string | null {
  if (prize.consumed) return "This prize has already been claimed.";
  if (prize.storage.expiryBlock - height < minWindow) return "This prize expires too soon to challenge.";
  return null;
}

export type SettlePlan = { won: boolean; claimPrize: boolean; text: string };

/**
 * After a play: a win settles the open challenges (and claims the prize if it is still there);
 * a loss sends nothing to the chain, the stake waits for the champion at the deadline.
 */
export function settlePlan(challenges: GqNote[], prize: GqNote | undefined, score: number, height: number): SettlePlan {
  if (challenges.length === 0) throw new Error("no challenge note to settle");
  const target = challenges[0].storage.target;
  const won = score > target;
  const claimPrize = won && !!prize && !prize.consumed && prize.storage.expiryBlock > height;
  const n = challenges.length > 1 ? ` (${challenges.length} challenge notes)` : "";
  const deadline = Math.max(...challenges.map((c) => challengeDeadline(c.storage)));
  const text = claimPrize
    ? `You scored ${score} > ${target}. Claiming the prize and your stake${n}`
    : won
      ? `You scored ${score} > ${target}. Recovering your stake${n}`
      : `You scored ${score}, not above ${target}. Your stake goes to the champion when the challenge expires (block ${deadline}, ${Math.max(0, deadline - height)} blocks from now).`;
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

/** The outcome line after Bread accepted a request: only a chain-confirmed effect is "confirmed". */
export function outcomeText(action: string, seenOnChain: boolean): string {
  return seenOnChain
    ? `${action}: confirmed on chain`
    : `${action}: Bread accepted the request but the chain does not show it yet. Check Bread's activity; it may have failed there.`;
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
