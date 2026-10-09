import { AccountId } from "@miden-sdk/miden-sdk";
import { describe, expect, it } from "vitest";
import authVectors from "../../../../rules/auth_vectors.json";
import type { Word4 } from "../quiz";
import { authArgElements, multisigAuthArgs } from "../bread";

describe("multisig auth args", () => {
  it("lay out the 12 felts exactly as miden-standards does", () => {
    for (const v of authVectors) {
      const salt = v.salt.map(BigInt) as Word4;
      // the reference vector carries the faucet's felts at positions 8 and 9
      const faucet = { suffix: BigInt(v.elements[8]), prefix: BigInt(v.elements[9]) };
      expect(authArgElements(v.bound_block, salt, faucet).map(String)).toEqual(v.elements);
    }
  });

  it("commit to them with the same Poseidon2 hash as the Rust reference", () => {
    for (const v of authVectors) {
      const { commitment } = multisigAuthArgs(v.bound_block, v.salt.map(BigInt) as Word4, AccountId.fromHex(v.fee_faucet));
      expect(commitment.toHex()).toBe(v.commitment);
    }
  });
});
