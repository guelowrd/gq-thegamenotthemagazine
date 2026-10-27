// The Gamecoin shop: sale notes (PSWAP) anyone may post; the game buys from the cheapest one at or under the price.
import { readFileSync } from "node:fs";
import { AccountId, FungibleAsset, Note, NoteAssets, NoteMetadata, NoteRecipient, NoteScript, NoteStorage, NoteTag, NoteType } from "@miden-sdk/miden-sdk";
import { describe, expect, it } from "vitest";
import { GC_FAUCET, GC_PRICE } from "@/config";
import { feltArray, parseAccountId, wordFromFelts } from "../chain";
import { acceptSale, decodeSale, payFor, pickSale, pswapTag, type Sale } from "../shop";

// mainnet USDCx (the fee asset; the testnet one is 0x4cbdcaffe75f0a317482224dae6436)
const PAY = "0xe69e6ca6e39df1b10c1e5399399feb";
const GC = 1_000_000n;
// 0x632A34E6: note type, 14 bits of the PSWAP root, the top bytes of the Gamecoin (0x34a3…) and USDCx (0xe69e…) prefixes
const TAG = 1663710438;
// 10 GC for 0.01 of the pay asset: the official price
const sale = (over: Partial<Sale> = {}): Sale => ({ id: "0xs", creator: "0xc", gcFaucet: GC_FAUCET, payFaucet: PAY, offered: 10n * GC, asked: 10n * GC_PRICE, minFill: 0n, ...over });

describe("a sale note the game buys from", () => {
  it("knows the mainnet admin by the account its Bread address names (the wallet that got the first 100,000 GC)", () => {
    expect(parseAccountId("mm1azntuhzd3lwqxs2mmeny202ljy3fxnpm_qr7qqq9wr6w").toString()).toBe("0xa6be5c4d8fdc03415bde66453d5f91");
    // testnet: Gaylord's testnet wallet
    expect(parseAccountId("mtst1arqfpgkk9rhxlq2evdr632uqwvnqsj7k_qr7qqq9wr6w").toString()).toBe("0xc090a2d628ee6f81596347a8ab8073");
  });

  it("is found under the pair's PSWAP tag (mainnet: the multisig faucet and USDCx)", () => {
    expect(pswapTag(PAY)).toBe(TAG);
  });


  it("is GQ's sale note (masm/sale/sale.masm), never a standard PSWAP note: a buyer's Bread lists a standard leftover and a tap buys all of it (wallet#1952)", () => {
    const saleScript = NoteScript.deserialize(new Uint8Array(readFileSync("public/scripts/sale.bin")));
    const seller = AccountId.fromHex("0xa6be5c4d8fdc03415bde66453d5f91");
    const pay = AccountId.fromHex(PAY);
    // PSWAP storage: pay faucet (suffix, prefix), asked, min fill step, payback note type, seller (suffix, prefix)
    const storage = [pay.suffix().asInt(), pay.prefix().asInt(), 10n * GC_PRICE, 0n, 1n, seller.suffix().asInt(), seller.prefix().asInt()];
    const note = (script: NoteScript) =>
      new Note(
        new NoteAssets([new FungibleAsset(AccountId.fromHex(GC_FAUCET), 10n * GC)]),
        new NoteMetadata(seller, NoteType.Public, new NoteTag(TAG)),
        new NoteRecipient(wordFromFelts([1n, 2n, 3n, 4n]), script, new NoteStorage(feltArray(storage))),
      );
    const saleRoot = saleScript.root().toHex();
    expect(decodeSale("0xs", note(saleScript), saleRoot)).toMatchObject({ creator: seller.toString(), gcFaucet: GC_FAUCET, payFaucet: PAY, offered: 10n * GC, asked: 10n * GC_PRICE, minFill: 0n });
    expect(decodeSale("0xp", note(NoteScript.pswap()), saleRoot)).toBeNull();
  });

  it("offers Gamecoin, asks the pay asset, at or under the official price", () => {
    expect(acceptSale(sale(), PAY)).toBe(true);
    expect(acceptSale(sale({ asked: 10n * GC_PRICE - 1n }), PAY)).toBe(true);
    expect(acceptSale(sale({ asked: 10n * GC_PRICE + 1n }), PAY)).toBe(false);
    expect(acceptSale(sale({ gcFaucet: "0xother" }), PAY)).toBe(false);
    expect(acceptSale(sale({ payFaucet: "0xother" }), PAY)).toBe(false);
    expect(acceptSale(sale({ offered: 0n }), PAY)).toBe(false);
    expect(acceptSale(sale({ asked: 0n }), PAY)).toBe(false);
  });

  it("charges the sale's own price, rounded up to the base unit", () => {
    expect(payFor(2n * GC, sale())).toBe(2n * GC_PRICE);
    expect(payFor(1n, sale())).toBe(1n);
    expect(payFor(3n * GC, sale({ asked: 10n * GC_PRICE - 1n }))).toBe(3n * GC_PRICE);
  });

  it("picks the cheapest sale with enough left and a fill floor the buy clears, the largest among equals", () => {
    const cheap = sale({ id: "cheap", asked: 5n * GC_PRICE });
    const big = sale({ id: "big", offered: 100n * GC, asked: 100n * GC_PRICE });
    const small = sale({ id: "small", offered: 1n * GC, asked: 1n * GC_PRICE });
    const floored = sale({ id: "floored", asked: 4n * GC_PRICE, minFill: 3n * GC_PRICE });
    expect(pickSale([small, big, cheap], 2n * GC)?.id).toBe("cheap");
    expect(pickSale([small, big], 2n * GC)?.id).toBe("big");
    expect(pickSale([small, sale({ id: "ten" })], 2n * GC)?.id).toBe("ten");
    expect(pickSale([small], 2n * GC)).toBeUndefined();
    // the floor is in the pay asset: 3 GC at this price pays 1.2, under the floor of 3
    expect(pickSale([floored, big], 3n * GC)?.id).toBe("big");
    expect(pickSale([floored, big], 8n * GC)?.id).toBe("floored");
    expect(pickSale([], 1n * GC)).toBeUndefined();
  });

  it("never picks the buyer's own sale (its creator consuming it takes the whole remainder back)", () => {
    expect(pickSale([sale()], 1n * GC, "0xc")).toBeUndefined();
    expect(pickSale([sale(), sale({ id: "other", creator: "0xd" })], 1n * GC, "0xc")?.id).toBe("other");
  });
});
