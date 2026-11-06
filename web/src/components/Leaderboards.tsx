// The public boards, arcade style: rank, nickname, number. Read from the chain, no wallet needed.
// Wide screens show them all (Defended / Smashed below); narrow ones pick one with the tabs. The
// Loserboard is its own section under them, on every screen.

import { useState, type ReactNode } from "react";
import { sameAccount } from "@/lib/flow";
import { type boards, type Ranked } from "@/lib/hub";
import type { AccountFelts } from "@/lib/notes";
import { useT } from "@/lib/i18n";
import { STAGES } from "@/lib/stages";

type Boards = ReturnType<typeof boards>;
type Name = keyof Boards;

const COLOR: Record<Name, string> = { coins: "yellow", records: "pink", defended: "mint", smashed: "mint", losers: "red" };

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
  const t = useT();
  const [pick, setPick] = useState<"coins" | "records" | "wins">("coins");
  const [side, setSide] = useState<"defended" | "smashed">("defended");
  // the records board, one map at a time
  const [map, setMap] = useState("all");
  const TITLE: Record<Name, string> = { coins: t("Most Gamecoins won"), records: t("Best records"), defended: t("Defended|board"), smashed: t("Smashed"), losers: t("Most lost shots") };
  const UNIT: Record<Name, string> = { coins: t("Gamecoins won"), records: t("Record"), defended: t("Rivals beaten"), smashed: t("Records smashed"), losers: t("Shots lost") };
  const EMPTY: Record<Name, string> = { coins: t("No wins yet."), records: t("No records yet."), defended: t("No rivals beaten yet."), smashed: t("No records yet."), losers: t("No losers yet.") };
  const mine = (r: Ranked) => sameAccount(me, r.who);
  // the records board has a fourth column, the map
  const row = (k: Name) => (r: Ranked) => (
    <tr key={r.key} className={mine(r) ? "mine" : undefined} aria-label={mine(r) ? t("Your row") : undefined}>
      <td>{String(r.rank).padStart(2, "0")}</td>
      <td>{name(r.who)}</td>
      <td className="score">{r.value.toLocaleString()}</td>
      {k === "records" && <td className="map">{r.tag && t(r.tag)}</td>}
    </tr>
  );
  const board = (k: Name) => {
    const b = k === "records" && map !== "all" ? data && (data.records.byMap?.[map] ?? { top: [], mine: null }) : data?.[k];
    return (
      <section className={`panel arcade ${COLOR[k]}`} data-board={k}>
        <h3>
          {TITLE[k]}
          {k === "records" && <Tabs items={[["all", t("All maps")], ...STAGES.map((s) => [s.name, t(s.name)] as [string, string])]} value={map} onPick={setMap} className="map-tabs" />}
        </h3>
        {!b ? (
          <div aria-busy="true">
            <p className="loader-label" role="status">
              {t("Loading")}
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
            <div className="rows">
              <table aria-label={t("{title}: rank, nickname, {unit}", { title: TITLE[k], unit: UNIT[k] })}>
                <tbody>{b.top.map(row(k))}</tbody>
              </table>
            </div>
            {b.mine && (
              <table className="own-row" aria-label={t("Your rank")}>
                <tbody>{row(k)(b.mine)}</tbody>
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
        <h1>{t("Leaderboards")}</h1>
        {action}
      </div>
      <section className="high-scores" data-pick={pick}>
        <Tabs items={[["coins", t("Gamecoins")], ["records", t("Records")], ["wins", t("Wins")]]} value={pick} onPick={setPick} className="board-tabs" />
        <div className="boards-grid">
          {board("coins")}
          {board("records")}
          <section className="wins-module" data-side={side}>
            <h3>{t("Defended / smashed")}</h3>
            <Tabs items={[["defended", t("Defended|board")], ["smashed", t("Smashed")]]} value={side} onPick={setSide} className="record-tabs" />
            <div className="wins-pair">
              {board("defended")}
              {board("smashed")}
            </div>
          </section>
        </div>
      </section>
      <section className="loserboard">
        <h1>{t("Loserboard")}</h1>
        <div className="boards-grid">{board("losers")}</div>
      </section>
    </>
  );
}
