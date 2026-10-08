import { webcrypto } from "node:crypto";
import { renderHook, act, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";

const chain = vi.hoisted(() => ({ baseFee: 0, balance: 0n }));
const mockFunding = vi.hoisted(() => vi.fn());
const fundingNoteId = (id: string) => `0x${(id === "0xsender" ? "11" : "22").repeat(32)}`;

const mockFetch = vi.fn(async (url: string) => {
  if (url.startsWith("https://faucet-api.")) {
    const { pathname, searchParams } = new URL(url);
    const json = async () => {
      if (pathname === "/get_metadata") return { id: "0xdistributor", base_amount: 100000000 };
      if (pathname === "/pow") return { challenge: "ab", target: String(1n << 64n) };
      return { note_id: await mockFunding(searchParams.get("account_id")) };
    };
    return { ok: true, json };
  }
  return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
});
vi.stubGlobal("fetch", mockFetch);

vi.mock("@miden-sdk/react", () => import("@/__tests__/mocks/miden-sdk-react"));

// The increment flow builds a note (Package/NoteScript/Note/... constructors),
// creates a local sender, publishes it, and consumes it as the counter. The SDK
// value classes are stubbed by a Proxy; the client methods are mocked below so
// we can assert the two-transaction (publish + consume) sequence and the count.
vi.mock("@miden-sdk/miden-sdk", async () => {
  const stub = (): object =>
    new Proxy(function noop() {}, {
      get: (_t, prop) => {
        if (prop === "toU64s") return () => [0n, 0n, 0n, 0n];
        // Stable id so the published note matches the consumable record the
        // client returns (the hook filters consumables by note-id string).
        if (prop === "toString") return () => "STUB_NOTE_ID";
        if (typeof prop === "symbol") return undefined;
        return stub();
      },
      apply: () => stub(),
      construct: () => stub(),
    });
  const exports: Record<string, unknown> = {};
  for (const k of [
    "TransactionRequestBuilder",
    "TransactionFilter",
    "TransactionId",
    "Endpoint",
    "Package",
    "NoteScript",
    "Note",
    "NoteAssets",
    "NoteMetadata",
    "NoteRecipient",
    "NoteStorage",
    "NoteTag",
    "NoteType",
    "NoteArray",
    "FeltArray",
    "AccountId",
    "AccountStorageMode",
    "AuthScheme",
    "Felt",
    "Word",
  ]) {
    exports[k] = stub();
  }
  exports.RpcClient = class {
    free() {}
    async getBlockHeaderByNumber() { return { verificationBaseFee: () => chain.baseFee }; }
  };
  exports.AccountId = { fromHex: (id: string) => ({ toString: () => id }), fromBech32: (id: string) => ({ toString: () => id }) };
  exports.NoteScript = { fromPackage: () => stub(), p2id: () => ({ root: () => ({ toHex: () => "p2id" }) }) };
  return exports;
});

vi.mock("@/lib/miden", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/miden")>(), randomWord: () => ({}),
}));

import { useMiden, useMidenClient, useCreateWallet, useConsume, useTransaction, useWaitForCommit } from "@miden-sdk/react";
import { useIncrementCounter } from "../useIncrementCounter";

const COUNTER_ADDRESS = "0xcounter";
const settings = new Map<string, number[]>();
const balances = new Map<string, bigint>();
let fundingAmount = 100000000n;
const holder = { n: 3 };
let locked = false;
const exclusive = async <T,>(fn: () => Promise<T>): Promise<T> => {
  if (locked) throw new Error("Nested SDK lock");
  locked = true;
  try { return await fn(); } finally { locked = false; }
};
const account = (id = "0xsender") => ({
  storage: () => ({ getMapItem: () => ({ toU64s: () => [BigInt(holder.n), 0n, 0n, 0n] }) }),
  vault: () => ({ getBalance: () => balances.get(id) ?? chain.balance }),
  id: () => ({ toString: () => id }),
  isNew: () => id === "0xsender",
});
const record = (id: string, faucetId?: string, script = "p2id") => ({
  inputNoteRecord: () => ({ toNote: () => ({
    id: () => ({ toString: () => id }),
    script: () => ({ root: () => ({ toHex: () => script }) }),
    assets: () => ({ fungibleAssets: () => faucetId ? [{
      faucetId: () => ({ toString: () => faucetId }), amount: () => 100000000n,
    }] : [] }),
  }) }),
});
const getAccount = vi.fn(async (id: { toString(): string }) => account(id.toString()));
const getConsumableNotes = vi.fn(async () => [record("STUB_NOTE_ID")]);
const inputRecord = () => ({ inclusionProof: () => ({}), isConsumed: () => false,
  isProcessing: () => false, consumerTransactionId: (): string | undefined => undefined,
  toNote: () => record(fundingNoteId("0xsender"), "0xfee").inputNoteRecord().toNote() });
