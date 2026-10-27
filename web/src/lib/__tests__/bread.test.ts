import { readFileSync } from "node:fs";
import { AccountId, FungibleAsset, Note, NoteAssets, NoteMetadata, NoteRecipient, NoteScript, NoteStorage, NoteTag, NoteType, type TransactionRequest } from "@miden-sdk/miden-sdk";
import { describe, expect, it, vi } from "vitest";
import authVectors from "../../../../rules/auth_vectors.json";
import { GC_FAUCET } from "@/config";
import { feltArray, wordFromFelts, type Client } from "../chain";
import type { Word4 } from "../quiz";
import { collect, multisigAuthArgs, openSale, type Wallet } from "../bread";

// the node's tip, as the app reads it before building a request
const node = vi.hoisted(() => ({ tip: 0 }));
vi.mock("@miden-sdk/miden-sdk", async (actual) => ({
  ...(await actual<typeof import("@miden-sdk/miden-sdk")>()),
  RpcClient: class {
    getBlockHeaderByNumber = async () => ({ blockNum: () => node.tip });
    free() {}
  },
}));
const saleScript = () => NoteScript.deserialize(new Uint8Array(readFileSync("public/scripts/sale.bin")));
vi.mock("../chain", async (actual) => ({
  ...(await actual<typeof import("../chain")>()),
  fetchNotesWithProof: async () => ({ inputs: [], files: [] }),
  loadScripts: async () => ({ sale: saleScript(), saleRoot: saleScript().root().toHex() }),
}));
vi.mock("@miden-sdk/miden-wallet-adapter-base", () => ({ Transaction: { createCustomTransaction: (_from: string, _to: string, request: TransactionRequest) => request } }));

describe("multisig auth args", () => {
  it("lay out the 12 felts exactly as miden-standards does and commit to them with the same Poseidon2 hash", () => {
    for (const v of authVectors) {
      const { elements, commitment } = multisigAuthArgs(v.bound_block, v.salt.map(BigInt) as Word4, AccountId.fromHex(v.fee_faucet));
      expect(elements.map(String)).toEqual(v.elements);
      expect(commitment.toHex()).toBe(v.commitment);
    }
  });
});

describe("handing a request to Bread", () => {
  const client = { feeFaucetId: async () => AccountId.fromHex(GC_FAUCET) } as unknown as Client;
  const sent: TransactionRequest[] = [];
  const wallet = (answers: (() => Promise<string>)[]): Wallet => ({
    address: "mtst1me",
    requestAssets: async () => [],
    requestTransaction: async (tx: unknown) => {
      sent.push(tx as TransactionRequest);
      return answers.shift()!();
    },
  });
  const bound = (r: TransactionRequest) => r.blockNumbers();

  it("binds the block the node is at, never one ahead: Bread refuses a block its own sync has not reached", async () => {
    sent.length = 0;
    node.tip = 169676;
    await expect(collect(client, wallet([async () => "0xtx"]), [])).resolves.toMatchObject({ txId: "0xtx" });
    expect(sent.map(bound)).toEqual([[169676]]);
  });

  it("rebuilds at the node's fresh tip when Bread was still behind, and gives up on any other error", async () => {
    sent.length = 0;
    node.tip = 169676;
    const behind = Object.assign(new Error("the Miden client synced to block 169675, below block 169676 the proposal binds; its node has not reached that block yet"), { name: "ChainBehindBoundBlockError" });
    const answers = [async () => ((node.tip = 169677), Promise.reject(behind)), async () => "0xtx"];
    await expect(collect(client, wallet(answers), [])).resolves.toMatchObject({ txId: "0xtx" });
    expect(sent.map(bound)).toEqual([[169676], [169677]]);

    sent.length = 0;
    await expect(collect(client, wallet([async () => Promise.reject(new Error("NOT_GRANTED"))]), [])).rejects.toThrow(/NOT_GRANTED/);
    expect(sent).toHaveLength(1);
  });
});

describe("putting Gamecoin on sale", () => {
  it("posts the SDK's PSWAP note with GQ's sale script in its place: same coins, price, seller and tag (wallet#1952)", async () => {
    const seller = AccountId.fromHex("0xc090a2d628ee6f81596347a8ab8073");
    const storage = [11n, 22n, 1_000n, 0n, 1n, seller.suffix().asInt(), seller.prefix().asInt()];
    const pswap = new Note(
      new NoteAssets([new FungibleAsset(AccountId.fromHex(GC_FAUCET), 1_000_000n)]),
      new NoteMetadata(seller, NoteType.Public, new NoteTag(1234)),
      new NoteRecipient(wordFromFelts([1n, 2n, 3n, 4n]), NoteScript.pswap(), new NoteStorage(feltArray(storage))),
    );
    const client = {
      feeFaucetId: async () => AccountId.fromHex(GC_FAUCET),
      newPswapCreateTransactionRequest: async () => ({ expectedOutputOwnNotes: () => [pswap] }),
    } as unknown as Client;
    const sent: TransactionRequest[] = [];
    const wallet: Wallet = { address: "mtst1arqfpgkk9rhxlq2evdr632uqwvnqsj7k", requestAssets: async () => [], requestTransaction: async (tx: unknown) => (sent.push(tx as TransactionRequest), "0xtx") };

    const r = await openSale(client, wallet, 1_000_000n, 1_000n, GC_FAUCET);
    const posted = sent[0].expectedOutputOwnNotes()[0];
    expect(posted.recipient().script().root().toHex()).toBe(saleScript().root().toHex());
    expect(posted.recipient().storage().items().map((f) => f.asInt())).toEqual(storage);
    expect(posted.recipient().serialNum().toHex()).toBe(pswap.recipient().serialNum().toHex());
    expect(posted.metadata().tag().asU32()).toBe(1234);
    expect(posted.assets().fungibleAssets().map((a) => a.amount())).toEqual([1_000_000n]);
    expect(r.noteIds).toEqual([posted.id().toString()]);
  });
});
