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
  recordLinks: () => ({ url: "u", x: "x" }),
  wordFromHex: () => [0n, 0n, 0n, 0n],
}));

vi.mock("@/lib/bread", () => ({
  ...bread,
  selfCheckAuthArgs: () => true,
  setSubmitAttemptListener: () => undefined,
  waitFor: vi.fn(async () => true),
}));

// the app fetches the dataset and the map; the quiz check must see the record's own cities
vi.mock("@/lib/quiz", async (orig) => ({
  ...(await orig<typeof import("@/lib/quiz")>()),
  datasetWord: async () => [0n, 0n, 0n, 0n],
  quizCities: async () => cities,
}));

import { useMidenClient, useMint } from "@miden-sdk/react";
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

describe("shared record link, connected as a stranger", () => {
  it("posts one shot on click, then starts the quiz when the note is on chain", async () => {
    bread.postShot.mockResolvedValue({ txId: "tx", noteIds: ["0xnew"], deadline: 220 });
    render(<AppContent />);
    const button = await screen.findByRole("button", { name: /play \(1 GC\)/i });
    fireEvent.click(button);
    await waitFor(() => expect(bread.postShot).toHaveBeenCalledTimes(1));
    expect(bread.postShot.mock.calls[0][2]).toBe(prize);
    await screen.findByText(/where is c0\?/i);
  });

  it("does not post a second shot while one is open: it goes straight to the quiz", async () => {
    chain.notes = [prize, myChallenge];
    render(<AppContent />);
    fireEvent.click(await screen.findByRole("button", { name: /^play$/i }));
    await screen.findByText(/where is c0\?/i);
    expect(bread.postShot).not.toHaveBeenCalled();
  });

  it("shows a claimed record as gone, with no button", async () => {
    chain.shared = { ...prize, consumed: true };
    render(<AppContent />);
    await screen.findByText(/this one is over/i);
    expect(screen.queryByRole("button", { name: /challenge & play|challenge for/i })).toBeNull();
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
    render(<AppContent />);
    fireEvent.click(await screen.findByRole("button", { name: /get geocoins/i }));
    await screen.findByText(/10 GC in your pocket/i);
    expect(importAccountById).toHaveBeenCalledTimes(1);
    expect(mint).toHaveBeenCalledWith(expect.objectContaining({ targetAccountId: "mtst1me", amount: 10_000_000n, noteType: "public" }));
  });


  it("settles all my open shots at the record with one play", async () => {
    window.history.replaceState({}, "", "/");
    const second = { ...myChallenge, id: "0xc2", idWord: [2n, 2n, 2n, 2n] as [bigint, bigint, bigint, bigint] };
    chain.notes = [prize, myChallenge, second];
    render(<AppContent />);
    await screen.findByText(/my shots/i);
    // the top "Play" (post a record) plus one "Play" per open shot
    const buttons = screen.getAllByRole("button", { name: /^play$/i });
    expect(buttons).toHaveLength(3);
    fireEvent.click(buttons[1]);
    await screen.findByText(/where is c0\?/i);
  });

  it("does not list other people's records, but opens one from a pasted code (old ?prize= links too)", async () => {
    window.history.replaceState({}, "", "/");
    chain.notes = [prize];
    render(<AppContent />);
    await screen.findByText(/have a code\?/i);
    expect(screen.queryByText(/2000/)).toBeNull();
    fireEvent.change(screen.getByPlaceholderText(/paste the link or code/i), {
      target: { value: "http://x/?prize=0x62ea91634f23d65b4bcae5eb027ea1cad37be056412618cad17de9c3171e1ee8" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^go$/i }));
    await screen.findByText(/beat 2000\?/i);
  });
});
