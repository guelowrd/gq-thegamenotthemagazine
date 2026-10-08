// GQ screens: connect Bread → lobby → play → post a prize / challenge / settle / claim.
// The app's own Miden client only reads the chain; Bread signs everything.

import { useCallback, useEffect, useState } from "react";
import { useMidenClient, useMiden } from "@miden-sdk/react";
import { useMidenFiWallet } from "@miden-sdk/miden-wallet-adapter-react";
import { CITIES_URL, EXPLORER_BASE_URL, GQ_DECIMALS, MIN_CHALLENGE_WINDOW_BLOCKS, PRIZE_LIFETIME_BLOCKS, STAKE } from "@/config";
import { accountFelts, fetchGqNote, listGqNotes, loadScripts, parseAccountId, prizeLinks, syncGq, wordFromHex, type GqNote } from "@/lib/chain";
import { postChallenge, postPrize, settle, collect, selfCheckAuthArgs, setSubmitAttemptListener, waitFor, type Submitted } from "@/lib/bread";
import { answerWord, type ChallengeStorage } from "@/lib/notes";
import { datasetWord, quizCities, randomSeed, type Place, type Word4 } from "@/lib/quiz";
import { type City } from "@/lib/rules";
import { Lobby, fmtGq } from "./Lobby";
import { Play, type PlayResult } from "./Play";
import "./AppContent.css";

type Mode =
  | { kind: "lobby" }
  | { kind: "play-champion"; seed: Word4; cities: City[] }
  | { kind: "post-prize"; seed: Word4; cities: City[]; result: PlayResult }
  | { kind: "play-challenger"; challenges: GqNote[]; prize?: GqNote }
  | { kind: "busy"; text: string }
  | { kind: "done"; text: string; txId?: string; share?: { url: string; x: string } };

export function AppContent() {
  // `useMidenClient()` throws until the provider has created the client, so gate on readiness first.
  const { isReady } = useMiden();
  if (!isReady) {
    return (
      <main className="gq">
        <h1>GQ · GeoQuiz on Miden</h1>
        <p className="muted">Initializing the Miden client…</p>
      </main>
    );
  }
  return <GqApp />;
}

