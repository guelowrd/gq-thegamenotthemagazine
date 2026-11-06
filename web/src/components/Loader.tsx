// What a player sees while the game's notes are read: the count so far, a bar, and the seconds left
// once the pace is known. Dots alone before the read starts (scripts, cities, the wallet's own sync).

import { useEffect, useRef, useSyncExternalStore } from "react";
import { scanProgress } from "@/lib/chain";
import { useT } from "@/lib/i18n";

const SEGMENTS = 20;

export function Loader() {
  const t = useT();
  const p = useSyncExternalStore(scanProgress.subscribe, scanProgress.get);
  const since = useRef(Date.now());
  useEffect(() => {
    if (p?.done === 0) since.current = Date.now();
  }, [p]);
  // the pace after a few checks: how long the rest should take
  const left = p && p.done >= 10 && p.done < p.total ? Math.ceil((((Date.now() - since.current) / p.done) * (p.total - p.done)) / 1000) : 0;
  const lit = p ? Math.round((p.done / Math.max(p.total, 1)) * SEGMENTS) : 0;
  return (
    <div className="loader" role="status" aria-busy="true">
      <span className="dots">{p ? t("Reading the games") : t("Loading")}</span>
      {p && (
        <span className="count">
          {p.done} / {p.total}
          {left > 0 && ` · ~${left} s`}
        </span>
      )}
      <span className="bar" aria-hidden="true">
        {Array.from({ length: SEGMENTS }, (_, i) => (
          <i key={i} className={i < lit ? "on" : ""} />
        ))}
      </span>
    </div>
  );
}
