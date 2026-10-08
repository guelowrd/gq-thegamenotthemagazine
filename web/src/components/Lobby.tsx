// The lobby: open prizes to challenge, my challenges to settle, my prizes to collect.

import { GQ_DECIMALS, STAKE } from "@/config";
import type { GqNote } from "@/lib/chain";
import type { AccountFelts } from "@/lib/notes";

export const fmtGq = (v: bigint) => `${(Number(v) / 10 ** GQ_DECIMALS).toLocaleString(undefined, { maximumFractionDigits: GQ_DECIMALS })} GQ`;
const sameAccount = (a: AccountFelts | null, b: AccountFelts | null) => !!a && !!b && a.suffix === b.suffix && a.prefix === b.prefix;
const short = (id: string) => `${id.slice(0, 8)}…${id.slice(-4)}`;

export type LobbyProps = {
  me: AccountFelts | null;
  notes: GqNote[];
  height: number;
  onChallenge: (prize: GqNote) => void;
  onSettle: (challenge: GqNote, prize: GqNote | undefined) => void;
  onCollect: (note: GqNote) => void;
};

export function Lobby({ me, notes, height, onChallenge, onSettle, onCollect }: LobbyProps) {
  const prizes = notes.filter((n) => n.kind === "prize" && !n.consumed);
  const challenges = notes.filter((n) => n.kind === "challenge" && !n.consumed);
  const prizeById = (idWord: bigint[]) => notes.find((n) => n.kind === "prize" && n.idWord.every((f, i) => f === idWord[i]));
  const expired = (n: GqNote) => height >= n.storage.expiryBlock;

  const mine = (n: GqNote) => sameAccount(me, n.storage.champion);
  const myChallenges = challenges.filter((n) => sameAccount(me, n.storage.player));
  const challengesOnMyPrizes = challenges.filter((n) => mine(n) && !sameAccount(me, n.storage.player));

  return (
    <div className="lobby">
      <section>
        <h2>Open prizes</h2>
        {prizes.length === 0 && <p className="muted">No open prize found yet (the app syncs every 15 s). Play and post one.</p>}
        <ul>
          {prizes.map((p) => (
            <li key={p.id}>
              <span className="mono">{short(p.id)}</span> · prize <strong>{fmtGq(p.amount)}</strong> · beat{" "}
              <strong>{p.storage.target}</strong> · stake {fmtGq(p.storage.minStake)} ·{" "}
              {expired(p) ? <em>expired</em> : <em>{p.storage.expiryBlock - height} blocks left</em>}
              {mine(p) ? (
                expired(p) ? <button onClick={() => onCollect(p)}>Reclaim prize</button> : <span className="muted"> (yours)</span>
              ) : (
                !expired(p) && <button onClick={() => onChallenge(p)}>Challenge for {fmtGq(STAKE)}</button>
              )}
            </li>
          ))}
        </ul>
      </section>

      {me && (
        <section>
          <h2>My challenges</h2>
          {myChallenges.length === 0 && <p className="muted">None open.</p>}
          <ul>
            {myChallenges.map((c) => {
              const prize = prizeById(c.storage.prizeId);
              return (
                <li key={c.id}>
                  <span className="mono">{short(c.id)}</span> · stake {fmtGq(c.amount)} · beat <strong>{c.storage.target}</strong> ·{" "}
                  {expired(c) ? <em>expired</em> : <em>{c.storage.expiryBlock - height} blocks left</em>}
                  {!expired(c) && <button onClick={() => onSettle(c, prize && !prize.consumed ? prize : undefined)}>Play &amp; settle</button>}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {me && challengesOnMyPrizes.length > 0 && (
        <section>
          <h2>Challenges on my prizes</h2>
          <ul>
            {challengesOnMyPrizes.map((c) => (
              <li key={c.id}>
                <span className="mono">{short(c.id)}</span> · stake {fmtGq(c.amount)} ·{" "}
                {expired(c) ? <button onClick={() => onCollect(c)}>Collect stake</button> : <em>{c.storage.expiryBlock - height} blocks left</em>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