function GqApp() {
  const client = useMidenClient();
  const { runExclusive, isReady } = useMiden();
  const wallet = useMidenFiWallet();

  const [places, setPlaces] = useState<Place[]>([]);
  const [dataset, setDataset] = useState<Word4 | null>(null);
  const [notes, setNotes] = useState<GqNote[]>([]);
  const [height, setHeight] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "lobby" });
  const [error, setError] = useState<string | null>(null);
  const [authCheck, setAuthCheck] = useState<boolean | null>(null);
  const [sharedPrize, setSharedPrize] = useState<GqNote | null>(null);
  const sharedPrizeId = new URLSearchParams(location.search).get("prize");

  const me = wallet.connected && wallet.address ? accountFelts(parseAccountId(wallet.address)) : null;

  useEffect(() => {
    fetch(CITIES_URL)
      .then(async (r) => {
        const bytes = new Uint8Array(await r.arrayBuffer());
        setDataset(await datasetWord(bytes));
        setPlaces(JSON.parse(new TextDecoder().decode(bytes)));
      })
      .catch((e) => setError(String(e)));
    loadScripts().catch((e) => setError(String(e)));
    if (import.meta.env.DEV) setAuthCheck(selfCheckAuthArgs());
    if (sharedPrizeId) fetchGqNote(sharedPrizeId).then(setSharedPrize).catch((e) => setError(`Shared prize: ${e instanceof Error ? e.message : e}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = useCallback(async () => {
    if (!isReady || !client) return;
    try {
      const h = await runExclusive(() => syncGq(client));
      setHeight(h);
      setNotes(await runExclusive(() => listGqNotes(client)));
    } catch (e) {
      setError(String(e));
    }
  }, [client, isReady, runExclusive]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  /**
   * Runs a Bread transaction, then waits until the chain shows its effect (`posted`: the new note
   * exists; otherwise: the consumed notes are gone). Bread only acknowledges the request; a
   * transaction can still fail inside the wallet, so nothing is called committed before it shows.
   */
  async function run(
    text: string,
    posted: boolean,
    fn: () => Promise<Submitted>,
    onConfirmed?: (s: Submitted) => Mode | void,
  ) {
    setError(null);
    setMode({ kind: "busy", text });
    setSubmitAttemptListener((attempt, total) => setMode({ kind: "busy", text: `${text} (attempt ${attempt}/${total})` }));
    try {
      const submitted = await fn();
      const { txId, noteIds } = submitted;
      setMode({ kind: "busy", text: `${text}: accepted by Bread, waiting for the chain` });
      const seen = await waitFor(client, runExclusive, async () => {
        const records = await Promise.all(noteIds.map((id) => client.getInputNote(id)));
        return posted ? records.every((r) => !!r) : records.every((r) => !!r?.isConsumed());
      });
      void refresh();
      const next = seen ? onConfirmed?.(submitted) : undefined;
      setMode(
        next ?? {
          kind: "done",
          text: seen ? `${text}: confirmed on chain` : `${text}: Bread accepted the request but the chain does not show it yet. Check Bread's activity; it may have failed there.`,
          txId,
        },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMode({ kind: "lobby" });
    }
  }

  function startChampion() {
    if (!dataset) return;
    const seed = randomSeed();
    quizCities(seed, places).then((cities) => setMode({ kind: "play-champion", seed, cities }));
  }

  /** My unconsumed, unexpired challenge notes on `prize` (any of them settles with the same answers). */
  const myOpenChallengesOn = (prize: GqNote) =>
    notes.filter(
      (n) =>
        n.kind === "challenge" &&
        !n.consumed &&
        n.storage.player?.suffix === me?.suffix &&
        n.storage.player?.prefix === me?.prefix &&
        n.idWord.length === 4 &&
        n.storage.prizeId.every((f, i) => f === prize.idWord[i]) &&
        Math.min(n.storage.challengeDeadline, n.storage.expiryBlock) > height,
    );

  /** Posts the challenge note and, once it is on chain, starts the quiz right away. */
  function challengePrize(prize: GqNote) {
    if (!wallet.address || !dataset || !me) return;
    if (prize.storage.expiryBlock - height < MIN_CHALLENGE_WINDOW_BLOCKS) return setError("This prize expires too soon to challenge.");
    const open = myOpenChallengesOn(prize);
    if (open.length > 0) {
      // one stake per sitting: play the challenge already on the table instead of paying again
      setMode({ kind: "play-challenger", challenges: open, prize });
      return;
    }
    const player = me;
    run(
      "Posting your challenge",
      true,
      async () => {
        // refuse a quiz that does not come from the seed and this dataset
        const expected = await quizCities(prize.storage.seed, places);
        const same = expected.every((c, i) => JSON.stringify(c) === JSON.stringify(prize.storage.cities[i]));
        if (!same || prize.storage.dataset.some((f, i) => f !== dataset[i])) throw new Error("This prize's quiz does not match the dataset.");
        return postChallenge(client, wallet, prize, player);
      },
      (submitted) => ({
        kind: "play-challenger",
        prize,
        challenges: [
          {
            id: submitted.noteIds[0],
            idWord: wordFromHex(submitted.noteIds[0]),
            kind: "challenge",
            storage: { ...prize.storage, player, prizeId: prize.idWord, challengeDeadline: (submitted as Submitted & { deadline: number }).deadline },
            amount: prize.storage.minStake,
            consumed: false,
          },
        ],
      }),
    );
  }

  const sharedPrizeCard = (connected: boolean) =>
    sharedPrize && (sharedPrize.consumed || height >= sharedPrize.storage.expiryBlock) ? (
      <section className="result">
        <h2>This prize is gone</h2>
        <p className="muted">{sharedPrize.consumed ? "It has already been claimed or reclaimed." : "It expired before anyone claimed it."} Play and post your own.</p>
      </section>
    ) : sharedPrize && (
      <section className="result">
        <h2>You were challenged</h2>
        <p>
          Prize <strong>{fmtGq(sharedPrize.amount)}</strong> · beat <strong>{sharedPrize.storage.target}</strong> on four cities · stake{" "}
          {fmtGq(sharedPrize.storage.minStake)} · {Math.max(0, sharedPrize.storage.expiryBlock - height)} blocks left
        </p>
        {connected ? (
          me && !(me.suffix === sharedPrize.storage.champion.suffix && me.prefix === sharedPrize.storage.champion.prefix) ? (
            myOpenChallengesOn(sharedPrize).length > 0 ? (
              <button onClick={() => challengePrize(sharedPrize)}>Play your open challenge</button>
            ) : (
              <button onClick={() => challengePrize(sharedPrize)}>Challenge &amp; play ({fmtGq(sharedPrize.storage.minStake)})</button>
            )
          ) : (
            <p className="muted">This is your own prize.</p>
          )
        ) : (
          <p className="muted">Connect Bread to challenge it in one click.</p>
        )}
      </section>
    );

  const settleAfterPlay = (challenges: GqNote[], prize: GqNote | undefined) => (r: PlayResult) => {
    const target = challenges[0].storage.target;
    const won = r.score > target;
    const claimPrize = won && prize && prize.storage.expiryBlock > height;
    const n = challenges.length > 1 ? ` (${challenges.length} challenge notes)` : "";
    const text = claimPrize
      ? `You scored ${r.score} > ${target}. Claiming the prize and your stake${n}`
      : won
        ? `You scored ${r.score} > ${target}. Recovering your stake${n}`
        : `You scored ${r.score} ≤ ${target}. Forfeiting your stake to the champion${n}`;
    run(text, false, () => settle(client, wallet, challenges, claimPrize ? prize : undefined, answerWord(r.answers)));
  };

  if (!wallet.connected) {
    return (
      <main className="gq">
        <h1>GQ · GeoQuiz on Miden</h1>
        <p>Click where the city is. Beat the champion's score to take the prize; lose and your stake goes to them.</p>
        <button onClick={() => wallet.connect().catch((e) => setError(e instanceof Error ? e.message : String(e)))} disabled={wallet.connecting}>
          {wallet.connecting ? "Connecting…" : "Connect Bread wallet"}
        </button>
        <p className="muted">
          Bread extension: {wallet.wallet?.readyState ?? "not detected"}. Get it at miden.xyz/bread, create or restore a testnet wallet, then connect.
        </p>
        {error && <p className="error">{error}</p>}
        {authCheck !== null && <p className="muted">auth-args self-check: {authCheck ? "ok" : "MISMATCH"}</p>}
        {sharedPrizeCard(false)}
      </main>
    );
  }

  return (
    <main className="gq">
      <header className="top">
        <h1>GQ · GeoQuiz</h1>
        <span className="mono">{wallet.address}</span>
        <span className="muted">block {height}</span>
        <button onClick={() => void wallet.disconnect()}>Disconnect</button>
      </header>
      {error && <p className="error">{error}</p>}

      {mode.kind === "lobby" && (
        <>
          {sharedPrizeCard(true)}
          <section className="cta">
            <button onClick={startChampion} disabled={!dataset || places.length === 0}>
              Play &amp; post a prize (you stake {fmtGq(STAKE)}; each challenger stakes {fmtGq(STAKE)})
            </button>
          </section>
          <Lobby
            me={me}
            notes={notes}
            height={height}
            onChallenge={challengePrize}
            onSettle={(challenge, prize) =>
              setMode({ kind: "play-challenger", challenges: prize ? myOpenChallengesOn(prize) : [challenge], prize })
            }
            onCollect={(note) => run(note.kind === "prize" ? "Reclaiming your prize" : "Collecting the stake", false, () => collect(client, wallet, note))}
          />
        </>
      )}

      {mode.kind === "play-champion" && (
        <Play cities={mode.cities} places={places} onDone={(result) => setMode({ kind: "post-prize", seed: mode.seed, cities: mode.cities, result })} />
      )}

      {mode.kind === "post-prize" && (
        <section className="result">
          <h2>You scored {mode.result.score}</h2>
          <p>
            Stake {fmtGq(STAKE)} as the prize: challengers stake the same {fmtGq(STAKE)} and must score more than {mode.result.score} on the same
            four cities within {PRIZE_LIFETIME_BLOCKS} blocks. Each one who falls short forfeits their stake to you.
          </p>
          <button
            onClick={() =>
              run("Posting your prize", true, () => {
                const storage: ChallengeStorage = {
                  expiryBlock: height + PRIZE_LIFETIME_BLOCKS,
                  target: mode.result.score,
                  minStake: STAKE,
                  champion: me!,
                  player: null,
                  prizeId: [0n, 0n, 0n, 0n],
                  challengeRoot: [0n, 0n, 0n, 0n], // filled from the loaded script
                  seed: mode.seed,
                  dataset: dataset!,
                  cities: mode.cities,
                  challengeDeadline: 0,
                };
                return postPrize(client, wallet, storage, STAKE);
              }, ({ txId, noteIds }) => ({
                kind: "done",
                text: `Your prize is live (score to beat: ${mode.result.score}). Share it so someone comes and challenges you.`,
                txId,
                share: prizeLinks(noteIds[0], mode.result.score),
              }))
            }
          >
            Post prize
          </button>
          <button className="secondary" onClick={() => setMode({ kind: "lobby" })}>
            Discard
          </button>
        </section>
      )}

      {mode.kind === "play-challenger" && (
        <Play cities={mode.challenges[0].storage.cities} places={places} onDone={settleAfterPlay(mode.challenges, mode.prize)} />
      )}

      {mode.kind === "busy" && (
        <section className="result">
          <p>{mode.text}… Approve in Bread, then wait for the transaction to commit.</p>
        </section>
      )}

      {mode.kind === "done" && (
        <section className="result">
          <p>{mode.text}</p>
          {mode.share && (
            <p>
              <a className="button" href={mode.share.x} target="_blank" rel="noreferrer">
                Share on X
              </a>{" "}
              <button className="secondary" onClick={() => void navigator.clipboard.writeText(mode.share!.url)}>
                Copy challenge link
              </button>
              <br />
              <span className="mono">{mode.share.url}</span>
            </p>
          )}
          {mode.txId && (
            <a href={`${EXPLORER_BASE_URL}/tx/${mode.txId}`} target="_blank" rel="noreferrer">
              View transaction
            </a>
          )}
          <button onClick={() => setMode({ kind: "lobby" })}>Back to lobby</button>
        </section>
      )}
      <footer className="muted">
        1 GQ = {10 ** GQ_DECIMALS} base units · scoring v1 · testnet
        {authCheck !== null && <> · auth-args self-check: {authCheck ? "ok" : "MISMATCH"}</>}
      </footer>
    </main>
  );
}
