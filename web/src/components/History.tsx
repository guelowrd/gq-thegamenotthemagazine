// The Player Hub's past games: my used records and shots, newest first, ten at a time, by day.

import { useEffect, useState, type ReactNode } from "react";
import { blockTime } from "@/lib/chain";
import { whenLabel, type HistoryItem } from "@/lib/hub";
import { useT } from "@/lib/i18n";
import { Loader } from "./Loader";

const PAGE = 10;
const FILTERS = [
  ["all", "All"],
  ["record", "My records"],
  ["shot", "My shots"],
] as const;
type Filter = (typeof FILTERS)[number][0];

/** `items`: null while the chain is still being read. `connect`: shown instead when no wallet is connected. */
export function History({ items, connect }: { items: HistoryItem[] | null; connect?: ReactNode }) {
  const t = useT();
  const [filter, setFilter] = useState<Filter>("all");
  const [shown, setShown] = useState(PAGE);
  const [times, setTimes] = useState<Record<number, number>>({});
  const rows = items?.filter((h) => filter === "all" || h.kind === filter) ?? [];
  const visible = rows.slice(0, shown);
  // each game shows when the block it ended in was made
  const missing = [...new Set(visible.map((h) => h.at).filter((b) => times[b] === undefined))].join(",");
  useEffect(() => {
    for (const b of missing ? missing.split(",").map(Number) : []) {
      blockTime(b)
        .then((ms) => setTimes((prev) => ({ ...prev, [b]: ms })))
        .catch(() => undefined);
    }
  }, [missing]);

  const pick = (f: Filter) => {
    setFilter(f);
    setShown(PAGE);
  };
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const i = FILTERS.findIndex(([k]) => k === filter);
    const next = e.key === "ArrowRight" ? (i + 1) % FILTERS.length : e.key === "ArrowLeft" ? (i + FILTERS.length - 1) % FILTERS.length : e.key === "Home" ? 0 : e.key === "End" ? FILTERS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    pick(FILTERS[next][0]);
    (e.currentTarget.children[next] as HTMLElement | undefined)?.focus();
  };

  // games grouped by the day they ended; a game whose block time is still unknown stays in the group before it
  const days: { day: string; rows: { h: HistoryItem; time: string; when?: Date }[] }[] = [];
  for (const h of visible) {
    const label = times[h.at] ? whenLabel(times[h.at], Date.now(), t) : "";
    const cut = label.lastIndexOf(" ");
    const day = label.slice(0, cut);
    const last = days[days.length - 1];
    if (!last || (day && day !== last.day)) days.push({ day, rows: [] });
    days[days.length - 1].rows.push({ h, time: label.slice(cut + 1), when: times[h.at] ? new Date(times[h.at]) : undefined });
  }

  return (
    <section className="history" aria-labelledby="history-title">
      <h2 id="history-title">{t("History")}</h2>
      {connect ? (
        connect
      ) : items === null ? (
        <div aria-busy="true">
          <Loader />
          {[0, 1, 2].map((i) => (
            <div key={i} className="loading-history" aria-hidden="true">
              <i className="skeleton small" />
              <i className="skeleton score" />
              <i className="skeleton" />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="panel empty-copy">{t("No past games yet.")}</p>
      ) : (
        <>
          <div className="history-filters" role="tablist" aria-label={t("Past game type")} onKeyDown={onKey}>
            {FILTERS.map(([key, label]) => (
              <button key={key} role="tab" aria-selected={filter === key} aria-controls="past-games" tabIndex={filter === key ? 0 : -1} onClick={() => pick(key)}>
                {t(label)}
              </button>
            ))}
          </div>
          <div id="past-games" role="tabpanel">
            {rows.length === 0 && <p className="panel empty-copy">{filter === "record" ? t("No past records yet.") : t("No past shots yet.")}</p>}
            {days.map((d, i) => (
              <section key={d.day || i} className="history-day" aria-labelledby={d.day ? `day-${i}` : undefined}>
                {d.day && (
                  <h3 id={`day-${i}`} className="history-day-title">
                    {d.day}
                  </h3>
                )}
                <div className="history-list">
                  {d.rows.map(({ h, time, when }) => (
                    <article key={`${h.kind}:${h.id}`} className={`history-item ${h.tone}`} aria-labelledby={`result-${h.kind}-${h.id}`}>
                      <div className="history-meta">
                        <span className="eyebrow">{h.kind === "record" ? t("My record") : t("My shot")}</span>
                        <time dateTime={when?.toISOString()} aria-label={when?.toLocaleString()}>
                          {time}
                        </time>
                      </div>
                      <div className="history-body">
                        <div className="history-result">
                          <h3 id={`result-${h.kind}-${h.id}`}>{h.result}</h3>
                          <p className="history-context">
                            {h.context}
                            <span className="history-score">{t("{n} pts", { n: h.score.toLocaleString() })}</span>
                            {h.tag && <span className="tag"> {t(h.tag)}</span>}
                          </p>
                          {h.detail && <p className="history-detail">{h.detail}</p>}
                        </div>
                        <div className="history-money">
                          <p className={`money-label ${h.moneyTone}`}>{h.money}</p>
                          {h.note && <p className="money-note">{h.note}</p>}
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ))}
          </div>
          {shown < rows.length ? (
            <p className="history-more">
              <button className="btn" onClick={() => setShown(shown + PAGE)}>
                {t("More")}
              </button>
            </p>
          ) : (
            shown > PAGE && <p className="history-more muted">{t("That's all your games.")}</p>
          )}
        </>
      )}
    </section>
  );
}
