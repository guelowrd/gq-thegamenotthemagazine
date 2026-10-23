// The screens, wired to mocked hooks, a fake chain and a fake Bread: the template's way of testing
// Miden components without WASM. One scenario per incident from the first Bread session.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChallengeNote } from "@/lib/chain";
import type { ChallengeStorage } from "@/lib/notes";
import type { Sale } from "@/lib/shop";

vi.mock("@miden-sdk/react", () => import("@/__tests__/mocks/miden-sdk-react"));

// vi.mock factories are hoisted above every import, so what they reference must be hoisted too
const { wallet, me, cities, chain, bread, shop } = vi.hoisted(() => ({
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
  chain: { notes: [] as ChallengeNote[], shared: null as ChallengeNote | null },
  bread: { postShot: vi.fn(), postRecord: vi.fn(), settle: vi.fn(), collect: vi.fn(), buyGamecoin: vi.fn(), gcBalance: vi.fn(async () => 12_000_000n) },
  shop: { openSales: vi.fn(async (): Promise<Sale[]> => []) },
}));
vi.mock("@miden-sdk/miden-wallet-adapter-react", () => ({ useMidenFiWallet: () => wallet }));

const champion = { suffix: 1n, prefix: 2n };
const storage: ChallengeStorage = {
  expiryBlock: RECORD_LIFETIME_BLOCKS - 800,
  target: 2000,
  minStake: 1_000_000n,
  champion,
  rival: null,
  recordId: [0n, 0n, 0n, 0n],
  shotRoot: [1n, 1n, 1n, 1n],
  game: encodeGame({ seed: [0n, 0n, 0n, 0n], dataset: [0n, 0n, 0n, 0n], cities }),
  shotDeadline: 0,
};
const prize: ChallengeNote = { id: "0xp", idWord: [9n, 9n, 9n, 9n], kind: "record", storage, faucet: GC_FAUCET, amount: 1_000_000n, consumed: false };
const myShot: ChallengeNote = {
  id: "0xc",
  idWord: [1n, 1n, 1n, 1n],
  kind: "shot",
  storage: { ...storage, rival: me, recordId: [9n, 9n, 9n, 9n], shotDeadline: 200 },
  faucet: GC_FAUCET,
  amount: 1_000_000n,
  consumed: false,
};

vi.mock("@/lib/chain", () => ({
  accountFelts: () => me,
  parseAccountId: (s: string) => s,
  fetchChallengeNote: vi.fn(async () => chain.shared),
  listChallengeNotes: vi.fn(async () => chain.notes),
  loadScripts: vi.fn(async () => ({})),
  syncNotes: vi.fn(async () => 100),
  knownNote: vi.fn(async () => undefined),
  wordFromHex: () => [0n, 0n, 0n, 0n],
  blockTime: vi.fn(async () => Date.now()),
  // every test account reads …thj9 backward: JHT, then JHN, JHL… in the order they played
  bech32Of: () => "mtst1aryq2znjyt4wqq29lxwta3sjnqlnthj9",
  hexOf: vi.fn(() => "0xreal"),
}));

vi.mock("@/lib/shop", async (orig) => ({ ...(await orig<typeof import("@/lib/shop")>()), openSales: shop.openSales }));

vi.mock("@/lib/bread", () => ({
  ...bread,
  setSubmitAttemptListener: () => undefined,
  setSubmitStageListener: () => undefined,
  waitFor: vi.fn(async () => true),
}));

// the app fetches the dataset and the map; the quiz check must see the record's own cities
vi.mock("@/lib/quiz", async (orig) => ({
  ...(await orig<typeof import("@/lib/quiz")>()),
  // the World Tour list (cities c0…c9) hashes to the record's dataset word, the stage lists (s0…s9) all to another
  datasetWord: async (bytes: Uint8Array) => (new TextDecoder().decode(bytes).includes('"s0"') ? [9n, 9n, 9n, 9n] : [0n, 0n, 0n, 0n]),
  quizCities: async () => cities,
}));

import { useMidenClient } from "@miden-sdk/react";
import { waitFor as waitForMock } from "@/lib/bread";
import { fetchChallengeNote, hexOf, knownNote, listChallengeNotes, syncNotes } from "@/lib/chain";
import { encodeGame } from "@/lib/quiz";
import { BLOCK_SECONDS, GC_FAUCET, MIN_SHOT_WINDOW_BLOCKS, RECORD_LIFETIME_BLOCKS } from "@/config";
import { AppContent } from "../AppContent";

