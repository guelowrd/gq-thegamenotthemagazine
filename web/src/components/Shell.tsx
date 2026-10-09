// The arcade chrome around every screen: one ribbon with the wordmark, the tabs, sound and wallet.

import type { ReactNode } from "react";
import { TAB_LABEL, type Tab } from "@/lib/tabs";

export function Shell({
  tab,
  onTab,
  walletLabel,
  onWallet,
  soundOn,
  onSound,
  children,
}: {
  tab: Tab;
  onTab: (t: Tab) => void;
  /** null when no wallet is connected */
  walletLabel: string | null;
  onWallet: () => void;
  soundOn: boolean;
  onSound: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <header className="masthead">
        <a className="brand" href="/" aria-label="GeoQuizz home">
          <img src="/brand/geoquizz-wordmark.svg" alt="GeoQuizz" width={840} height={205} />
        </a>
        <nav aria-label="Sections">
          {(Object.keys(TAB_LABEL) as Tab[]).map((t) => (
            <button key={t} className={t === tab ? "active" : ""} onClick={() => onTab(t)} aria-current={t === tab ? "page" : undefined}>
              {TAB_LABEL[t]}
            </button>
          ))}
        </nav>
        <button className="sound" onClick={onSound} aria-pressed={soundOn}>
          Sound {soundOn ? "on" : "off"}
        </button>
        <button className="btn wallet" onClick={onWallet}>
          {walletLabel ?? "Connect wallet"}
        </button>
      </header>
      <main>
        <p className="rotate-hint">Turn your phone sideways: the map is much easier to play.</p>
        {children}
      </main>
    </>
  );
}
