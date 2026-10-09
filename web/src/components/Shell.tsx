// The arcade chrome around every screen: masthead (wordmark, tabs, wallet), toolbar line.

import type { ReactNode } from "react";
import { TAB_LABEL, type Tab } from "@/lib/tabs";

export function Shell({
  tab,
  onTab,
  crumb,
  walletLabel,
  onWallet,
  soundOn,
  onSound,
  children,
}: {
  tab: Tab;
  onTab: (t: Tab) => void;
  crumb: string;
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
        <button className="btn wallet" onClick={onWallet}>
          {walletLabel ? `Wallet / ${walletLabel}` : "Connect wallet"}
        </button>
      </header>
      <div className="toolbar">
        <span className="crumb">{crumb}</span>
        <button onClick={onSound} aria-pressed={soundOn}>
          Sound {soundOn ? "on" : "off"}
        </button>
      </div>
      <main>{children}</main>
    </>
  );
}