beforeEach(() => {
  vi.resetAllMocks();
  chain.notes = [];
  chain.shared = prize;
  wallet.connected = true;
  wallet.connecting = false;
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: true,
      // the World Tour list names its cities c0…c9, every stage list s0…s9 (all four hash to the same word; the last registered, Asia, owns it)
      arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(cities.map((c) => ({ name: `${url.endsWith("/cities.json") ? "c" : "s"}${c.idx}`, country: "x", lat: 0, lon: 0 })))).buffer,
      json: async () => (url.includes("places.zh") ? Object.fromEntries(cities.map((c) => [`c${c.idx}|x`, [`城${c.idx}`, "国"]])) : {}),
    })),
  );
  window.history.replaceState({}, "", "/");
});

/** Ten clicks on the map, each city's reveal skipped. Needs fake timers. */
async function playRound() {
  for (let i = 0; i < 10; i++) {
    await screen.findByText(/find c\d!/i);
    fireEvent.click(screen.getByRole("img", { name: /world map/i }), { clientX: 10, clientY: 10 });
    await act(async () => void vi.advanceTimersByTime(1600));
  }
}

/** Past the welcome screen, onto a tab. */
async function start(tab?: RegExp) {
  render(<AppContent />);
  fireEvent.click(await screen.findByRole("button", { name: /click to start/i }));
  if (tab) fireEvent.click(screen.getByRole("button", { name: tab }));
}

