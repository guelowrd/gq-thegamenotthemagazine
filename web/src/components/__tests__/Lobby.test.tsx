// The lobby is a pure view: given notes, the connected account and the chain height, it must
// show exactly the actions the rules allow.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GC_FAUCET } from "@/config";
import type { ChallengeNote } from "@/lib/chain";
import type { ChallengeStorage } from "@/lib/notes";
import { encodeGame } from "@/lib/quiz";
import { registerDataset, stageById } from "@/lib/stages";
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
  game: [],
  shotDeadline: 0,
};
const places = [{ name: "Funafuti", country: "Tuvalu", lat: 0, lon: 0 }];
// an Asia record: its dataset word is the Asia list's
registerDataset(stageById("asia"), [8n, 8n, 8n, 8n]);
const game = encodeGame({ seed: [0n, 0n, 0n, 0n], dataset: [8n, 8n, 8n, 8n], cities: Array.from({ length: 10 }, () => ({ idx: 0, lat: 0, lon: 0, cos: 0 })) });
const prize: ChallengeNote = { id: "0xp", idWord: [9n, 9n, 9n, 9n], kind: "record", storage: { ...base, game }, faucet: GC_FAUCET, amount: 1_000_000n, consumed: false };
const myShot: ChallengeNote = {
  id: "0xc",
  idWord: [1n, 1n, 1n, 1n],
  kind: "shot",
  storage: { ...prize.storage, rival: me, recordId: [9n, 9n, 9n, 9n], shotDeadline: 200 },
  faucet: GC_FAUCET,
  amount: 1_000_000n,
  consumed: false,
};

const props = () => ({ places: () => places, nameOf: () => "XTG", onCollect: vi.fn() });

describe("Lobby", () => {
  it("never lists other people's records: those are in Champion vs Rival", () => {
    render(<Lobby me={me} notes={[prize]} height={100} {...props()} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows the champion their own record, and take-it-back only CLAIM_FUZZ blocks past expiry (a claim may land until then)", () => {
    const h = props();
    const { rerender } = render(<Lobby me={champion} notes={[prize]} height={100} {...h} />);
    expect(screen.queryByRole("button", { name: /take it back/i })).toBeNull();
    expect(screen.getByText(/waiting for a rival/i)).toBeInTheDocument();
    // 900 blocks left: 45 minutes from now, as a clock time like the history's
    expect(screen.getByText(/^My record \/ open until (TODAY|TOMORROW) \d\d:\d\d$/)).toBeInTheDocument();
    // an open record can be shared again from the hub
    const href = screen.getByRole("link", { name: /share on x/i }).getAttribute("href")!;
    expect(href).toContain(encodeURIComponent("?record=0xp"));
    expect(decodeURIComponent(href)).toContain("Funafuti");
    expect(decodeURIComponent(href)).toContain("GQ Asia");
    expect(screen.queryByText(/on it/i)).toBeNull();
    rerender(<Lobby me={champion} notes={[prize]} height={1063} {...h} />);
    expect(screen.queryByRole("button", { name: /take it back/i })).toBeNull();
    rerender(<Lobby me={champion} notes={[prize]} height={1064} {...h} />);
    fireEvent.click(screen.getByRole("button", { name: /take it back/i }));
    expect(h.onCollect).toHaveBeenCalledWith([prize]);
  });

  it("shows my open shot with no Play button (one shot, no second try); once its deadline passed the card is gone (it is history)", () => {
    const h = props();
    const { rerender } = render(<Lobby me={me} notes={[prize, myShot]} height={100} {...h} />);
    expect(screen.getByText(/my shot/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^play$/i })).toBeNull();
    rerender(<Lobby me={me} notes={[prize, myShot]} height={200} {...h} />);
    expect(screen.queryByText(/my shot/i)).toBeNull();
  });

  it("never offers to take a shot I posted at my own record: the script serves its rival first, so it stays locked", () => {
    const own = { ...myShot, storage: { ...myShot.storage, rival: champion } };
    render(<Lobby me={champion} notes={[prize, own]} height={1000} {...props()} />);
    expect(screen.queryByRole("button", { name: /take it/i })).toBeNull();
  });

  it("lets the champion collect a shot only from its deadline + CLAIM_FUZZ on", () => {
    const h = props();
    const { rerender } = render(<Lobby me={champion} notes={[prize, myShot]} height={263} {...h} />);
    expect(screen.queryByRole("button", { name: /take it/i })).toBeNull();
    rerender(<Lobby me={champion} notes={[prize, myShot]} height={264} {...h} />);
    expect(screen.getByText("XTG lost")).toBeInTheDocument(); // the ready card names the rival who failed (Gaylord 2026-11-07)
    fireEvent.click(screen.getByRole("button", { name: /take it/i }));
    expect(h.onCollect).toHaveBeenCalledWith([myShot]);
    expect(screen.queryByRole("button", { name: /take all/i })).toBeNull();
  });

  it("takes everything the champion is owed in one go: lost shots and expired records", () => {
    const h = props();
    const second = { ...myShot, id: "0xc2", idWord: [2n, 2n, 2n, 2n] as [bigint, bigint, bigint, bigint] };
    render(<Lobby me={champion} notes={[prize, myShot, second]} height={1064} {...h} />);
    fireEvent.click(screen.getByRole("button", { name: /take all/i }));
    expect(h.onCollect).toHaveBeenCalledWith([prize, myShot, second]);
  });

  it("blinks every take button: Gamecoins are waiting", () => {
    render(<Lobby me={champion} notes={[prize, myShot]} height={1064} {...props()} />);
    for (const b of screen.getAllByRole("button", { name: /take/i })) expect(b.className).toContain("blink");
  });

  it("counts the tries lost so far on my open record, never naming who lost", () => {
    const lost = { ...myShot, storage: { ...myShot.storage, rival: { suffix: 7n, prefix: 7n } } };
    const { rerender } = render(<Lobby me={champion} notes={[prize, lost]} height={199} {...props()} />);
    expect(screen.queryByText(/lost so far/i)).toBeNull();
    rerender(<Lobby me={champion} notes={[prize, lost, { ...lost, id: "0xc2" }]} height={200} {...props()} />);
    expect(screen.getByText("2 tries lost so far")).toBeInTheDocument();
  });

  it("hides consumed notes: a record taken from the champion is gone from the hub", () => {
    render(<Lobby me={champion} notes={[{ ...prize, consumed: true }]} height={100} {...props()} />);
    expect(screen.queryByText(/waiting for a rival/i)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