const fundingRecords = new Map<string, ReturnType<typeof inputRecord>>();
const getInputNote = vi.fn(async (id: string) => fundingRecords.get(id) ?? inputRecord());
const createWallet = vi.fn(async () => exclusive(async () => account()));
const execute = vi.fn<(options: unknown) => Promise<{ transactionId: string }>>(async () => exclusive(async () => ({ transactionId: "publish" })));
const consume = vi.fn(async ({ accountId, notes }: { accountId: string; notes: string[] }) =>
  exclusive(async () => {
    if (notes[0] === fundingNoteId(accountId)) {
      const transactionId = `funding:${accountId}`;
      fundingRecords.set(notes[0], { ...inputRecord(), isProcessing: () => true,
        consumerTransactionId: () => transactionId });
      return { transactionId };
    }
    return { transactionId: "consume" };
  }));
const waitForCommit = vi.fn<(id: unknown) => Promise<void>>(async () => undefined);
const client = {
  getAccount,
  getConsumableNotes,
  getInputNote,
  importAccountById: vi.fn(async () => undefined),
  syncState: vi.fn(async () => ({ blockNum: () => 123 })),
  feeFaucetId: vi.fn(async () => ({ toString: (): string => "0xfee" })),
  isAccountAllowed: vi.fn(async () => true),
  getSetting: vi.fn(async (key: string) => settings.get(key)),
  setSetting: vi.fn(async (key: string, value: number[]) => { settings.set(key, value); }),
  removeSetting: vi.fn(async (key: string) => { settings.delete(key); }),
  feeAwareTransactionRequestBuilder: vi.fn(async () => ({
    withOwnOutputNotes: () => ({ build: () => ({}) }),
  })),
};

async function setup() {
  const hook = renderHook(() => useIncrementCounter(COUNTER_ADDRESS));
  await waitFor(() => expect(hook.result.current.count).toBe(3));
  return hook;
}

