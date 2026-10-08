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
  player: null,
  prizeId: [0n, 0n, 0n, 0n],
  challengeRoot: [1n, 1n, 1n, 1n],
  seed: [0n, 0n, 0n, 0n],
  dataset: [0n, 0n, 0n, 0n],
  cities: [],
  challengeDeadline: 0,
};
const prize: GqNote = { id: "0xp", idWord: [9n, 9n, 9n, 9n], kind: "prize", storage: base, amount: 1_000_000n, consumed: false };
const myChallenge: GqNote = {
  id: "0xc",
  idWord: [1n, 1n, 1n, 1n],
  kind: "challenge",
  storage: { ...base, player: me, prizeId: [9n, 9n, 9n, 9n], challengeDeadline: 200 },
  amount: 1_000_000n,
  consumed: false,
};

const handlers = () => ({ onChallenge: vi.fn(), onSettle: vi.fn(), onCollect: vi.fn() });

describe("Lobby", () => {
  it("lets a stranger challenge an open prize and passes the prize to the handler", () => {
    const h = handlers();
    render(<Lobby me={me} notes={[prize]} height={100} {...h} />);
    fireEvent.click(screen.getByRole("button", { name: /play \(1 GQ\)/i }));
    expect(h.onChallenge).toHaveBeenCalledWith(prize);
  });

  it("shows the champion their own prize without a challenge button, and reclaim only once expired", () => {
    const h = handlers();
    const { rerender } = render(<Lobby me={champion} notes={[prize]} height={100} {...h} />);
    expect(screen.queryByRole("button", { name: /play/i })).toBeNull();
    expect(screen.getByText(/yours/)).toBeInTheDocument();
    rerender(<Lobby me={champion} notes={[prize]} height={1000} {...h} />);
    fireEvent.click(screen.getByRole("button", { name: /take it back/i }));
    expect(h.onCollect).toHaveBeenCalledWith(prize);
  });

  it("offers Play & settle on my open challenge with its prize, and nothing once its deadline passed", () => {
    const h = handlers();
    const { rerender } = render(<Lobby me={me} notes={[prize, myChallenge]} height={100} {...h} />);
    fireEvent.click(screen.getByRole("button", { name: /^play$/i }));
    expect(h.onSettle).toHaveBeenCalledWith(myChallenge, prize);
    rerender(<Lobby me={me} notes={[prize, myChallenge]} height={200} {...h} />);
    expect(screen.queryByRole("button", { name: /^play$/i })).toBeNull();
  });

  it("lets the champion collect a challenge only from its deadline on", () => {
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
