// The Player Hub's past games: my used records and shots, newest first, ten at a time.

import { useEffect, useState, type ReactNode } from "react";
import { blockTime } from "@/lib/chain";
import { whenLabel, type HistoryItem } from "@/lib/hub";

const PAGE = 10;

/** `items`: null while the chain is still being read. `connect`: shown instead when no wallet is connected. */
export function History({ items, connect }: { items: HistoryItem[] | null; connect?: ReactNode }) {
  const [shown, setShown] = useState(PAGE);
  const [times, setTimes] = useState<Record<number, number>>({});
  const visible = items?.slice(0, shown) ?? [];
  // each game shows when the block it ended in was made
  const missing = [...new Set(visible.map((h) => h.at).filter((b) => times[b] === undefined))].join(",");
  useEffect(() => {
    for (const b of missing ? missing.split(",").map(Number) : []) {
      blockTime(b)
        .then((ms) => setTimes((t) => ({ ...t, [b]: ms })))
        .catch(() => undefined);
    }
  }, [missing]);

  return (
    <section className="history" aria-labelledby="history-title">
      <h2 id="history-title">History</h2>
      {connect ? (
        connect
      ) : items === null ? (
        <div aria-busy="true">
          <p className="loader-label" role="status">
            Loading
          </p>
          {[0, 1, 2].map((i) => (
            <div key={i} className="loading-history" aria-hidden="true">
              <i className="skeleton small" />
              <i className="skeleton score" />
              <i className="skeleton" />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="panel empty-copy">No past games yet.</p>
      ) : (
        <>
          <div className="history-list">
            {visible.map((h) => (
              <article key={`${h.kind}:${h.id}`} className={`history-item ${h.tone}`}>
                <div>
                  <div className="eyebrow">My {h.kind}</div>
                  <div className="past-score">{h.title}</div>
                </div>
                <div>
                  {h.lines.map((line, i) => (
                    <p key={i} className={i ? "muted" : undefined}>
                      {line}
                    </p>
                  ))}
                </div>
                <time dateTime={times[h.at] ? new Date(times[h.at]).toISOString() : undefined} aria-label={times[h.at] ? new Date(times[h.at]).toLocaleString() : undefined}>
                  {times[h.at] ? whenLabel(times[h.at]) : ""}
                </time>
              </article>
            ))}
          </div>
          {shown < items.length ? (
            <p className="history-more">
              <button className="btn" onClick={() => setShown(shown + PAGE)}>
                More
              </button>
            </p>
          ) : (
            shown > PAGE && <p className="history-more muted">That’s all your games.</p>
          )}
        </>
      )}
    </section>
  );
}
