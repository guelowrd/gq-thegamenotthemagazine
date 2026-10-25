// What the player sees when something is slow or goes wrong: one error box, one waiting panel.

import { useEffect, useState } from "react";
import { secondsToClock, type Trouble } from "@/lib/flow";
import { useT } from "@/lib/i18n";

/** A failure in plain words, the raw text one tap away, and a way forward. */
export function ErrorBox({
  trouble,
  onRetry,
  onGamecoins,
  openInBread,
  onClose,
}: {
  trouble: Trouble;
  onRetry?: () => void;
  onGamecoins?: () => void;
  /** Bread is not on this device: a missing wallet is fixed there, not by trying again */
  openInBread?: string;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <section className="panel red error-box" role="alert">
      <p className="title">{t(trouble.title)}</p>
      {trouble.detail && (
        <details>
          <summary>{t("What happened?")}</summary>
          <code>{trouble.detail}</code>
        </details>
      )}
      <div className="actions">
        {trouble.kind === "no-wallet" && openInBread ? (
          <a className="btn primary" href={openInBread}>
            {t("Open in Bread")}
          </a>
        ) : (
          onRetry && (
            <button className="btn primary" onClick={onRetry}>
              {t("Try again")}
            </button>
          )
        )}
        {trouble.kind === "funds" && onGamecoins && (
          <button className="btn primary" onClick={onGamecoins}>
            {t("Buy Gamecoins")}
          </button>
        )}
        <button className="btn" onClick={onClose}>
          {t("OK")}
        </button>
      </div>
    </section>
  );
}

/** The time, once a second. */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** The claim after a won shot: a live countdown to the shot's end, and the claim button until then. */
export function ClaimButton({ until, label, onClaim }: { until: number; label: string; onClaim: () => void }) {
  const t = useT();
  const now = useNow();
  const left = Math.max(0, Math.floor((until - now) / 1000));
  if (left === 0) return <p className="error-note">{t("Too late: your shot has ended. The champion can take your Gamecoin.")}</p>;
  return (
    <>
      <p className="deadline">{t("Shot ends: {time}", { time: secondsToClock(left) })}</p>
      <button className="btn primary" onClick={onClaim}>
        {label}
      </button>
    </>
  );
}

/** A live countdown to `until` (ms). */
export function EndsIn({ until }: { until: number }) {
  const t = useT();
  const now = useNow();
  return <>{t("Ends in {time}", { time: secondsToClock(Math.max(0, Math.round((until - now) / 1000))) })}</>;
}

export type Stage = "prepare" | "wallet" | "network";

/** Seconds a slow network gets before we say so. */
const SLOW_AFTER_S = 30;

/** Says which step a transaction is at, counts the seconds on the network, and always offers Back. */
export function Waiting({ text, stage, since, local, onBack }: { text: string; stage: Stage; since: number; local: boolean; onBack: () => void }) {
  const t = useT();
  const now = useNow();
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const step =
    stage === "prepare" ? t("Getting ready…") : stage === "wallet" ? (local ? t("Signing…") : t("Approve it in your wallet.")) : t("Sending it to the Miden network… {s} s", { s: seconds });
  return (
    <section className="panel waiting" aria-live="polite">
      <h2>{text}</h2>
      <p>{step}</p>
      {stage === "network" && seconds >= SLOW_AFTER_S && (
        <p className="muted">{t("The network is slow right now. You can keep waiting, or go back: if it goes through, you will find it in the Player Hub.")}</p>
      )}
      <button className="btn" onClick={onBack}>
        {t("Back")}
      </button>
    </section>
  );
}
