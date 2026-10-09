// The screens, wired to mocked hooks, a fake chain and a fake Bread: the template's way of testing
// Miden components without WASM. One scenario per incident from the first Bread session.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GqNote } from "@/lib/chain";
import type { ChallengeStorage } from "@/lib/notes";

vi.mock("@miden-sdk/react", () => import("@/__tests__/mocks/miden-sdk-react"));

// vi.mock factories are hoisted above every import, so what they reference must be hoisted too
const { wallet, me, cities, chain, bread } = vi.hoisted(() => ({
  wallet: {
    connected: true,
    connecting: false,
    address: "mtst1me",
    wallet: { readyState: "Installed" },
    connect: vi.fn(),
    disconnect: vi.fn(),
    requestTransaction: vi.fn(),
    requestAssets: vi.fn(),
  },
  me: { suffix: 3n, prefix: 4n },
  // ten cities, as the rules demand
  cities: Array.from({ length: 10 }, (_, idx) => ({ idx, lat: 9000 + idx * 100, lon: 18000 + idx * 100, cos: 100 })),
  chain: { notes: [] as unknown[], shared: null as unknown },
  bread: { postShot: vi.fn(), postRecord: vi.fn(), settle: vi.fn(), collect: vi.fn() },
}));
vi.mock("@miden-sdk/miden-wallet-adapter-react", () => ({ useMidenFiWallet: () => wallet }));

const champion = { suffix: 1n, prefix: 2n };
const storage: ChallengeStorage = {
  expiryBlock: 30_000,
  target: 2000,
  minStake: 1_000_000n,
  champion,
  rival: null,
  recordId: [0n, 0n, 0n, 0n],
  shotRoot: [1n, 1n, 1n, 1n],
  seed: [0n, 0n, 0n, 0n],
  dataset: [0n, 0n, 0n, 0n],
  cities,
  shotDeadline: 0,
};
const prize: GqNote = { id: "0xp", idWord: [9n, 9n, 9n, 9n], kind: "record", storage, amount: 1_000_000n, consumed: false };
const myChallenge: GqNote = {
  id: "0xc",
  idWord: [1n, 1n, 1n, 1n],
  kind: "shot",
  storage: { ...storage, rival: me, recordId: [9n, 9n, 9n, 9n], shotDeadline: 200 },
  amount: 1_000_000n,
  consumed: false,
};

vi.mock("@/lib/chain", () => ({
  accountFelts: () => me,
  parseAccountId: (s: string) => s,
  fetchGqNote: vi.fn(async () => chain.shared),
  listGqNotes: vi.fn(async () => chain.notes),
  loadScripts: vi.fn(async () => ({})),
  syncGq: vi.fn(async () => 100),
  knownNote: vi.fn(async () => undefined),
  wordFromHex: () => [0n, 0n, 0n, 0n],
}));

vi.mock("@/lib/bread", () => ({
  ...bread,
  selfCheckAuthArgs: () => true,
  reportBreadOutcome: () => undefined,
  setSubmitAttemptListener: () => undefined,
  setSubmitStageListener: () => undefined,
  waitFor: vi.fn(async () => true),
}));

// the app fetches the dataset and the map; the quiz check must see the record's own cities
vi.mock("@/lib/quiz", async (orig) => ({
  ...(await orig<typeof import("@/lib/quiz")>()),
  datasetWord: async () => [0n, 0n, 0n, 0n],
  quizCities: async () => cities,
}));

import { useMidenClient, useMint } from "@miden-sdk/react";
import { waitFor as waitForMock } from "@/lib/bread";
import { fetchGqNote, knownNote, syncGq } from "@/lib/chain";
import { AppContent } from "../AppContent";

beforeEach(() => {
  vi.clearAllMocks();
  chain.notes = [];
  chain.shared = prize;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode(url.includes("cities") ? JSON.stringify(cities.map((c) => ({ name: `c${c.idx}`, country: "x", lat: 0, lon: 0 }))) : "[]").buffer,
      json: async () => [],
    })),
  );
  window.history.replaceState({}, "", "/?record=0xp");
});

