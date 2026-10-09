// Geocoins for anyone. The faucet account has no authentication, so the app's own Miden client
// imports its public state and executes the mint itself: no key, no server. Bread claims the
// minted note by itself; the local test wallet claims it on connect and after a mint.
//
// ponytail: no PoW, no captcha, no rate limit. Testnet toy money; gate it when it matters.

import { AccountId } from "@miden-sdk/miden-sdk";
import { useMint } from "@miden-sdk/react";
import { useCallback } from "react";
import { GC_DECIMALS, GC_FAUCET } from "@/config";
import type { Client } from "./chain";

/** What one press of the button mints. */
export const GEOCOIN_GRANT = 10n * 10n ** BigInt(GC_DECIMALS);

export function useGeocoin(client: Client | null, runExclusive: <T>(fn: () => Promise<T>) => Promise<T>) {
  const { mint } = useMint();
  return useCallback(
    async (target: string): Promise<string> => {
      if (!client) throw new Error("client not ready");
      // the faucet's state as the node has it now: other players mint from it too, and the import
      // overwrites whatever this store remembered
      await runExclusive(() => client.importAccountById(AccountId.fromHex(GC_FAUCET)));
      const r = await mint({ targetAccountId: target, faucetId: GC_FAUCET, amount: GEOCOIN_GRANT, noteType: "public" });
      return r.transactionId;
    },
    [client, runExclusive, mint],
  );
}
