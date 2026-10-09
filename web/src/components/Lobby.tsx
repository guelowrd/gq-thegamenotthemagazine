// The lobby: my records to take back, my shots to play, shots at my records to collect.

import { GC_DECIMALS } from "@/config";
import type { GqNote } from "@/lib/chain";
import { shotDeadline, type AccountFelts } from "@/lib/notes";

export const fmtGc = (v: bigint) => `${(Number(v) / 10 ** GC_DECIMALS).toLocaleString(undefined, { maximumFractionDigits: GC_DECIMALS })} GC`;
const sameAccount = (a: AccountFelts | null, b: AccountFelts | null) => !!a && !!b && a.suffix === b.suffix && a.prefix === b.prefix;

export type LobbyProps = {
  me: AccountFelts | null;
  notes: GqNote[];
  height: number;
  onSettle: (shot: GqNote, record: GqNote | undefined) => void;
  onCollect: (note: GqNote) => void;
};

export function Lobby({ me, notes, height, onSettle, onCollect }: LobbyProps) {
  const records = notes.filter((n) => n.kind === "record" && !n.consumed);
  const shots = notes.filter((n) => n.kind === "shot" && !n.consumed);
  const recordById = (idWord: bigint[]) => notes.find((n) => n.kind === "record" && n.idWord.every((f, i) => f === idWord[i]));
  const deadline = (n: GqNote) => (n.kind === "shot" ? shotDeadline(n.storage) : n.storage.expiryBlock);
  const expired = (n: GqNote) => height >= deadline(n);

  const mine = (n: GqNote) => sameAccount(me, n.storage.champion);
  // records are shared by link only; the app never lists other people's
  const myRecords = records.filter(mine);
  const myShots = shots.filter((n) => sameAccount(me, n.storage.rival));
  const shotsAtMyRecords = shots.filter((n) => mine(n) && !sameAccount(me, n.storage.rival));

  return (
    <div className="lobby">
      <section>
        {myRecords.length > 0 && <h2>My records</h2>}
        <ul>
          {myRecords.map((p) => (
            <li key={p.id}>
              <strong>{p.storage.target}</strong> · {fmtGc(p.amount)}
              {expired(p) ? <button onClick={() => onCollect(p)}>Take it back</button> : <span className="muted"> waiting for a rival</span>}
            </li>
          ))}
        </ul>
      </section>

      {me && (
        myShots.length > 0 && (
          <section>
            <h2>My shots</h2>
            <ul>
              {myShots.map((c) => {
                const record = recordById(c.storage.recordId);
                return (
                  <li key={c.id}>
                    beat <strong>{c.storage.target}</strong>
                    {expired(c) ? <span className="muted"> too late</span> : <button onClick={() => onSettle(c, record && !record.consumed ? record : undefined)}>Play</button>}
                  </li>
                );
              })}
            </ul>
          </section>
        )
      )}

      {me && shotsAtMyRecords.length > 0 && (
        <section>
          <h2>For you</h2>
          <ul>
            {shotsAtMyRecords.map((c) => (
              <li key={c.id}>
                {fmtGc(c.amount)}
                {expired(c) ? <button onClick={() => onCollect(c)}>Take it</button> : <span className="muted"> someone is playing…</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
