// The lobby: open prizes to challenge, my challenges to settle, my prizes to collect.

import { GQ_DECIMALS } from "@/config";
import type { GqNote } from "@/lib/chain";
import { challengeDeadline, type AccountFelts } from "@/lib/notes";

export const fmtGq = (v: bigint) => `${(Number(v) / 10 ** GQ_DECIMALS).toLocaleString(undefined, { maximumFractionDigits: GQ_DECIMALS })} GQ`;
const sameAccount = (a: AccountFelts | null, b: AccountFelts | null) => !!a && !!b && a.suffix === b.suffix && a.prefix === b.prefix;

export type LobbyProps = {
  me: AccountFelts | null;
  notes: GqNote[];
  height: number;
  onSettle: (challenge: GqNote, prize: GqNote | undefined) => void;
  onCollect: (note: GqNote) => void;
};

export function Lobby({ me, notes, height, onSettle, onCollect }: LobbyProps) {
  const prizes = notes.filter((n) => n.kind === "prize" && !n.consumed);
  const challenges = notes.filter((n) => n.kind === "challenge" && !n.consumed);
  const prizeById = (idWord: bigint[]) => notes.find((n) => n.kind === "prize" && n.idWord.every((f, i) => f === idWord[i]));
  const deadline = (n: GqNote) => (n.kind === "challenge" ? challengeDeadline(n.storage) : n.storage.expiryBlock);
  const expired = (n: GqNote) => height >= deadline(n);

  const mine = (n: GqNote) => sameAccount(me, n.storage.champion);
  // prizes are shared by link only; the app never lists other people's
  const myPrizes = prizes.filter(mine);
  const myChallenges = challenges.filter((n) => sameAccount(me, n.storage.player));
  const challengesOnMyPrizes = challenges.filter((n) => mine(n) && !sameAccount(me, n.storage.player));

  return (
    <div className="lobby">
      <section>
        {myPrizes.length > 0 && <h2>Yours</h2>}
        <ul>
          {myPrizes.map((p) => (
            <li key={p.id}>
              <strong>{p.storage.target}</strong> · {fmtGq(p.amount)}
              {expired(p) ? <button onClick={() => onCollect(p)}>Take it back</button> : <span className="muted"> waiting for a challenger</span>}
            </li>
          ))}
        </ul>
      </section>

      {me && (
        myChallenges.length > 0 && (
          <section>
            <h2>Finish your game</h2>
            <ul>
              {myChallenges.map((c) => {
                const prize = prizeById(c.storage.prizeId);
                return (
                  <li key={c.id}>
                    beat <strong>{c.storage.target}</strong>
                    {expired(c) ? <span className="muted"> too late</span> : <button onClick={() => onSettle(c, prize && !prize.consumed ? prize : undefined)}>Play</button>}
                  </li>
                );
              })}
            </ul>
          </section>
        )
      )}

      {me && challengesOnMyPrizes.length > 0 && (
        <section>
          <h2>For you</h2>
          <ul>
            {challengesOnMyPrizes.map((c) => (
              <li key={c.id}>
                {fmtGq(c.amount)}
                {expired(c) ? <button onClick={() => onCollect(c)}>Take it</button> : <span className="muted"> someone is playing…</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
