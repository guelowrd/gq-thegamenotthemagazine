/// <reference types="node" />
import { webcrypto, createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestFaucetTokens } from "../funding";

afterEach(() => vi.unstubAllGlobals());
const noteId = `0x${"ab".repeat(32)}`;

describe("requestFaucetTokens", () => {
  it("requests faucet funding with valid PoW when metadata names a distribution account", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const target = 1n << 64n;
    const get = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "distribution-account", base_amount: 100000000 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ challenge: "aabb", target: String(target) }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ note_id: noteId }) });
    vi.stubGlobal("fetch", get);
    await expect(requestFaucetTokens("https://faucet.example/", "sender")).resolves.toBe(noteId);
    const request = new URL(get.mock.calls[2][0]);
    expect(request.searchParams.get("asset_amount")).toBe("100000000");
    expect(request.searchParams.get("account_id")).toBe("sender");
    const nonce = Buffer.alloc(8);
    nonce.writeBigUInt64BE(BigInt(request.searchParams.get("nonce")!));
    const digest = createHash("sha256").update(Buffer.from("aabb", "hex")).update(nonce).digest();
    expect(digest.readBigUInt64BE()).toBeLessThan(target);
    expect(get.mock.calls[2][1]).toMatchObject({ cache: "no-store" });
  });

  it("does not request tokens when the faucet returns an invalid amount", async () => {
    const get = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "distributor", base_amount: -1 }) });
    vi.stubGlobal("fetch", get);
    await expect(requestFaucetTokens("https://faucet.example", "sender")).rejects.toThrow("invalid token amount");
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("surfaces service failures without retrying a mint", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const get = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "fee", base_amount: 100 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ challenge: "ab", target: String(1n << 64n) }) })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "Internal error." });
    vi.stubGlobal("fetch", get);
    await expect(requestFaucetTokens("https://faucet.example", "sender")).rejects.toThrow("Faucet get_tokens: HTTP 500 Internal error.");
    expect(get).toHaveBeenCalledTimes(3);
  });

  it("rejects a malformed note ID before it can be persisted", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const get = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "fee", base_amount: 100 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ challenge: "ab", target: String(1n << 64n) }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ note_id: "invalid-id" }) });
    vi.stubGlobal("fetch", get);
    await expect(requestFaucetTokens("https://faucet.example", "sender")).rejects.toThrow(/note ID/);
  });
});
