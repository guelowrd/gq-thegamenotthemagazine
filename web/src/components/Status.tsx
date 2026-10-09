// What the player sees when something is slow or goes wrong: one error box, one waiting panel.

import { useEffect, useState } from "react";
import type { Trouble } from "@/lib/flow";

/** A failure in plain words, the raw text one tap away, and a way forward. */
export function ErrorBox({
  trouble,
  onRetry,
  onGeocoins,
  onClose,
}: {
  trouble: Trouble;
  onRetry?: () => void;
  onGeocoins?: () => void;
  onClose: () => void;
}) {
  return (
    <section className="panel red error-box" role="alert">
      <p className="title">{trouble.title}</p>
      {trouble.detail && (
        <details>
          <summary>What happened?</summary>
          <code>{trouble.detail}</code>
        </details>
      )}
      <div className="actions">
        {onRetry && (
          <button className="btn primary" onClick={onRetry}>
            Try again
          </button>
        )}
        {trouble.kind === "funds" && onGeocoins && (
          <button className="btn primary" onClick={onGeocoins}>
            Get Geocoins
          </button>
        )}
        <button className="btn" onClick={onClose}>
          OK
        </button>
      </div>
    </section>
  );
}

export type Stage = "prepare" | "wallet" | "network";

/** Seconds a slow network gets before we say so. */
const SLOW_AFTER_S = 30;

/** Says which step a transaction is at, counts the seconds on the network, and always offers Back. */
export function Waiting({ text, stage, since, local, onBack }: { text: string; stage: Stage; since: number; local: boolean; onBack: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const step =
    stage === "prepare" ? "Getting ready…" : stage === "wallet" ? (local ? "Signing…" : "Approve it in your wallet.") : `Sending it to the Miden network… ${seconds} s`;
  return (
    <section className="panel waiting" aria-live="polite">
      <h2>{text}</h2>
      <p>{step}</p>
      {stage === "network" && seconds >= SLOW_AFTER_S && (
        <p className="muted">The network is slow right now. You can keep waiting, or go back: if it goes through, you will find it in the Player Hub.</p>
      )}
      <button className="btn" onClick={onBack}>
        Back
      </button>
    </section>
  );
}
