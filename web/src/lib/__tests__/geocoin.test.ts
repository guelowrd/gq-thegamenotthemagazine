import { describe, expect, it, vi } from "vitest";

vi.mock("@miden-sdk/react", () => import("@/__tests__/mocks/miden-sdk-react"));
import { retryMint } from "../geocoin";

describe("Get Geocoins", () => {
  it("tries again when another player minted from the faucet in the same block", async () => {
    const once = vi
      .fn()
      .mockRejectedValueOnce(new Error("transaction conflicts with current mempool state"))
      .mockRejectedValueOnce(new Error("transaction conflicts with current mempool state"))
      .mockResolvedValue("tx");
    const pause = vi.fn(async () => {});
    await expect(retryMint(once, 5, pause)).resolves.toBe("tx");
    expect(once).toHaveBeenCalledTimes(3);
    expect(pause).toHaveBeenCalledTimes(2);
  });

  it("gives up after the last attempt, with the last error", async () => {
    const once = vi.fn().mockRejectedValue(new Error("still busy"));
    await expect(retryMint(once, 3, async () => {})).rejects.toThrow("still busy");
    expect(once).toHaveBeenCalledTimes(3);
  });
});
