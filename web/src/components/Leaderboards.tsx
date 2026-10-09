// The public boards, arcade style: rank, nickname, number. Read from the chain, no wallet needed.
// Wide screens show them all (Defended / Smashed below); narrow ones pick one with the tabs.

import { useState, type ReactNode } from "react";
import { keyOf, type boards, type Ranked } from "@/lib/hub";
import type { AccountFelts } from "@/lib/notes";

type Boards = ReturnType<typeof boards>;
type Name = keyof Boards;

const TITLE: Record<Name, string> = { coins: "Most Geocoins won", records: "Best records", defended: "Defended", smashed: "Smashed" };
const UNIT: Record<Name, string> = { coins: "Geocoins won", records: "Record", defended: "Rivals beaten", smashed: "Records smashed" };
const EMPTY: Record<Name, string> = { coins: "No wins yet.", records: "No records yet.", defended: "No rivals beaten yet.", smashed: "No records yet." };
const COLOR: Record<Name, string> = { coins: "yellow", records: "pink", defended: "mint", smashed: "mint" };

function Tabs<T extends string>({ items, value, onPick, className }: { items: [T, string][]; value: T; onPick: (v: T) => void; className: string }) {
  return (
    <div className={className}>
      {items.map(([k, label]) => (
        <button key={k} className={`btn${k === value ? " primary" : ""}`} aria-pressed={k === value} onClick={() => onPick(k)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** `data`: null while the chain is still being read. `action`: beside the title (Refresh). */
export function Leaderboards({ data, me, name, action }: { data: Boards | null; me: AccountFelts | null; name: (a: AccountFelts) => string; action?: ReactNode }) {
  const [pick, setPick] = useState<"coins" | "records" | "wins">("coins");
  const [side, setSide] = useState<"defended" | "smashed">("defended");
  const mine = (r: Ranked) => !!me && keyOf(r.who) === keyOf(me);
  const row = (r: Ranked) => (
    <tr key={r.key} className={mine(r) ? "mine" : undefined} aria-label={mine(r) ? "Your row" : undefined}>
      <td>{String(r.rank).padStart(2, "0")}</td>
      <td>{name(r.who)}</td>
      <td>{r.value.toLocaleString()}</td>
    </tr>
  );
  const board = (k: Name) => {
    const b = data?.[k];
    return (
      <section className={`panel arcade ${COLOR[k]}`} data-board={k}>
        <h3>{TITLE[k]}</h3>
        {!b ? (
          <div aria-busy="true">
            <p className="loader-label" role="status">
              Loading
            </p>
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="loading-board" aria-hidden="true">
                <i className="skeleton" />
                <i className="skeleton" />
                <i className="skeleton" />
              </div>
            ))}
          </div>
        ) : b.top.length === 0 ? (
          <p className="empty-copy">{EMPTY[k]}</p>
        ) : (
          <>
            <table aria-label={`${TITLE[k]}: rank, nickname, ${UNIT[k]}`}>
              <tbody>{b.top.map(row)}</tbody>
            </table>
            {b.mine && (
              <table className="own-row" aria-label="Your rank">
                <tbody>{row(b.mine)}</tbody>
              </table>
            )}
          </>
        )}
      </section>
    );
  };

  return (
    <>
      <div className="page-head">
        <h1>Leaderboards</h1>
        {action}
      </div>
      <section className="high-scores" data-pick={pick}>
        <Tabs items={[["coins", "Geocoins"], ["records", "Records"], ["wins", "Wins"]]} value={pick} onPick={setPick} className="board-tabs" />
        <div className="boards-grid">
          {board("coins")}
          {board("records")}
          <section className="wins-module" data-side={side}>
            <h3>Defended / smashed</h3>
            <Tabs items={[["defended", "Defended"], ["smashed", "Smashed"]]} value={side} onPick={setSide} className="record-tabs" />
            <div className="wins-pair">
              {board("defended")}
              {board("smashed")}
            </div>
          </section>
        </div>
      </section>
    </>
  );
}
