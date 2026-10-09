// The public testnet faucet's HTTP API: request fee tokens for an account (proof of work included).
// Used by the local test wallet; Bread users fund fees from inside Bread.

/** Request a public funding note over HTTP; the recipient must still consume it.
 * Unlike useMint, this does not execute the faucet account. PoW is SHA-256(challenge || nonce_be).
 */
export async function requestFaucetTokens(
  baseUrl: string,
  accountId: string,
): Promise<string> {
  const get = async (path: string, params?: URLSearchParams) => {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/${path}${params ? `?${params}` : ""}`, {
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Faucet ${path}: HTTP ${response.status} ${await response.text()}`);
    return response.json();
  };
  const metadata = await get("get_metadata");
  // metadata.id is the distribution account, not the fee-asset issuer in v0.17.
  const amount = String(metadata.base_amount);
  if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n) {
    throw new Error("Faucet returned an invalid token amount.");
  }
  const pow = await get("pow", new URLSearchParams({ account_id: accountId, amount }));
  const hex = String(pow.challenge).replace(/^0x/, "");
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(hex)) throw new Error("Invalid faucet challenge.");
  const challenge = Uint8Array.from(hex.match(/../g)!, (byte) => parseInt(byte, 16));
  const input = new Uint8Array(challenge.length + 8);
  input.set(challenge);
  const view = new DataView(input.buffer);
  const target = BigInt(pow.target);
  if (target <= 0n || target > 1n << 64n) throw new Error("Invalid faucet PoW target.");
  let nonce = new DataView(crypto.getRandomValues(new Uint8Array(8)).buffer).getBigUint64(0);
  const deadline = Date.now() + 90_000;
  for (;;) {
    view.setBigUint64(challenge.length, nonce);
    const digest = new DataView(await crypto.subtle.digest("SHA-256", input));
    if (digest.getBigUint64(0) < target) break;
    if (Date.now() >= deadline) throw new Error("Faucet proof of work timed out. Try again.");
    nonce = BigInt.asUintN(64, nonce + 1n);
  }
  const result = await get("get_tokens", new URLSearchParams({
    account_id: accountId,
    asset_amount: amount,
    challenge: pow.challenge,
    nonce: String(nonce),
  }));
  if (typeof result.note_id !== "string" || !/^0x[0-9a-f]{64}$/i.test(result.note_id)) {
    throw new Error("Faucet did not return a valid funding note ID.");
  }
  return result.note_id;
}