describe("useIncrementCounter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("crypto", webcrypto);
    settings.clear();
    balances.clear();
    fundingRecords.clear();
    fundingAmount = 100000000n;
    locked = false;
    holder.n = 3;
    chain.baseFee = 0;
    chain.balance = 0n;
    client.isAccountAllowed.mockResolvedValue(true);
    getAccount.mockImplementation(async (id) => account(id.toString()));
    getConsumableNotes.mockResolvedValue([record("STUB_NOTE_ID")]);
    getInputNote.mockImplementation(async (id) => fundingRecords.get(id) ?? inputRecord());
    waitForCommit.mockImplementation(async (id) => {
      expect(locked).toBe(true); // This SDK wait hook doesn't lock its WASM calls.
      if (id === "consume") holder.n = 4;
      if (typeof id === "string" && id.startsWith("funding:")) {
        const accountId = id.slice("funding:".length);
        balances.set(accountId, fundingAmount);
        fundingRecords.set(fundingNoteId(accountId), { ...inputRecord(), isConsumed: () => true });
      }
    });
    mockFunding.mockImplementation(async (id: string) => fundingNoteId(id));
    vi.mocked(useMiden).mockReturnValue({
      client: null, isReady: true, isInitializing: false, error: null,
      sync: vi.fn(), runExclusive: exclusive, prover: null,
      signerAccountId: null, signerConnected: null,
    });
    vi.mocked(useMidenClient).mockReturnValue(client as unknown as ReturnType<typeof useMidenClient>);
    vi.mocked(useCreateWallet).mockReturnValue({ createWallet } as unknown as ReturnType<typeof useCreateWallet>);
    vi.mocked(useConsume).mockReturnValue({ consume } as unknown as ReturnType<typeof useConsume>);
    vi.mocked(useTransaction).mockReturnValue({ execute } as unknown as ReturnType<typeof useTransaction>);
    vi.mocked(useWaitForCommit).mockReturnValue({ waitForCommit });
  });

  it("loads the counter and reports an unreachable account", async () => {
    const hook = await setup();
    expect(hook.result.current.error).toBeNull();
    hook.unmount();
    getAccount.mockResolvedValue(null as never);
    const missing = renderHook(() => useIncrementCounter(COUNTER_ADDRESS));
    await waitFor(() => expect(missing.result.current.error).toMatch(/counter account not found/i));
    expect(missing.result.current.count).toBeNull();
  });

  it.each([{ baseFee: 0, balance: 0n }, { baseFee: 7, balance: 28n }, { baseFee: 7, balance: 999999n }])(
    "uses SDK transactions with fee rate $baseFee and balance $balance", async (fees) => {
      Object.assign(chain, fees);
      const { result } = await setup();
      await act(async () => {
        const first = result.current.increment();
        await result.current.increment();
        await first;
      });
      expect(result.current.error).toBeNull();
      expect(result.current.count).toBe(4);
      expect(createWallet).toHaveBeenCalledOnce();
      expect(createWallet).toHaveBeenCalledWith({ storageMode: "private", authScheme: 2 });
      expect(execute).toHaveBeenCalledOnce();
      expect(consume).toHaveBeenLastCalledWith({ accountId: COUNTER_ADDRESS, notes: ["STUB_NOTE_ID"] });
      expect(waitForCommit).toHaveBeenCalledWith("publish", expect.objectContaining({ timeoutMs: 60000 }));
      const funded = fees.baseFee > 0 && fees.balance < BigInt(fees.baseFee) * 256n;
      expect(mockFunding).toHaveBeenCalledTimes(funded ? 2 : 0);
      expect(consume).toHaveBeenCalledTimes(funded ? 3 : 1);
      expect(waitForCommit).toHaveBeenCalledTimes(funded ? 4 : 2);
    },
  );

  it("stops if publishing is discarded or never commits", async () => {
    waitForCommit.mockRejectedValueOnce(new Error("Transaction was discarded before commit"));
    const { result } = await setup();
    await act(async () => { await result.current.increment(); });
    expect(consume).not.toHaveBeenCalled();
    expect(result.current.count).toBe(3);
    expect(result.current.error).toContain("discarded");
    expect(result.current.isSubmitting).toBe(false);
  });

  it("waits for its own note even when unrelated notes are available", async () => {
    getConsumableNotes.mockResolvedValueOnce([record("unrelated-note")]);
    const { result } = await setup();
    vi.useFakeTimers();
    try {
      let pending: Promise<void>;
      await act(async () => { pending = result.current.increment(); });
      expect(consume).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(2500); await pending; });
      expect(consume).toHaveBeenCalledWith({ accountId: COUNTER_ADDRESS, notes: ["STUB_NOTE_ID"] });
    } finally { vi.useRealTimers(); }
  });

  it("recovers an existing sender after remount", async () => {
    const first = await setup();
    await act(async () => { await first.result.current.increment(); });
    first.unmount();
    holder.n = 3;
    const second = await setup();
    await act(async () => { await second.result.current.increment(); });
    expect(createWallet).toHaveBeenCalledOnce();
  });

  it("preserves a minted funding note after timeout and resumes without minting again", async () => {
    chain.baseFee = 7;
    waitForCommit.mockRejectedValueOnce(new Error("Timeout waiting for transaction commit"));
    const first = await setup();
    await act(async () => { await first.result.current.increment(); });
    expect(execute).not.toHaveBeenCalled();
    expect(settings.has("counter:funding:0xsender")).toBe(true);
    first.unmount();
    const second = await setup();
    await act(async () => { await second.result.current.increment(); });
    expect(second.result.current.error).toBeNull();
    expect(mockFunding).toHaveBeenCalledTimes(2); // sender once, counter once
    expect(settings.has("counter:funding:0xsender")).toBe(false);
  });

  it("stops before publishing when the faucet fails", async () => {
    chain.baseFee = 7;
    mockFunding.mockRejectedValueOnce(new Error("Faucet HTTP 500"));
    const { result } = await setup();
    await act(async () => { await result.current.increment(); });
    expect(result.current.error).toContain("HTTP 500");
    expect(execute).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(result.current.isSubmitting).toBe(false);
  });

  it("stops before funding or proving if the new sender needs registration", async () => {
    chain.baseFee = 7;
    client.isAccountAllowed.mockResolvedValue(false);
    const { result } = await setup();
    await act(async () => { await result.current.increment(); });
    expect(result.current.error).toMatch(/sender.*0xsender.*registration/i);
    expect(mockFunding).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(result.current.isSubmitting).toBe(false);
  });

  it("does not require registration for accounts already on chain", async () => {
    client.isAccountAllowed.mockResolvedValue(false);
    getAccount.mockImplementation(async (id) => ({ ...account(id.toString()), isNew: () => false }));
    const { result } = await setup();
    await act(async () => { await result.current.increment(); });
    expect(result.current.error).toBeNull();
    expect(result.current.count).toBe(4);
  });

  it("stops if consuming the funding note leaves less than the fee reserve", async () => {
    chain.baseFee = 7;
    fundingAmount = 10n;
    const { result } = await setup();
    await act(async () => { await result.current.increment(); });
    expect(result.current.error).toMatch(/insufficient.*fee/i);
    expect(execute).not.toHaveBeenCalled();
    expect(mockFunding).toHaveBeenCalledOnce();
    expect(settings.has("counter:funding:0xsender")).toBe(false);
  });

  it.each([
    { faucet: "0xother", script: "p2id" },
    { faucet: "0xfee", script: "tx_fee" },
  ])("rejects faucet funding with issuer $faucet and script $script", async ({ faucet, script }) => {
    chain.baseFee = 7;
    getInputNote.mockResolvedValue({ ...inputRecord(),
      toNote: () => record(fundingNoteId("0xsender"), faucet, script).inputNoteRecord().toNote() });
    const { result } = await setup();
    await act(async () => { await result.current.increment(); });
    expect(mockFunding).toHaveBeenCalledOnce();
    expect(result.current.error).toMatch(/P2ID.*fee asset/i);
    expect(settings.has("counter:funding:0xsender")).toBe(false);
    expect(consume).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("uses the SDK's funding consumption ID before trusting an optimistic balance", async () => {
    chain.baseFee = 7;
    waitForCommit.mockRejectedValueOnce(new Error("Timeout waiting for transaction commit"));
    const { result } = await setup();
    await act(async () => { await result.current.increment(); });
    balances.set("0xsender", fundingAmount); // local application is not a commit
    await act(async () => { await result.current.increment(); });
    expect(result.current.error).toBeNull();
    expect(result.current.count).toBe(4);
    expect(waitForCommit.mock.calls.filter(([id]) => id === "funding:0xsender")).toHaveLength(2);
    expect(consume.mock.calls.filter(([options]) => options.accountId === "0xsender")).toHaveLength(1);
    expect(mockFunding).toHaveBeenCalledTimes(2);
  });

  it("uses an available P2ID fee note before requesting more tokens", async () => {
    chain.baseFee = 7;
    balances.set(COUNTER_ADDRESS, 100000000n);
    getConsumableNotes.mockResolvedValueOnce([
      record("unrelated-asset", "0xother"),
      record("custom-script", "0xfee", "custom"),
      record(fundingNoteId("0xsender"), "0xfee"),
    ]);
    const { result } = await setup();
    await act(async () => { await result.current.increment(); });
    expect(result.current.error).toBeNull();
    expect(mockFunding).not.toHaveBeenCalled();
    expect(consume).toHaveBeenCalledWith({ accountId: "0xsender", notes: [fundingNoteId("0xsender")] });
    expect(consume).toHaveBeenCalledTimes(2); // funding + increment
  });

  it("receives an issued note even when the faucet HTTP response fails", async () => {
    chain.baseFee = 7;
    balances.set(COUNTER_ADDRESS, 100000000n);
    mockFunding.mockImplementationOnce(async () => {
      getConsumableNotes.mockResolvedValueOnce([record(fundingNoteId("0xsender"), "0xfee")]);
      throw new Error("Faucet response timed out");
    });
    const { result } = await setup();
    await act(async () => { await result.current.increment(); });
    expect(result.current.error).toBeNull();
    expect(result.current.count).toBe(4);
    expect(mockFunding).toHaveBeenCalledOnce();
    expect(settings.has("counter:funding:0xsender")).toBe(false);
  });

  it("finds a late funding note after remount without requesting it again", async () => {
    chain.baseFee = 7;
    balances.set(COUNTER_ADDRESS, 100000000n);
    mockFunding.mockRejectedValueOnce(new Error("Faucet response timed out"));
    const first = await setup();
    await act(async () => { await first.result.current.increment(); });
    expect(first.result.current.error).toContain("timed out");
    first.unmount();
    getConsumableNotes.mockResolvedValueOnce([record(fundingNoteId("0xsender"), "0xfee")]);
    const second = await setup();
    await act(async () => { await second.result.current.increment(); });
    expect(second.result.current.error).toBeNull();
    expect(second.result.current.count).toBe(4);
    expect(mockFunding).toHaveBeenCalledOnce();
  });
});