describe("1P stages", () => {
  it("unlock on how many records I posted and my best: three records with a 5200 open America, Africa and Europe, Asia stays locked", async () => {
    const mine = (id: string, target: number) => ({ ...prize, id, createdAt: 5, storage: { ...storage, champion: me, target } });
    chain.notes = [mine("0xa", 5200), mine("0xb", 100), mine("0xc", 100)];
    await start();
    await screen.findByRole("button", { name: "Europe" });
    expect(screen.getByRole("button", { name: "America" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Africa" })).toBeEnabled();
    const asia = screen.getByRole("button", { name: /^Asia: 4 records, 1 above 6,000$/ });
    expect(asia).toBeDisabled();
    // the picked map takes the screen, the tab and the title follow, the World Tour becomes a tile
    fireEvent.click(screen.getByRole("button", { name: "Europe" }));
    expect(screen.getByRole("img", { name: "Europe" })).toBeInTheDocument();
    expect(screen.getByText("1P Europe", { selector: ".panel-title" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "World" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Europe" })).toBeNull();
  });

  it("need both: one 6500 record opens America alone, four small ones open nothing", async () => {
    const mine = (id: string, target: number) => ({ ...prize, id, createdAt: 5, storage: { ...storage, champion: me, target } });
    chain.notes = [mine("0xa", 6500)];
    await start();
    expect(await screen.findByRole("button", { name: "America" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Africa: 2 records, 1 above 4,000$/ })).toBeDisabled();
    cleanup();
    chain.notes = [mine("0xa", 100), mine("0xb", 100), mine("0xc", 100), mine("0xd", 100)];
    await start();
    expect(await screen.findByRole("button", { name: /^America: 1 record above 3,000$/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Asia: 4 records, 1 above 6,000$/ })).toBeDisabled();
  });

  it("are not shown until the notes are read, then open or locked", async () => {
    let release!: () => void;
    vi.mocked(listChallengeNotes).mockImplementationOnce(() => new Promise((r) => (release = () => r(chain.notes))));
    chain.notes = [{ ...prize, id: "0xmine", createdAt: 5, storage: { ...storage, champion: me, target: 5200 } }];
    await start();
    await screen.findByRole("img", { name: "World map" });
    expect(screen.queryByRole("group", { name: "Stages" })).toBeNull();
    release();
    expect(await screen.findByRole("button", { name: "America" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Asia: 4 records, 1 above 6,000$/ })).toBeDisabled();
  });

  it("say Loading bonus maps while the wallet is still reconnecting", async () => {
    wallet.connected = false;
    wallet.connecting = true;
    await start();
    await screen.findByRole("img", { name: "World map" });
    expect(screen.queryByRole("group", { name: "Stages" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Loading bonus maps");
    // the wallet gave up (seen on the next render): nothing of mine, every stage locked
    wallet.connecting = false;
    fireEvent.click(screen.getByRole("button", { name: /player hub/i }));
    fireEvent.click(screen.getByRole("button", { name: /1p world tour/i }));
    expect(await screen.findByRole("button", { name: /^America: 1 record above 3,000$/ })).toBeDisabled();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("without a record of mine every stage is locked and says what it needs", async () => {
    chain.notes = [];
    await start();
    const america = await screen.findByRole("button", { name: /^America: 1 record above 3,000$/ });
    expect(america).toBeDisabled();
    // the whole line on a desktop, the two numbers alone beside the lock on a phone (CSS picks), the button's name always the whole line
    expect(america.querySelector(".need .full")).toHaveTextContent("1 record above 3,000");
    expect(america.querySelector(".need .short")).toHaveTextContent(/^1 · 3k$/);
    expect(screen.getByRole("img", { name: "World map" })).toBeInTheDocument();
  });

  it("a shot at an Asia record plays on the Asia map with the Asia cities", async () => {
    const game = encodeGame({ seed: [0n, 0n, 0n, 0n], dataset: [9n, 9n, 9n, 9n], cities });
    chain.shared = { ...prize, storage: { ...storage, game } };
    chain.notes = [chain.shared, { ...prize, id: "0xmine", createdAt: 5, storage: { ...storage, champion: me, target: 6500 } }];
    bread.postShot.mockResolvedValue({ txId: "tx", noteIds: ["0xnew"], deadline: 220 });
    window.history.replaceState({}, "", "/?record=0xp");
    render(<AppContent />);
    fireEvent.click(await screen.findByRole("button", { name: /insert gamecoin/i }));
    expect(await screen.findByText(/find s0!/i)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Asia" })).toBeInTheDocument();
  });

  it("a record on a stage I have not unlocked can still be played: a shot needs no record of mine", async () => {
    const game = encodeGame({ seed: [0n, 0n, 0n, 0n], dataset: [9n, 9n, 9n, 9n], cities });
    chain.shared = { ...prize, storage: { ...storage, game } };
    chain.notes = [chain.shared];
    bread.postShot.mockResolvedValue({ txId: "tx", noteIds: ["0xnew"], deadline: 220 });
    window.history.replaceState({}, "", "/?record=0xp");
    render(<AppContent />);
    expect(await screen.findByText("Asia", { selector: ".value" })).toBeInTheDocument();
    expect(screen.queryByText(/You need a record/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /insert gamecoin/i }));
    expect(await screen.findByText(/find s0!/i)).toBeInTheDocument();
    expect(bread.postShot).toHaveBeenCalled();
  });
});

describe("shared record link, connected as a stranger", () => {
  beforeEach(() => window.history.replaceState({}, "", "/?record=0xp"));

  it("lands on VS, posts one shot on Insert Gamecoin, then starts the quiz when the note is on chain", async () => {
    bread.postShot.mockResolvedValue({ txId: "tx", noteIds: ["0xnew"], deadline: 220 });
    render(<AppContent />);
    const button = await screen.findByRole("button", { name: /insert gamecoin/i });
    fireEvent.click(button);
    await waitFor(() => expect(bread.postShot).toHaveBeenCalledTimes(1));
    expect(bread.postShot.mock.calls[0][2]).toEqual(prize);
    await screen.findByText(/find c0!/i);
    expect(screen.getByText(/beat my record/i)).toBeInTheDocument();
  });

  it("with fewer Gamecoins than the stake on the shop's own line, Insert Gamecoin says so and asks the wallet nothing more", async () => {
    bread.gcBalance.mockResolvedValueOnce(500_000n);
    render(<AppContent />);
    expect(await screen.findByText(/^You have 0\.5 Gamecoins\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /insert gamecoin/i }));
    expect(await screen.findByText(/Not enough Gamecoins/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^buy gamecoins$/i })).toBeInTheDocument();
    expect(bread.postShot).not.toHaveBeenCalled();
    expect(bread.gcBalance).toHaveBeenCalledTimes(1);
  });

  it("does not post a second shot while one is open: it goes straight to the quiz", async () => {
    chain.notes = [prize, myShot];
    render(<AppContent />);
    fireEvent.click(await screen.findByRole("button", { name: /^play$/i }));
    await screen.findByText(/find c0!/i);
    expect(bread.postShot).not.toHaveBeenCalled();
  });

  it("comes back to the record, error shown, when the wallet never finishes (Bread fails after approval)", async () => {
    bread.postShot.mockResolvedValue({ txId: "tx", noteIds: ["0xnew"], deadline: 220 });
    vi.mocked(waitForMock).mockResolvedValueOnce(false);
    render(<AppContent />);
    fireEvent.click(await screen.findByRole("button", { name: /insert gamecoin/i }));
    await screen.findByText(/did not go through yet/i);
    expect(screen.getByRole("button", { name: /insert gamecoin/i })).toBeInTheDocument();
  });

  it("Back leaves a request that hangs and returns to the record", async () => {
    bread.postShot.mockReturnValue(new Promise(() => undefined));
    render(<AppContent />);
    fireEvent.click(await screen.findByRole("button", { name: /insert gamecoin/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^back$/i }));
    expect(await screen.findByRole("button", { name: /insert gamecoin/i })).toBeInTheDocument();
  });

  it("saying no in the wallet keeps the record on screen, says so plainly, and Try again asks again", async () => {
    bread.postShot.mockRejectedValueOnce(Object.assign(new Error("NOT_GRANTED"), { name: "WalletTransactionError" }));
    bread.postShot.mockResolvedValueOnce({ txId: "tx", noteIds: ["0xnew"], deadline: 220 });
    render(<AppContent />);
    fireEvent.click(await screen.findByRole("button", { name: /insert gamecoin/i }));
    await screen.findByText(/you said no in your wallet/i);
    expect(screen.getByRole("button", { name: /insert gamecoin/i })).toBeInTheDocument();
    expect(screen.queryByText(/NOT_GRANTED/)).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await screen.findByText(/find c0!/i);
    expect(bread.postShot).toHaveBeenCalledTimes(2);
  });

  it("Try again after a wallet that did not finish first checks the chain: no second Gamecoin", async () => {
    bread.postShot.mockResolvedValue({ txId: "tx", noteIds: ["0xnew"], deadline: 220 });
    vi.mocked(waitForMock).mockResolvedValueOnce(false);
    render(<AppContent />);
    fireEvent.click(await screen.findByRole("button", { name: /insert gamecoin/i }));
    await screen.findByText(/did not go through yet/i);
    // the shot landed late, while the player read the message
    vi.mocked(knownNote).mockResolvedValue({ consumed: false });
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await screen.findByText(/find c0!/i);
    expect(bread.postShot).toHaveBeenCalledTimes(1);
  });

  it("a record that fails to load says why and loads on Try again", async () => {
    vi.mocked(fetchChallengeNote).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(<AppContent />);
    await screen.findByText(/network is slow or busy/i);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByRole("button", { name: /insert gamecoin/i })).toBeInTheDocument();
    expect(screen.queryByText(/network is slow or busy/i)).toBeNull();
  });

  it("a failing background sync only shows a NETWORK SLOW tag, never an error box", async () => {
    vi.mocked(syncNotes).mockRejectedValue(new TypeError("Failed to fetch"));
    render(<AppContent />);
    await screen.findByText(/network slow/i);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a record the background sync sees consumed (just won, or taken by someone) is shown as over", async () => {
    chain.notes = [{ ...prize, consumed: true }];
    render(<AppContent />);
    await screen.findByText(/this one is over/i);
    expect(screen.queryByRole("button", { name: /insert gamecoin/i })).toBeNull();
  });

  it("shows a claimed record as gone, with no button", async () => {
    chain.shared = { ...prize, consumed: true };
    render(<AppContent />);
    await screen.findByText(/this one is over/i);
    expect(screen.queryByRole("button", { name: /insert gamecoin|^play$/i })).toBeNull();
  });
});

it("a family's other flags stack above the framed one, and a picked variant takes the slot", async () => {
  render(<AppContent />);
  expect(await screen.findByRole("button", { name: "English (US)" })).toHaveAttribute("aria-pressed", "true");
  // nothing is open until a framed flag is clicked
  expect(screen.queryByRole("button", { name: "English (UK)" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Português (Brasil)" }));
  expect(document.documentElement.lang).toBe("pt-BR");
  fireEvent.click(screen.getByRole("button", { name: "Português (Portugal)" }));
  expect(document.documentElement.lang).toBe("pt-PT");
  const pt = screen.getByRole("button", { name: "Português (Portugal)" });
  expect(pt).toHaveAttribute("aria-pressed", "true");
  // the pick folded the stack; the framed flag opens it again
  expect(screen.queryByRole("button", { name: "Português (Brasil)" })).toBeNull();
  fireEvent.click(pt);
  expect(screen.getByRole("button", { name: "Português (Brasil)" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Clica para começar" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "English (US)" }));
  fireEvent.click(screen.getByRole("button", { name: "English (UK)" }));
  expect(screen.getByRole("button", { name: "Click to start, bruv" })).toBeInTheDocument();
});

it("a click anywhere on the splash picture starts the game", async () => {
  const { container } = render(<AppContent />);
  await screen.findByRole("button", { name: /click to start/i });
  fireEvent.click(container.querySelector(".welcome > img")!);
  expect(await screen.findByRole("button", { name: /player hub/i })).toBeInTheDocument();
});

describe("Simplified Chinese", () => {
  it("the China flag turns the start line into 点击开始, which starts in Chinese: tabs and cities in Chinese", async () => {
    render(<AppContent />);
    const cn = await screen.findByRole("button", { name: "中文 (简体)" });
    expect(screen.getByRole("button", { name: "English (US)" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(cn);
    expect(cn).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "English (US)" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: /点击开始/ }));
    expect(document.documentElement.lang).toBe("zh-Hans");
    expect(localStorage.getItem("gq.lang")).toBe("zh-Hans");
    expect(screen.getByRole("button", { name: "玩家中心" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "定位第一座城市" }));
    // the quiz names the city in Chinese (places.zh-Hans.json), the dataset untouched
    expect(await screen.findByText(/找到城\d！/)).toBeInTheDocument();
  });

  it("the X post stays English: a Hub card's share names Paris, not 巴黎", async () => {
    localStorage.setItem("gq.lang", "zh-Hans");
    const f = fetch;
    vi.stubGlobal("fetch", async (url: string) =>
      url.endsWith("/cities.json")
        ? { ok: true, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(cities.map((c) => ({ name: c.idx ? `c${c.idx}` : "Paris", country: "x", lat: 0, lon: 0 })))).buffer }
        : url.includes("places.zh")
          ? { ok: true, json: async () => ({ "Paris|x": ["巴黎", "国"] }) }
          : f(url),
    );
    chain.notes = [{ ...prize, createdAt: 5, storage: { ...storage, champion: me } }];
    render(<AppContent />);
    fireEvent.click(await screen.findByRole("button", { name: /点击开始/ }));
    fireEvent.click(screen.getByRole("button", { name: "玩家中心" }));
    const href = (await screen.findByRole("link", { name: "分享到 X" })).getAttribute("href")!;
    expect(decodeURIComponent(href)).toContain("Paris");
  });

  it("remembers the language on the next visit: the splash starts in Chinese", async () => {
    localStorage.setItem("gq.lang", "zh-Hans");
    render(<AppContent />);
    expect(await screen.findByRole("button", { name: /点击开始/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "中文 (简体)" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("横着拿手机，地图更好玩。")).toBeInTheDocument();
  });
});

describe("welcome and 1P World Tour", () => {
  it("the GeoQuizz wordmark goes back to the splash screen without reloading, sound choice kept", async () => {
    await start();
    fireEvent.click(await screen.findByRole("button", { name: /sound on/i }));
    fireEvent.click(screen.getByRole("link", { name: /geoquizz home/i }));
    fireEvent.click(await screen.findByRole("button", { name: /click to start/i }));
    expect(await screen.findByRole("button", { name: /sound off/i })).toBeInTheDocument();
  });

  it("OK after a round goes back to the splash screen: after posting a record, after losing a shot", async () => {
    bread.postRecord.mockResolvedValue({ txId: "tx", noteIds: ["0xnew"] });
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
    try {
      await start();
      fireEvent.click(await screen.findByRole("button", { name: /locate first city/i }));
      await playRound();
      fireEvent.click(await screen.findByRole("button", { name: /post it/i }));
      await screen.findByText(/record posted!/i);
      fireEvent.click(screen.getByRole("button", { name: /^ok$/i }));
      await screen.findByRole("button", { name: /click to start/i });

      // a shot at a record nobody can beat (score 0 is never above the target)
      chain.notes = [prize, myShot];
      fireEvent.click(screen.getByRole("button", { name: /click to start/i }));
      fireEvent.click(screen.getByRole("button", { name: /player hub/i }));
      fireEvent.click(screen.getByRole("button", { name: /^refresh$/i }));
      fireEvent.click(await screen.findByRole("button", { name: /^play$/i }));
      await playRound();
      await screen.findByText(/the record stands/i);
      // the shot is still open: the same quiz can be played again without paying
      expect(screen.getByText(/shot ends: /i)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /try again/i }));
      expect(bread.postShot).not.toHaveBeenCalled();
      await playRound();
      await screen.findByText(/the record stands/i);
      fireEvent.click(screen.getByRole("button", { name: /^ok$/i }));
      await screen.findByRole("button", { name: /click to start/i });
    } finally {
      vi.useRealTimers();
    }
  });

  it("the leaderboards are public: they show without a wallet", async () => {
    const record = { ...prize, createdAt: 5, storage: { ...prize.storage, champion: me } };
    chain.notes = [record];
    wallet.connected = false;
    await start(/leaderboards/i);
    expect(await screen.findByText("2,000")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /connect wallet/i })).toBeInTheDocument();
  });

  it("reads the game's notes once, then only on Refresh: the height still ticks every 15 s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setInterval", "clearInterval"] });
    try {
      await start(/leaderboards/i);
      await waitFor(() => expect(listChallengeNotes).toHaveBeenCalledTimes(1));
      const syncs = vi.mocked(syncNotes).mock.calls.length;
      await act(async () => void vi.advanceTimersByTime(31_000));
      expect(vi.mocked(syncNotes).mock.calls.length).toBeGreaterThan(syncs);
      expect(listChallengeNotes).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole("button", { name: /^refresh$/i }));
      await waitFor(() => expect(listChallengeNotes).toHaveBeenCalledTimes(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the development wallets' test rounds off the boards", async () => {
    chain.notes = [{ ...prize, createdAt: 5 }, { ...prize, id: "0xt", createdAt: 6, storage: { ...prize.storage, champion: me, target: 9690 } }];
    vi.mocked(hexOf).mockImplementation((a) => (a === me ? "0x071d3da3ad56d88175b628f76073cb" : "0xreal"));
    await start(/leaderboards/i);
    expect(await screen.findByText("2,000")).toBeInTheDocument();
    expect(screen.queryByText("9,690")).toBeNull();
  });

  it("the wallet button shows my arcade name", async () => {
    await start();
    expect(await screen.findByRole("button", { name: "Wallet / JHT" })).toBeInTheDocument();
  });

  it("the ribbon says the game runs on mainnet", async () => {
    await start();
    expect(screen.getByText("Mainnet")).toBeInTheDocument();
  });

  it("on a phone turned sideways mid-quiz, the map and the city panel scroll up to fill the screen", async () => {
    let sideways = false;
    const turns: (() => void)[] = [];
    vi.stubGlobal("matchMedia", (q: string) => ({
      get matches() {
        return q.includes("landscape") && sideways;
      },
      addEventListener: (_: string, f: () => void) => turns.push(f),
      removeEventListener: () => undefined,
    }));
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    try {
      await start();
      fireEvent.click(await screen.findByRole("button", { name: /locate first city/i }));
      await screen.findByText(/find c0!/i);
      expect(scroll).not.toHaveBeenCalled();
      sideways = true;
      turns.forEach((f) => f());
      expect(scroll).toHaveBeenCalledWith({ block: "start" });
    } finally {
      vi.unstubAllGlobals();
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("plays before any wallet is connected; the rival sprite stays out of a solo run", async () => {
    wallet.connected = false;
    await start();
    fireEvent.click(await screen.findByRole("button", { name: /locate first city/i }));
    await screen.findByText(/find c0!/i);
    expect(screen.queryByText(/beat my record/i)).toBeNull();
    expect(wallet.connect).not.toHaveBeenCalled();
  });
});

describe("open challenges in Champion vs Rival", () => {
  const listed = (id: string, target: number, more: Partial<ChallengeNote> = {}, expiryBlock = RECORD_LIFETIME_BLOCKS - 800): ChallengeNote => ({
    ...prize,
    id,
    createdAt: 5,
    ...more,
    storage: { ...prize.storage, target, expiryBlock, ...more.storage },
  });

  it("lists funded, unclaimed records a rival can still take a shot at, under the code box", async () => {
    chain.notes = [
      listed("0xo", 3100),
      listed("0xclaimed", 3200, { consumed: true }),
      listed("0xempty", 3300, { amount: 0n }),
      listed("0xover", 3400, {}, 100),
      listed("0xlate", 3500, {}, 100 + MIN_SHOT_WINDOW_BLOCKS - 1),
      { ...myShot, storage: { ...myShot.storage, target: 3600 } },
      listed("0xtest", 3700, { storage: { ...prize.storage, champion: me } }),
    ];
    vi.mocked(hexOf).mockImplementation((a) => (a === me ? "0x071d3da3ad56d88175b628f76073cb" : "0xreal"));
    await start(/^champion vs rival$/i);
    expect(await screen.findByText("3,100 pts")).toBeInTheDocument();
    expect(screen.getByText(/have a code\?/i)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /view challenge/i })).toHaveLength(1);
    expect(screen.queryByText(/3,[2-7]00/)).toBeNull();
  });

  it("names the map of a record on a stage, next to its score", async () => {
    chain.notes = [listed("0xa", 3100, { storage: { ...storage, target: 3100, game: encodeGame({ seed: [0n, 0n, 0n, 0n], dataset: [9n, 9n, 9n, 9n], cities }) } })];
    await start(/^champion vs rival$/i);
    expect(await screen.findByRole("button", { name: "View challenge, 3,100 pts, Asia" })).toBeInTheDocument();
    expect(screen.getByText("Asia", { selector: ".tag" })).toBeInTheDocument();
  });

  it("lists the lowest score first, each with a countdown to its expiry instead of the prize", async () => {
    chain.notes = [listed("0xb", 3300), listed("0xa", 3100, {}, 100 + Math.round(3600 / BLOCK_SECONDS) + 1)];
    await start(/^champion vs rival$/i);
    const rows = await screen.findAllByRole("button", { name: /view challenge/i });
    expect(rows.map((b) => b.getAttribute("aria-label"))).toEqual(["View challenge, 3,100 pts, World", "View challenge, 3,300 pts, World"]);
    expect(screen.getByText(/Ends in 1:00:0[0-6]/)).toBeInTheDocument();
    expect(screen.getByText(/Ends in 63:\d\d:\d\d/)).toBeInTheDocument();
    expect(screen.queryByText(/prize/i)).toBeNull();
  });

  it("says so when there is none, and reads the notes again on its Refresh button", async () => {
    await start(/^champion vs rival$/i);
    expect(await screen.findByText("No open challenges yet.")).toBeInTheDocument();
    expect(listChallengeNotes).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /^refresh$/i }));
    await waitFor(() => expect(listChallengeNotes).toHaveBeenCalledTimes(2));
  });

  it("View challenge opens the record card at once, in focus, then as the node has it now", async () => {
    chain.notes = [listed("0xo", 3100)];
    chain.shared = listed("0xo", 3100, { consumed: true }); // taken since the list was read
    await start(/^champion vs rival$/i);
    fireEvent.click(await screen.findByRole("button", { name: "View challenge, 3,100 pts, World" }));
    expect(document.activeElement).toBe(screen.getByText("3,100 pts to beat").closest("section"));
    expect(fetchChallengeNote).toHaveBeenCalledWith("0xo");
    expect(await screen.findByText(/this one is over/i)).toBeInTheDocument();
  });

  it("a slow answer for an earlier pick never replaces the later one", async () => {
    chain.notes = [listed("0xa", 3100), listed("0xb", 3200)];
    let answerA: (n: ChallengeNote) => void = () => {};
    vi.mocked(fetchChallengeNote)
      .mockImplementationOnce(() => new Promise((r) => (answerA = r)))
      .mockImplementationOnce(async () => listed("0xb", 3200));
    await start(/^champion vs rival$/i);
    fireEvent.click(await screen.findByRole("button", { name: "View challenge, 3,100 pts, World" }));
    fireEvent.click(screen.getByRole("button", { name: "View challenge, 3,200 pts, World" }));
    await act(async () => answerA(listed("0xa", 3100)));
    expect(screen.getByText("3,200 pts to beat")).toBeInTheDocument();
    expect(screen.queryByText("3,100 pts to beat")).toBeNull();
  });

  it("the 1P box says how to challenge rivals and links to Champion vs Rival", async () => {
    await start();
    expect(screen.getByText("Free to play. Once you're happy with your score, post it on X to challenge your rivals.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Find a challenge in CHAMPION VS RIVAL mode →" }));
    expect(await screen.findByText("Open challenges")).toBeInTheDocument();
    expect(screen.getByText(/have a code\?/i)).toBeInTheDocument();
  });

  it("the code box and the shop (with the wallet's balance) share a column, the open challenges stand beside it", async () => {
    await start(/^champion vs rival$/i);
    const stack = screen.getByText(/have a code\?/i).closest(".stack");
    expect(stack).toContainElement(screen.getByRole("button", { name: /^buy$/i }));
    expect(stack).toContainElement(await screen.findByText(/^You have 12 Gamecoins\./));
    expect(stack).not.toContainElement(await screen.findByText("Open challenges"));
  });

  it("asks the wallet for the balance only once a shop is on screen (Bread confirms each read), not on connect", async () => {
    await start();
    expect(bread.gcBalance).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^champion vs rival$/i }));
    expect(await screen.findByText(/^You have 12 Gamecoins\./)).toBeInTheDocument();
    expect(bread.gcBalance).toHaveBeenCalledTimes(1);
  });
});

describe("home, connected", () => {
  const sale = (id: string, offered: bigint, asked: bigint) => ({ id, creator: "0xc", gcFaucet: GC_FAUCET, payFaucet: "0xpay", offered, asked, minFill: 0n });

  it("buys Gamecoin from the cheapest sale note at or under the price, and says so once the chain shows it", async () => {
    vi.mocked(useMidenClient).mockReturnValue({ feeFaucetId: async () => ({ toString: () => "0xpay" }) } as never);
    // 10 GC for 0.01 (the price) and 10 GC for 0.005: the cheaper one sells
    shop.openSales.mockResolvedValue([sale("0xfull", 10_000_000n, 10_000n), sale("0xcheap", 10_000_000n, 5_000n)]);
    bread.buyGamecoin.mockResolvedValue({ txId: "0xt", noteIds: ["0xcheap"] });
    vi.mocked(knownNote).mockResolvedValue({ consumed: true });
    await start(/^champion vs rival$/i);
    fireEvent.change(screen.getByRole("spinbutton", { name: /how many/i }), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: /^buy$/i }));
    await screen.findByText("2 Gamecoins in your wallet.");
    expect(bread.buyGamecoin).toHaveBeenCalledWith(expect.anything(), wallet, expect.objectContaining({ id: "0xcheap" }), 2_000_000n);
    // the balance line is not read again (one more Bread popup): it goes quiet until the next shop visit
    fireEvent.click(screen.getByRole("button", { name: /^ok$/i }));
    expect(screen.queryByText(/^You have /)).toBeNull();
    expect(bread.gcBalance).toHaveBeenCalledTimes(1);
  });

  it("buys 1 to 100 at a time, whatever is typed", async () => {
    vi.mocked(useMidenClient).mockReturnValue({ feeFaucetId: async () => ({ toString: () => "0xpay" }) } as never);
    shop.openSales.mockResolvedValue([sale("0xbig", 1_000_000_000n, 1_000_000n)]);
    bread.buyGamecoin.mockResolvedValue({ txId: "0xt", noteIds: ["0xbig"] });
    vi.mocked(knownNote).mockResolvedValue({ consumed: true });
    await start(/^champion vs rival$/i);
    fireEvent.change(screen.getByRole("spinbutton", { name: /how many/i }), { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: /^buy$/i }));
    await screen.findByText("100 Gamecoins in your wallet.");
    expect(bread.buyGamecoin).toHaveBeenLastCalledWith(expect.anything(), wallet, expect.anything(), 100_000_000n);
  });

  it("says so when nothing is on sale (a sale asking more than the price is never listed: shop.test)", async () => {
    vi.mocked(useMidenClient).mockReturnValue({ feeFaucetId: async () => ({ toString: () => "0xpay" }) } as never);
    shop.openSales.mockResolvedValue([]);
    await start(/^champion vs rival$/i);
    fireEvent.click(screen.getByRole("button", { name: /^buy$/i }));
    await screen.findByText("No Gamecoin on sale right now. Try again later.");
    expect(bread.buyGamecoin).not.toHaveBeenCalled();
  });

  it("settles all my open shots at the record with one play", async () => {
    const second = { ...myShot, id: "0xc2", idWord: [2n, 2n, 2n, 2n] as [bigint, bigint, bigint, bigint] };
    chain.notes = [prize, myShot, second];
    await start(/player hub/i);
    await screen.findAllByText(/my shot/i);
    // one "Play" per open shot
    const buttons = screen.getAllByRole("button", { name: /^play$/i });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]);
    await screen.findByText(/find c0!/i);
  });

  it("opens a record from a pasted code", async () => {
    await start(/^champion vs rival$/i);
    await screen.findByText(/have a code\?/i);
    fireEvent.change(screen.getByPlaceholderText(/paste the link or code/i), {
      target: { value: "http://x/?record=0x62ea91634f23d65b4bcae5eb027ea1cad37be056412618cad17de9c3171e1ee8" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^go$/i }));
    await screen.findByText(/2,?000 pts to beat/i);
  });
});
