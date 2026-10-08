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
  cities: [
    { idx: 0, lat: 13885, lon: 18235, cos: 66 },
    { idx: 1, lat: 6709, lon: 13683, cos: 92 },
    { idx: 2, lat: 12569, lon: 31969, cos: 81 },
    { idx: 3, lat: 5607, lon: 19842, cos: 83 },
  ],
  chain: { notes: [] as unknown[], shared: null as unknown },
  bread: { postChallenge: vi.fn(), postPrize: vi.fn(), settle: vi.fn(), collect: vi.fn() },
}));
vi.mock("@miden-sdk/miden-wallet-adapter-react", () => ({ useMidenFiWallet: () => wallet }));

const champion = { suffix: 1n, prefix: 2n };
const storage: ChallengeStorage = {
  expiryBlock: 30_000,
  target: 2000,
  minStake: 1_000_000n,
  champion,
  player: null,
  prizeId: [0n, 0n, 0n, 0n],
  challengeRoot: [1n, 1n, 1n, 1n],
  seed: [0n, 0n, 0n, 0n],
  dataset: [0n, 0n, 0n, 0n],
  cities,
  challengeDeadline: 0,
};
const prize: GqNote = { id: "0xp", idWord: [9n, 9n, 9n, 9n], kind: "prize", storage, amount: 1_000_000n, consumed: false };
const myChallenge: GqNote = {
  id: "0xc",
  idWord: [1n, 1n, 1n, 1n],
  kind: "challenge",
  storage: { ...storage, player: me, prizeId: [9n, 9n, 9n, 9n], challengeDeadline: 200 },
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
  prizeLinks: () => ({ url: "u", x: "x" }),
  wordFromHex: () => [0n, 0n, 0n, 0n],
}));

vi.mock("@/lib/bread", () => ({
  ...bread,
  selfCheckAuthArgs: () => true,
  setSubmitAttemptListener: () => undefined,
  waitFor: vi.fn(async () => true),
}));

// the app fetches the dataset and the map; the quiz check must see the prize's own cities
vi.mock("@/lib/quiz", async (orig) => ({
  ...(await orig<typeof import("@/lib/quiz")>()),
  datasetWord: async () => [0n, 0n, 0n, 0n],
  quizCities: async () => cities,
}));

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
  window.history.replaceState({}, "", "/?prize=0xp");
});

describe("shared prize link, connected as a stranger", () => {
  it("posts one challenge on click, then starts the quiz when the note is on chain", async () => {
    bread.postChallenge.mockResolvedValue({ txId: "tx", noteIds: ["0xnew"], deadline: 220 });
    render(<AppContent />);
    const button = await screen.findByRole("button", { name: /play \(1 GQ\)/i });
    fireEvent.click(button);
    await waitFor(() => expect(bread.postChallenge).toHaveBeenCalledTimes(1));
    expect(bread.postChallenge.mock.calls[0][2]).toBe(prize);
    await screen.findByText(/where is c0\?/i);
  });

  it("does not post a second challenge while one is open: it goes straight to the quiz", async () => {
    chain.notes = [prize, myChallenge];
    render(<AppContent />);
    fireEvent.click(await screen.findByRole("button", { name: /^play$/i }));
    await screen.findByText(/where is c0\?/i);
    expect(bread.postChallenge).not.toHaveBeenCalled();
  });

  it("shows a claimed prize as gone, with no button", async () => {
    chain.shared = { ...prize, consumed: true };
    render(<AppContent />);
    await screen.findByText(/this one is over/i);
    expect(screen.queryByRole("button", { name: /challenge & play|challenge for/i })).toBeNull();
  });
});

describe("home, connected", () => {
  it("settles all my open challenges on the prize with one play", async () => {
    window.history.replaceState({}, "", "/");
    const second = { ...myChallenge, id: "0xc2", idWord: [2n, 2n, 2n, 2n] as [bigint, bigint, bigint, bigint] };
    chain.notes = [prize, myChallenge, second];
    render(<AppContent />);
    await screen.findByText(/finish your game/i);
    // the top "Play" (post a prize) plus one "Play" per open challenge
    const buttons = screen.getAllByRole("button", { name: /^play$/i });
    expect(buttons).toHaveLength(3);
    fireEvent.click(buttons[1]);
    await screen.findByText(/where is c0\?/i);
  });

  it("does not list other people's prizes, but opens one from a pasted code", async () => {
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
