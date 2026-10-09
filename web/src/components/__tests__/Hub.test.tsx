// The Hub's history and the public boards: pure views over rows the chain gave.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { HistoryItem, Ranked } from "@/lib/hub";
import { History } from "../History";
import { Leaderboards } from "../Leaderboards";

vi.mock("@/lib/chain", () => ({ blockTime: vi.fn(async () => Date.now()) }));

const item = (i: number): HistoryItem => ({ id: `0x${i}`, kind: "record", at: 100 - i, title: `${i} pts`, lines: ["5 tries lost"], tone: "mint" });

describe("History", () => {
  it("shows ten games, MORE adds the rest, then says that's all", async () => {
    render(<History items={Array.from({ length: 12 }, (_, i) => item(i))} />);
    expect(screen.getAllByRole("article")).toHaveLength(10);
    expect(screen.queryByText(/that’s all/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /more/i }));
    expect(screen.getAllByRole("article")).toHaveLength(12);
    expect(screen.getByText("That’s all your games.")).toBeInTheDocument();
    expect(await screen.findAllByText(/^TODAY \d\d:\d\d$/)).toHaveLength(12);
  });

  it("says when it is loading, when there is nothing yet, and shows the connect prompt instead of games", () => {
    const { rerender } = render(<History items={null} />);
    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);
    rerender(<History items={[]} />);
    expect(screen.getByText("No past games yet.")).toBeInTheDocument();
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
    const data = { coins: { top: [ranked(other(0), 1, 12), ranked(ME, 2, 10)], mine: null }, scores: { top, mine: ranked(ME, 18, 6800) }, defended: empty, smashed: empty };
    render(<Leaderboards data={data} me={ME} name={name} />);
    const mine = screen.getAllByLabelText("Your row");
    expect(mine.map((r) => r.textContent)).toEqual(["02JHT10", "18JHT6,800"]);
    expect(screen.getByText("No rivals beaten yet.")).toBeInTheDocument();
    expect(screen.getByText("No records yet.")).toBeInTheDocument();
  });

  it("marks nothing as mine without a wallet, says LOADING before the first read, and picks a board on narrow screens", () => {
    const data = { coins: { top: [ranked(ME, 1, 3)], mine: null }, scores: empty, defended: empty, smashed: empty };
    const { rerender, container } = render(<Leaderboards data={data} me={null} name={name} />);
    expect(screen.queryByLabelText("Your row")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^records$/i }));
    expect(container.querySelector(".high-scores")?.getAttribute("data-pick")).toBe("records");
    expect(screen.getByRole("button", { name: /^records$/i })).toHaveAttribute("aria-pressed", "true");
    rerender(<Leaderboards data={null} me={null} name={name} />);
    expect(screen.getAllByRole("status")).toHaveLength(4);
  });
});
