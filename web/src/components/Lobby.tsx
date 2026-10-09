// The Player Hub: my records to take back, my shots to play, lost shots at my records to collect.

import type { ChallengeNote } from "@/lib/chain";
import { blocksToClock, fmtGeocoin } from "@/lib/flow";
import { shotDeadline, type AccountFelts } from "@/lib/notes";
import { ShareButtons } from "./ShareButtons";
const sameAccount = (a: AccountFelts | null, b: AccountFelts | null) => !!a && !!b && a.suffix === b.suffix && a.prefix === b.prefix;

export type LobbyProps = {
  me: AccountFelts | null;
  notes: ChallengeNote[];
  height: number;
  onSettle: (shot: ChallengeNote, record: ChallengeNote | undefined) => void;
  onCollect: (note: ChallengeNote) => void;
};

export function Lobby({ me, notes, height, onSettle, onCollect }: LobbyProps) {
  const records = notes.filter((n) => n.kind === "record" && !n.consumed);
  const shots = notes.filter((n) => n.kind === "shot" && !n.consumed);
  const recordById = (idWord: bigint[]) => notes.find((n) => n.kind === "record" && n.idWord.every((f, i) => f === idWord[i]));
  const deadline = (n: ChallengeNote) => (n.kind === "shot" ? shotDeadline(n.storage) : n.storage.expiryBlock);
  const expired = (n: ChallengeNote) => height >= deadline(n);

  const mine = (n: ChallengeNote) => sameAccount(me, n.storage.champion);
  // records are shared by link only; the app never lists other people's
  const myRecords = records.filter(mine);
  const myShots = shots.filter((n) => sameAccount(me, n.storage.rival));
  const shotsAtMyRecords = shots.filter((n) => mine(n) && !sameAccount(me, n.storage.rival));
  const empty = myRecords.length + myShots.length + shotsAtMyRecords.length === 0;

  return (
    <div className="lobby">
      {empty && <p className="muted">Play the World Tour and post your record: rivals pay a Geocoin to try to beat it!</p>}
      {myRecords.map((p) => (
        <section key={p.id} className={`panel card${expired(p) ? " yellow" : ""}`}>
          <div className="eyebrow">{expired(p) ? "My record / over" : "My record / open"}</div>
          <div className="score">{p.storage.target.toLocaleString()} pts</div>
          {expired(p) ? (
            <button className="btn primary wide" onClick={() => onCollect(p)}>
              Take it back
            </button>
          ) : (
            <>
              <p className="muted">Waiting for a rival…</p>
              <ShareButtons recordId={p.id} score={p.storage.target} />
            </>
          )}
        </section>
      ))}

      {me &&
        myShots.map((c) => {
          const record = recordById(c.storage.recordId);
          return (
            <section key={c.id} className="panel card pink">
              <div className="eyebrow">{expired(c) ? "My shot / too late" : `My shot / ends in ${blocksToClock(deadline(c) - height)}`}</div>
              <div className="score">beat {c.storage.target.toLocaleString()}</div>
              <p className="muted">{fmtGeocoin(c.amount)} on the table</p>
              {expired(c) ? (
                <p className="muted">The champion can take it now.</p>
              ) : (
                <button className="btn primary wide" onClick={() => onSettle(c, record && !record.consumed ? record : undefined)}>
                  Play
                </button>
              )}
            </section>
          );
        })}

      {me &&
        shotsAtMyRecords.map((c) => (
          <section key={c.id} className="panel card mint">
            <div className="eyebrow">{expired(c) ? "For you / ready" : "For you / in play"}</div>
            <div className="score">{fmtGeocoin(c.amount)}</div>
            {expired(c) ? (
              <button className="btn primary wide" onClick={() => onCollect(c)}>
                Take it
              </button>
            ) : (
              <p className="muted">Someone is playing…</p>
            )}
          </section>
        ))}
    </div>
  );
}
