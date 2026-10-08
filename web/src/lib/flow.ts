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

/** After a play: which notes to settle, whether to claim, and what to tell the player. */
export function settlePlan(challenges: GqNote[], prize: GqNote | undefined, score: number, height: number): SettlePlan {
  if (challenges.length === 0) throw new Error("no challenge note to settle");
  const target = challenges[0].storage.target;
  const won = score > target;
  const claimPrize = won && !!prize && !prize.consumed && prize.storage.expiryBlock > height;
  const n = challenges.length > 1 ? ` (${challenges.length} challenge notes)` : "";
  const text = claimPrize
    ? `You scored ${score} > ${target}. Claiming the prize and your stake${n}`
    : won
      ? `You scored ${score} > ${target}. Recovering your stake${n}`
      : `You scored ${score} ≤ ${target}. Forfeiting your stake to the champion${n}`;
  return { won, claimPrize, text };
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
 * `expectedLag` is the block offset of the first attempt; later attempts alternate offset and
 * offset + 1. `attempt(offset)` builds and submits; it must throw on failure.
 */
export async function submitWithRetry<T>(
  attempt: (offset: number, n: number) => Promise<T>,
  expectedLag: number,
  retries: number,
): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await attempt(expectedLag + ((n - 1) % 2), n);
    } catch (e) {
      if (!isAnchorMismatch(e) || n >= retries) throw e;
    }
  }
}