/** Past the welcome screen, onto a tab. */
async function start(tab?: RegExp) {
  render(<AppContent />);
  fireEvent.click(await screen.findByRole("button", { name: /click to start/i }));
  if (tab) fireEvent.click(screen.getByRole("button", { name: tab }));
}

describe("shared record link, connected as a stranger", () => {
  it("lands on VS, posts one shot on Insert Geocoin, then starts the quiz when the note is on chain", async () => {
    bread.postShot.mockResolvedValue({ txId: "tx", noteIds: ["0xnew"], deadline: 220 });
    render(<AppContent />);
    const button = await screen.findByRole("button", { name: /insert geocoin/i });
    fireEvent.click(button);
    await waitFor(() => expect(bread.postShot).toHaveBeenCalledTimes(1));
    expect(bread.postShot.mock.calls[0][2]).toEqual(prize);
    await screen.findByText(/find c0!/i);
    expect(screen.getByText(/beat my record/i)).toBeInTheDocument();
  });

  it("does not post a second shot while one is open: it goes straight to the quiz", async () => {
    chain.notes = [prize, myChallenge];
    render(<AppContent />);
    fireEvent.click(await screen.findByRole("button", { name: /^play$/i }));
    await screen.findByText(/find c0!/i);
    expect(bread.postShot).not.toHaveBeenCalled();
  });

  it("comes back to the record, error shown, when the wallet never finishes (Bread fails after approval)", async () => {
    bread.postShot.mockResolvedValue({ txId: "tx", noteIds: ["0xnew"], deadline: 220 });
    vi.mocked(waitForMock).mockResolvedValueOnce(false);
    render(<AppContent />);
    fireEvent.click(await screen.findByRole("button", { name: /insert geocoin/i }));
    await screen.findByText(/did not go through yet/i);
    expect(screen.getByRole("button", { name: /insert geocoin/i })).toBeInTheDocument();
  });

  it("Back leaves a request that hangs and returns to the record", async () => {
    bread.postShot.mockReturnValue(new Promise(() => undefined));
    render(<AppContent />);
    fireEvent.click(await screen.findByRole("button", { name: /insert geocoin/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^back$/i }));
    expect(await screen.findByRole("button", { name: /insert geocoin/i })).toBeInTheDocument();
  });

  it("saying no in the wallet keeps the record on screen, says so plainly, and Try again asks again", async () => {
    bread.postShot.mockRejectedValueOnce(Object.assign(new Error("NOT_GRANTED"), { name: "WalletTransactionError" }));
    bread.postShot.mockResolvedValueOnce({ txId: "tx", noteIds: ["0xnew"], deadline: 220 });
    render(<AppContent />);
    fireEvent.click(await screen.findByRole("button", { name: /insert geocoin/i }));
    await screen.findByText(/you said no in your wallet/i);
    expect(screen.getByRole("button", { name: /insert geocoin/i })).toBeInTheDocument();
    expect(screen.queryByText(/NOT_GRANTED/)).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await screen.findByText(/find c0!/i);
    expect(bread.postShot).toHaveBeenCalledTimes(2);
  });

  it("Try again after a wallet that did not finish first checks the chain: no second Geocoin", async () => {
    bread.postShot.mockResolvedValue({ txId: "tx", noteIds: ["0xnew"], deadline: 220 });
    vi.mocked(waitForMock).mockResolvedValueOnce(false);
    render(<AppContent />);
    fireEvent.click(await screen.findByRole("button", { name: /insert geocoin/i }));
    await screen.findByText(/did not go through yet/i);
    // the shot landed late, while the player read the message
    vi.mocked(knownNote).mockResolvedValue({ consumed: false });
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await screen.findByText(/find c0!/i);
    expect(bread.postShot).toHaveBeenCalledTimes(1);
    vi.mocked(knownNote).mockResolvedValue(undefined);
  });

  it("a record that fails to load says why and loads on Try again", async () => {
    vi.mocked(fetchGqNote).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(<AppContent />);
    await screen.findByText(/network is slow or busy/i);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByRole("button", { name: /insert geocoin/i })).toBeInTheDocument();
    expect(screen.queryByText(/network is slow or busy/i)).toBeNull();
  });

  it("a failing background sync only shows a NETWORK SLOW tag, never an error box", async () => {
    vi.mocked(syncGq).mockRejectedValue(new TypeError("Failed to fetch"));
    try {
      render(<AppContent />);
      await screen.findByText(/network slow/i);
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      vi.mocked(syncGq).mockResolvedValue(100);
    }
  });

  it("a record the background sync sees consumed (just won, or taken by someone) is shown as over", async () => {
    chain.notes = [{ ...prize, consumed: true }];
    render(<AppContent />);
    await screen.findByText(/this one is over/i);
    expect(screen.queryByRole("button", { name: /insert geocoin/i })).toBeNull();
  });

  it("shows a claimed record as gone, with no button", async () => {
    chain.shared = { ...prize, consumed: true };
    render(<AppContent />);
    await screen.findByText(/this one is over/i);
    expect(screen.queryByRole("button", { name: /insert geocoin|^play$/i })).toBeNull();
  });
});

