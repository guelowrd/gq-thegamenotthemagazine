// The lobby is a pure view: given notes, the connected account and the chain height, it must
// show exactly the actions the rules allow.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GqNote } from "@/lib/chain";
import type { ChallengeStorage } from "@/lib/notes";
import { Lobby } from "../Lobby";

const champion = { suffix: 1n, prefix: 2n };
const me = { suffix: 3n, prefix: 4n };
const base: ChallengeStorage = {
  expiryBlock: 1000,
  target: 2000,
  minStake: 1_000_000n,
  champion,
  rival: null,
  recordId: [0n, 0n, 0n, 0n],
  shotRoot: [1n, 1n, 1n, 1n],
  seed: [0n, 0n, 0n, 0n],
  dataset: [0n, 0n, 0n, 0n],
  cities: [],
  shotDeadline: 0,
};
const prize: GqNote = { id: "0xp", idWord: [9n, 9n, 9n, 9n], kind: "record", storage: base, amount: 1_000_000n, consumed: false };
const myChallenge: GqNote = {
  id: "0xc",
  idWord: [1n, 1n, 1n, 1n],
  kind: "shot",
  storage: { ...base, rival: me, recordId: [9n, 9n, 9n, 9n], shotDeadline: 200 },
  amount: 1_000_000n,
  consumed: false,
};

const handlers = () => ({ onSettle: vi.fn(), onCollect: vi.fn() });

describe("Lobby", () => {
  it("never lists other people's records: they travel by link only", () => {
    render(<Lobby me={me} notes={[prize]} height={100} {...handlers()} />);
    expect(screen.queryByText(/3750|2000/)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows the champion their own record, and take-it-back only once expired", () => {
    const h = handlers();
    const { rerender } = render(<Lobby me={champion} notes={[prize]} height={100} {...h} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/waiting for a rival/)).toBeInTheDocument();
    rerender(<Lobby me={champion} notes={[prize]} height={1000} {...h} />);
    fireEvent.click(screen.getByRole("button", { name: /take it back/i }));
    expect(h.onCollect).toHaveBeenCalledWith(prize);
  });

  it("offers Play & settle on my open shot with its record, and nothing once its deadline passed", () => {
    const h = handlers();
    const { rerender } = render(<Lobby me={me} notes={[prize, myChallenge]} height={100} {...h} />);
    fireEvent.click(screen.getByRole("button", { name: /^play$/i }));
    expect(h.onSettle).toHaveBeenCalledWith(myChallenge, prize);
    rerender(<Lobby me={me} notes={[prize, myChallenge]} height={200} {...h} />);
    expect(screen.queryByRole("button", { name: /^play$/i })).toBeNull();
  });

  it("lets the champion collect a shot only from its deadline on", () => {
    const h = handlers();
    const { rerender } = render(<Lobby me={champion} notes={[prize, myChallenge]} height={199} {...h} />);
    expect(screen.queryByRole("button", { name: /take it/i })).toBeNull();
    rerender(<Lobby me={champion} notes={[prize, myChallenge]} height={200} {...h} />);
    fireEvent.click(screen.getByRole("button", { name: /take it/i }));
    expect(h.onCollect).toHaveBeenCalledWith(myChallenge);
  });

  it("hides consumed notes", () => {
    render(<Lobby me={me} notes={[{ ...prize, consumed: true }]} height={100} {...handlers()} />);
    expect(screen.queryByRole("button", { name: /play/i })).toBeNull();
  });
});
