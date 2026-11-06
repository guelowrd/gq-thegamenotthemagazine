// The Player Hub: my records to take back, my shots to play, lost shots at my records to collect.
// A shot of mine past its deadline is lost: it shows in History, not here.

import type { ChallengeNote } from "@/lib/chain";
import { blocksToClock, blockToMs, fmtGamecoin, sameAccount } from "@/lib/flow";
import { owed, stageTag, triesLost, whenLabel } from "@/lib/hub";
import { cityNames, gameStage, recordCities, type Place } from "@/lib/quiz";
import { CLAIM_FUZZ } from "@/config";
import { noteDeadline as deadline, type AccountFelts } from "@/lib/notes";
import { ShareButtons } from "./ShareButtons";
import { useT } from "@/lib/i18n";

type LobbyProps = {
  me: AccountFelts | null;
  notes: ChallengeNote[];
  height: number;
  /** the city list a note's game data plays on, English names for the post */
  places: (game: bigint[]) => Place[];
  onCollect: (notes: ChallengeNote[]) => void;
};

export function Lobby({ me, notes, height, places, onCollect }: LobbyProps) {
  const t = useT();
  const records = notes.filter((n) => n.kind === "record" && !n.consumed);
  const shots = notes.filter((n) => n.kind === "shot" && !n.consumed);
  const expired = (n: ChallengeNote) => height >= deadline(n);
  // everything the champion can take now goes in one transaction: one wallet approval
  const ready = owed(notes, height, me);
  const takeable = (n: ChallengeNote) => ready.includes(n);
  // when the champion may take it, as a clock time: blocks left at testnet's pace
  const until = (n: ChallengeNote) => whenLabel(blockToMs(deadline(n) + CLAIM_FUZZ, height), Date.now(), t);

  const mine = (n: ChallengeNote) => sameAccount(me, n.storage.champion);
  // only mine here: other people's open records are listed in Champion vs Rival
  const myRecords = records.filter(mine);
  // a shot past its deadline is lost and listed in History; the champion's lost-shot card below stays
  const myShots = shots.filter((n) => sameAccount(me, n.storage.rival) && !expired(n));
  const shotsAtMyRecords = shots.filter((n) => mine(n) && !sameAccount(me, n.storage.rival));
  const empty = myRecords.length + myShots.length + shotsAtMyRecords.length === 0;

  return (
    <div className="lobby">
      {empty && <p className="muted">{t("Play the World Tour and post your record: rivals pay a Gamecoin to try to beat it!")}</p>}
      {ready.length > 1 && (
        <p>
          <button className="btn primary blink" onClick={() => onCollect(ready)}>
            {t("Take all")}
          </button>
        </p>
      )}
      {myRecords.map((p) => {
        const tag = stageTag(p.storage.game);
        return (
          <section key={p.id} className={`panel card${takeable(p) ? " yellow" : ""}`}>
            <div className="eyebrow">{takeable(p) ? t("My record / over") : t("My record / open until {time}", { time: until(p) })}</div>
            <div className="score">
              {t("{n} pts", { n: p.storage.target.toLocaleString() })}
              {tag && <span className="tag"> {t(tag)}</span>}
            </div>
            {takeable(p) ? (
              <button className="btn primary blink" onClick={() => onCollect([p])}>
                {t("Take it back")}
              </button>
            ) : (
              <>
                <p className="muted">{t("Waiting for a rival…")}</p>
                <LostSoFar n={triesLost(p, notes, height)} />
                <ShareButtons recordId={p.id} score={p.storage.target} expiresAt={blockToMs(p.storage.expiryBlock, height)} cities={cityNames(recordCities(p.storage.game), places(p.storage.game))} stage={gameStage(p.storage.game)} />
              </>
            )}
          </section>
        );
      })}

      {myShots.map((c) => {
          const tag = stageTag(c.storage.game);
          return (
            <section key={c.id} className="panel card pink">
              <div className="eyebrow">{t("My shot / ends in {time}", { time: blocksToClock(deadline(c) - height) })}</div>
              <div className="score">
                {t("beat {n}", { n: c.storage.target.toLocaleString() })}
                {tag && <span className="tag"> {t(tag)}</span>}
              </div>
              <p className="muted">{t("{gc} on the table", { gc: fmtGamecoin(c.amount, t) })}</p>
            </section>
          );
        })}

      {shotsAtMyRecords.map((c) => (
          <section key={c.id} className="panel card mint">
            <div className="eyebrow">{takeable(c) ? t("For you / ready") : t("For you / in play")}</div>
            <div className="score">{fmtGamecoin(c.amount, t)}</div>
            {takeable(c) ? (
              <button className="btn primary blink" onClick={() => onCollect([c])}>
                {t("Take it")}
              </button>
            ) : (
              <p className="muted">{t("Someone is playing…")}</p>
            )}
          </section>
        ))}
    </div>
  );
}

/** Rivals who lost are counted, never named. Nothing while none lost, or while the count is unknown. */
function LostSoFar({ n }: { n: number | null }) {
  const t = useT();
  return n ? <p className="small">{n === 1 ? t("1 try lost so far") : t("{n} tries lost so far", { n })}</p> : null;
}
