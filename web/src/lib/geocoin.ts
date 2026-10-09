// Geocoins for anyone. The faucet account has no authentication, so the app's own Miden client
// imports its public state and executes the mint itself: no key, no server. Bread claims the
// minted note by itself; the local test wallet claims it on connect and after a mint.
//
// ponytail: no PoW, no captcha, no rate limit. Testnet toy money; gate it when it matters.
//
// The faucet is one account, so two players minting from the same faucet state collide: the node
// keeps the first and rejects the other ("conflicts with current mempool state"). A press retries
// with the faucet's fresh state after a random pause past the next block.
// ponytail: about one mint per 3 s block across all players; batching mints in one transaction
// from a small server lifts that ceiling if a crowd ever hits it.

import { AccountId } from "@miden-sdk/miden-sdk";
import { useMint } from "@miden-sdk/react";
import { useCallback } from "react";
import { GC_DECIMALS, GC_FAUCET } from "@/config";
import type { Client } from "./chain";
import { fmtGeocoin } from "./flow";

/** The button is for empty pockets: nothing for a wallet holding more than 1 Geocoin. */
export const GEOCOIN_MAX_HELD = 10n ** BigInt(GC_DECIMALS);
/** A grant counts as on its way this long: Bread takes the minted note by itself, a while later. */
export const GRANT_PENDING_MS = 5 * 60_000;

/**
 * Why a wallet gets no Geocoins now, or null.
 * ponytail: the app asks before minting, but the faucet has no key, so one's own code can still mint;
 * a captcha or a faucet with a server-held key enforces it for everyone.
 */
export function geocoinRefusal(balance: bigint, grantPending: boolean): string | null {
  if (grantPending) return "Your Geocoins are on their way. Open your wallet to take them.";
  if (balance > GEOCOIN_MAX_HELD) return `You still have ${fmtGeocoin(balance)}. Get more when you have 1 or less.`;
  return null;
}

/** Runs `mintOnce` until it lands, `attempts` times at most, pausing between tries. */
export async function retryMint<T>(
  mintOnce: () => Promise<T>,
  attempts = 5,
  pause = () => new Promise((r) => setTimeout(r, 3000 + Math.random() * 3000)),
): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await mintOnce();
    } catch (e) {
      if (n >= attempts) throw e;
      await pause();
    }
  }
}

/** What one press of the button mints. */
export const GEOCOIN_GRANT = 10n * 10n ** BigInt(GC_DECIMALS);

export function useGeocoin(client: Client | null, runExclusive: <T>(fn: () => Promise<T>) => Promise<T>) {
  const { mint } = useMint();
  return useCallback(
    async (target: string): Promise<string> => {
      if (!client) throw new Error("client not ready");
      return retryMint(async () => {
        // the faucet's state as the node has it now: other players mint from it too, and the import
        // overwrites whatever this store remembered
        await runExclusive(() => client.importAccountById(AccountId.fromHex(GC_FAUCET)));
        const r = await mint({ targetAccountId: target, faucetId: GC_FAUCET, amount: GEOCOIN_GRANT, noteType: "public" });
        return r.transactionId;
      });
    },
    [client, runExclusive, mint],
  );
}
