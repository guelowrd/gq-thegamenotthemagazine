// The arcade chrome around every screen: one ribbon with the wordmark, the tabs, sound and wallet.

import type { ReactNode } from "react";
import { MAINNET } from "@/config";
import { useT } from "@/lib/i18n";
import { TAB_LABEL, type Tab } from "@/lib/tabs";

export function Shell({
  tab,
  onTab,
  onHome,
  walletLabel,
  netSlow,
  hubAlert,
  onWallet,
  openInBread,
  soundOn,
  onSound,
  children,
  title1p,
}: {
  tab: Tab;
  /** the 1P tab, named after the map it shows, already translated */
  title1p: string;
  onTab: (t: Tab) => void;
  /** the wordmark: back to the splash screen, inside the app (sound and wallet stay as they are) */
  onHome: () => void;
  /** null when no wallet is connected */
  walletLabel: string | null;
  /** the last background sync failed */
  netSlow?: boolean;
  /** the connected wallet has Gamecoins to take in the Player Hub */
  hubAlert?: boolean;
  onWallet: () => void;
  /** Bread is not on this device: the wallet button opens this page in Bread's phone app instead */
  openInBread?: string;
  soundOn: boolean;
  onSound: () => void;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <>
      <header className="masthead">
        <a
          className="brand"
          href="/"
          aria-label={t("GeoQuizz home")}
          onClick={(e) => {
            e.preventDefault();
            onHome();
          }}
        >
          <img src="/brand/geoquizz-wordmark.svg" alt="GeoQuizz" width={840} height={205} />
        </a>
        <nav aria-label={t("Sections")}>
          {(Object.keys(TAB_LABEL) as Tab[]).map((k) => (
            <button key={k} className={k === tab ? "active" : k === "hub" && hubAlert ? "blink" : ""} onClick={() => onTab(k)} aria-current={k === tab ? "page" : undefined}>
              {k === "1p" ? title1p : t(TAB_LABEL[k])}
            </button>
          ))}
        </nav>
        {netSlow && (
          <span className="net" title={t("The last sync with the Miden network failed; it retries by itself.")}>
            {t("Network slow")}
          </span>
        )}
        <button className="sound" onClick={onSound} aria-pressed={soundOn}>
          {soundOn ? t("Sound on") : t("Sound off")}
        </button>
        <div className="account">
          {openInBread ? (
            <a className="btn wallet" href={openInBread} title={t("Bread is the wallet that inserts your Gamecoin to post a record or take a shot.")}>
              {t("Open in Bread")}
            </a>
          ) : (
            <button className="btn wallet" onClick={onWallet}>
              {walletLabel ?? t("Connect wallet")}
            </button>
          )}
          <span className="testnet" title={MAINNET ? undefined : t("Miden testnet: Gamecoins are play money.")}>
            {MAINNET ? t("Mainnet") : t("Testnet")}
          </span>
        </div>
      </header>
      <main>
        <p className="rotate-hint">{t("Turn your phone sideways: the map is much easier to play.")}</p>
        {children}
      </main>
    </>
  );
}
