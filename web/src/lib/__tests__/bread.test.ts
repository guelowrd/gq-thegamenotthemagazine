import { describe, expect, it } from "vitest";
import authVectors from "../../../../rules/auth_vectors.json";
import type { Word4 } from "../quiz";
import { authArgElements } from "../bread";

// The Poseidon2 commitment itself needs the SDK's WASM, which only runs in a browser; the app
// checks it at start-up in development (`selfCheckAuthArgs` in bread.ts).

describe("multisig auth args", () => {
  it("lay out the 12 felts exactly as miden-standards does", () => {
    for (const v of authVectors) {
      const salt = v.salt.map(BigInt) as Word4;
      // the reference vector carries the faucet's felts at positions 8 and 9
      const faucet = { suffix: BigInt(v.elements[8]), prefix: BigInt(v.elements[9]) };
      expect(authArgElements(v.bound_block, salt, faucet).map(String)).toEqual(v.elements);
    }
  });
});
