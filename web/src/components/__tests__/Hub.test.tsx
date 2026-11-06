// The Hub's history and the public boards: pure views over rows the chain gave.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { HistoryItem, Ranked } from "@/lib/hub";
import { History } from "../History";
import { Leaderboards } from "../Leaderboards";

// blocks under 95 were made yesterday
vi.mock("@/lib/chain", () => ({ blockTime: vi.fn(async (b: number) => Date.now() - (b < 95 ? 86_400_000 : 0)), scanProgress: { subscribe: () => () => {}, get: () => null } }));

const item = (i: number, kind: "record" | "shot" = "record"): HistoryItem => ({ id: `0x${i}`, kind, at: 100 - i, result: "Defended", context: "", score: i, detail: "5 tries lost", money: "1 Gamecoin back", note: "", tone: "mint", moneyTone: "" });

describe("History", () => {
  it("shows ten games, MORE adds the rest, then says that's all", async () => {
    render(<History items={Array.from({ length: 12 }, (_, i) => item(i))} />);
    expect(screen.getAllByRole("article")).toHaveLength(10);
    expect(screen.queryByText(/that's all/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /more/i }));
    expect(screen.getAllByRole("article")).toHaveLength(12);
    expect(screen.getByText("That's all your games.")).toBeInTheDocument();
    expect(await screen.findAllByText(/^\d\d:\d\d$/)).toHaveLength(12);
  });

  it("groups games by the day they ended, the row keeps only the time", async () => {
    render(<History items={[item(1), item(2), item(7)]} />);
    expect(await screen.findByRole("heading", { name: "TODAY" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "YESTERDAY" })).toBeInTheDocument();
    expect(screen.queryByText(/TODAY \d/)).toBeNull();
  });

  it("leads with the result, labels whose score it is, and keeps money apart", () => {
    render(<History items={[{ ...item(1, "shot"), result: "You won", context: "MUD's record: ", score: 6200, detail: "", money: "1 Gamecoin won", note: "Your Gamecoin back." }]} />);
    expect(screen.getByRole("article", { name: "You won" })).toHaveTextContent("My shotYou wonMUD's record: 6,200 pts1 Gamecoin wonYour Gamecoin back.");
  });

  it("filters my records from my shots, ten of the picked kind at a time, and says when a kind has none", () => {
    render(<History items={[...Array.from({ length: 11 }, (_, i) => item(i)), item(11, "shot")]} />);
    fireEvent.click(screen.getByRole("tab", { name: /my records/i }));
    expect(screen.getAllByRole("article")).toHaveLength(10);
    fireEvent.click(screen.getByRole("button", { name: /more/i }));
    expect(screen.getAllByRole("article")).toHaveLength(11);
    fireEvent.click(screen.getByRole("tab", { name: /my shots/i }));
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByRole("tab", { name: /my shots/i })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "Home" });
    expect(screen.getByRole("tab", { name: /^all$/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByRole("article")).toHaveLength(10);
    render(<History items={[item(1)]} />);
    fireEvent.click(screen.getAllByRole("tab", { name: /my shots/i })[1]);
    expect(screen.getByText("No past shots yet.")).toBeInTheDocument();
  });

  it("says when it is loading, when there is nothing yet, and shows the connect prompt instead of games", () => {
    const { rerender } = render(<History items={null} />);
    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);
    rerender(<History items={[]} />);
    expect(screen.getByText("No past games yet.")).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).toBeNull();
    rerender(<History items={[item(1)]} connect={<p>Connect to see your games.</p>} />);
    expect(screen.queryByRole("article")).toBeNull();
  });
});

const ME = { suffix: 1n, prefix: 1n };
const other = (i: number) => ({ suffix: BigInt(i + 10), prefix: 0n });
const ranked = (who: { suffix: bigint; prefix: bigint }, rank: number, value: number): Ranked => ({ key: `${rank}`, who, value, at: rank, rank });
const empty = { top: [], mine: null };
const name = (a: { suffix: bigint }) => (a.suffix === 1n ? "JHT" : `P${a.suffix}`);

describe("Leaderboards", () => {
  it("lists rank, name and number; my rows are marked, and my rank shows below a top 10 I am not in", () => {
    const top = Array.from({ length: 10 }, (_, i) => ranked(other(i), i + 1, 100 - i));
    const data = { coins: { top: [ranked(other(0), 1, 12), ranked(ME, 2, 10)], mine: null }, records: { top, mine: ranked(ME, 18, 6800) }, defended: empty, smashed: empty, losers: empty };
    render(<Leaderboards data={data} me={ME} name={name} />);
    const mine = screen.getAllByLabelText("Your row");
    expect(mine.map((r) => r.textContent)).toEqual(["02JHT10", "18JHT6,800"]);
    expect(screen.getByText("No rivals beaten yet.")).toBeInTheDocument();
    expect(screen.getByText("No records yet.")).toBeInTheDocument();
  });

  it("marks nothing as mine without a wallet, says LOADING before the first read, and picks a board on narrow screens", () => {
    const data = { coins: { top: [ranked(ME, 1, 3)], mine: null }, records: empty, defended: empty, smashed: empty, losers: empty };
    const { rerender, container } = render(<Leaderboards data={data} me={null} name={name} />);
    expect(screen.queryByLabelText("Your row")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^wins$/i }));
    expect(container.querySelector(".high-scores")?.getAttribute("data-pick")).toBe("wins");
    expect(screen.getByRole("button", { name: /^wins$/i })).toHaveAttribute("aria-pressed", "true");
    rerender(<Leaderboards data={null} me={null} name={name} />);
    expect(screen.getAllByRole("status")).toHaveLength(5);
  });
});