describe("welcome and 1P World Tour", () => {
  it("plays before any wallet is connected; the rival sprite stays out of a solo run", async () => {
    window.history.replaceState({}, "", "/");
    wallet.connected = false;
    try {
      await start();
      fireEvent.click(await screen.findByRole("button", { name: /locate first city/i }));
      await screen.findByText(/find c0!/i);
      expect(screen.queryByText(/beat my record/i)).toBeNull();
      expect(wallet.connect).not.toHaveBeenCalled();
    } finally {
      wallet.connected = true;
    }
  });
});

describe("home, connected", () => {
  it("mints ten Geocoins to the connected wallet from the faucet nobody holds a key to", async () => {
    window.history.replaceState({}, "", "/");
    // the app's own client refreshes the public faucet account before executing the mint
    const importAccountById = vi.fn(async () => undefined);
    vi.mocked(useMidenClient).mockReturnValue({ importAccountById } as never);
    const mint = vi.fn(async () => ({ transactionId: "tx" }));
    vi.mocked(useMint).mockReturnValue({ mint, result: null, isLoading: false, stage: "idle", error: null, reset: vi.fn() } as never);
    await start(/champion vs rival/i);
    fireEvent.click(await screen.findByRole("button", { name: /get geocoins/i }));
    await screen.findByText(/10 Geocoins for you! Open your wallet to take them/i);
    expect(importAccountById).toHaveBeenCalledTimes(1);
    expect(mint).toHaveBeenCalledWith(expect.objectContaining({ targetAccountId: "mtst1me", amount: 10_000_000n, noteType: "public" }));
  });


  it("settles all my open shots at the record with one play", async () => {
    window.history.replaceState({}, "", "/");
    const second = { ...myChallenge, id: "0xc2", idWord: [2n, 2n, 2n, 2n] as [bigint, bigint, bigint, bigint] };
    chain.notes = [prize, myChallenge, second];
    await start(/player hub/i);
    await screen.findAllByText(/my shot/i);
    // one "Play" per open shot
    const buttons = screen.getAllByRole("button", { name: /^play$/i });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]);
    await screen.findByText(/find c0!/i);
  });

  it("does not list other people's records, but opens one from a pasted code (old ?prize= links too)", async () => {
    window.history.replaceState({}, "", "/");
    chain.notes = [prize];
    await start(/champion vs rival/i);
    await screen.findByText(/have a code\?/i);
    expect(screen.queryByText(/2,?000/)).toBeNull();
    fireEvent.change(screen.getByPlaceholderText(/paste the link or code/i), {
      target: { value: "http://x/?prize=0x62ea91634f23d65b4bcae5eb027ea1cad37be056412618cad17de9c3171e1ee8" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^go$/i }));
    await screen.findByText(/2,?000 pts to beat/i);
  });
});
