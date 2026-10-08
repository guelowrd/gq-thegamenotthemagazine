// GQ screens: connect Bread → lobby → play → post a prize / challenge / settle / claim.
// The app's own Miden client only reads the chain; Bread signs everything.

import { useCallback, useEffect, useState } from "react";
import { useMidenClient, useMiden } from "@miden-sdk/react";
import { useMidenFiWallet } from "@miden-sdk/miden-wallet-adapter-react";
import { LOCAL_WALLET, useLocalWallet } from "@/lib/localWallet";
import { CITIES_URL, MIN_CHALLENGE_WINDOW_BLOCKS, PRIZE_LIFETIME_BLOCKS, STAKE } from "@/config";
import { accountFelts, fetchGqNote, listGqNotes, loadScripts, parseAccountId, prizeLinks, syncGq, wordFromHex, type GqNote } from "@/lib/chain";
import { postChallenge, postPrize, settle, collect, selfCheckAuthArgs, setSubmitAttemptListener, waitFor, type Submitted } from "@/lib/bread";
import { answerWord, type ChallengeStorage } from "@/lib/notes";
import { challengeRefusal, myOpenChallengesOn as openChallengesOn, outcomeText, settlePlan, sharedPrizeState } from "@/lib/flow";
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
  const bread = useMidenFiWallet();
  const local = useLocalWallet(client, runExclusive);
  const wallet = LOCAL_WALLET ? local : bread;

  const [places, setPlaces] = useState<Place[]>([]);
  const [dataset, setDataset] = useState<Word4 | null>(null);
  const [notes, setNotes] = useState<GqNote[]>([]);
  const [height, setHeight] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "lobby" });
  const [error, setError] = useState<string | null>(null);
  const [authCheck, setAuthCheck] = useState<boolean | null>(null);
  const [sharedPrize, setSharedPrize] = useState<GqNote | null>(null);
  const [code, setCode] = useState("");
  const sharedPrizeId = new URLSearchParams(location.search).get("prize");

  /** A pasted link or id opens the prize exactly like the link would. */
  const openCode = () => {
    const id = /0x[0-9a-f]{64}/i.exec(code)?.[0];
    if (!id) return setError("That is not a game code.");
    setError(null);
    fetchGqNote(id).then(setSharedPrize).catch((e) => setError(`Not found: ${e instanceof Error ? e.message : e}`));
  };

  const codeBox = (
    <details className="code">
      <summary className="muted">Have a code?</summary>
      <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="paste the link or code" />
      <button className="secondary" onClick={openCode}>
        Go
      </button>
    </details>
  );

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
    setSubmitAttemptListener((attempt) => setMode({ kind: "busy", text: attempt > 1 ? `${text} (try ${attempt})` : text }));
    try {
      const submitted = await fn();
      const { txId, noteIds } = submitted;
      setMode({ kind: "busy", text: `${text}` });
      const seen = await waitFor(client, runExclusive, async () => {
        const records = await Promise.all(noteIds.map((id) => client.getInputNote(id)));
        return posted ? records.every((r) => !!r) : records.every((r) => !!r?.isConsumed());
      });
      void refresh();
      const next = seen ? onConfirmed?.(submitted) : undefined;
      setMode(next ?? { kind: "done", text: outcomeText(text, seen), txId });
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

  const myOpenChallengesOn = (prize: GqNote) => openChallengesOn(notes, me, prize, height);

  /** Posts the challenge note and, once it is on chain, starts the quiz right away. */
  function challengePrize(prize: GqNote) {
    if (!wallet.address || !dataset || !me) return;
    const refusal = challengeRefusal(prize, height, MIN_CHALLENGE_WINDOW_BLOCKS);
    if (refusal) return setError(refusal);
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

  const settleAfterPlay = (challenges: GqNote[], prize: GqNote | undefined) => (r: PlayResult) => {
    const plan = settlePlan(challenges, prize, r.score, height);
    if (!plan.won) {
      // nothing to sign on a loss: the stake waits for the champion at the deadline
      setMode({ kind: "done", text: plan.text });
      return;
    }
    run(plan.text, false, () => settle(client, wallet, challenges, plan.claimPrize ? prize : undefined, answerWord(r.answers)));
  };

  const sharedPrizeCard = (connected: boolean) => {
    if (!sharedPrize) return null;
    const state = sharedPrizeState(sharedPrize, connected ? me : null, connected ? myOpenChallengesOn(sharedPrize) : [], height);
    if (state === "claimed" || state === "expired") {
      return (
        <section className="result">
          <h2>This one is over.</h2>
        </section>
      );
    }
    return (
      <section className="result">
        <h2>Beat {sharedPrize.storage.target}?</h2>
        <p>Win {fmtGq(sharedPrize.amount)}.</p>
        {!connected && <button onClick={connect}>Play ({fmtGq(sharedPrize.storage.minStake)})</button>}
        {state === "mine" && <p className="muted">This is yours.</p>}
        {state === "already-challenged" && <button onClick={() => challengePrize(sharedPrize)}>Play</button>}
        {state === "open" && connected && <button onClick={() => challengePrize(sharedPrize)}>Play ({fmtGq(sharedPrize.storage.minStake)})</button>}
      </section>
    );
  };

  const connect = () => wallet.connect().catch((e) => setError(e instanceof Error ? e.message : String(e)));

  if (!wallet.connected) {
    return (
      <main className="gq">
        <h1>GQ</h1>
        <p>Find the city on the map.</p>
        {sharedPrize ? sharedPrizeCard(false) : (
          <button onClick={connect} disabled={wallet.connecting}>
            {wallet.connecting ? (LOCAL_WALLET && local.status) || "…" : "Play"}
          </button>
        )}
        {wallet.wallet?.readyState !== "Installed" && <p className="muted">You need the Bread wallet first.</p>}
        {error && <p className="error">{error}</p>}
        {import.meta.env.DEV && authCheck === false && <p className="error">dev: auth-args self-check MISMATCH</p>}
        {!sharedPrize && codeBox}
      </main>
    );
  }

  return (
    <main className="gq">
      <header className="top">
        <h1>GQ</h1>
        <span className="muted">{LOCAL_WALLET ? `test wallet ${wallet.address}` : `${wallet.address?.slice(0, 10)}…`}</span>
        <button className="secondary" onClick={() => void wallet.disconnect()}>Leave</button>
      </header>
      {error && <p className="error">{error}</p>}

      {mode.kind === "lobby" && (
        <>
          {sharedPrizeCard(true)}
          <section className="cta">
            <button onClick={startChampion} disabled={!dataset || places.length === 0}>
              Play
            </button>
          </section>
          <Lobby
            me={me}
            notes={notes}
            height={height}
            onSettle={(challenge, prize) => {
              const open = prize ? myOpenChallengesOn(prize) : [];
              setMode({ kind: "play-challenger", challenges: open.length > 0 ? open : [challenge], prize });
            }}
            onCollect={(note) => run("Taking it", false, () => collect(client, wallet, note))}
          />
          {!sharedPrize && codeBox}
        </>
      )}

      {mode.kind === "play-champion" && (
        <Play cities={mode.cities} places={places} onDone={(result) => setMode({ kind: "post-prize", seed: mode.seed, cities: mode.cities, result })} />
      )}

      {mode.kind === "post-prize" && (
        <section className="result">
          <h2>{mode.result.score} points</h2>
          <p>Put {fmtGq(STAKE)} on it? Whoever beats you takes it. Whoever fails pays you {fmtGq(STAKE)}.</p>
          <button
            onClick={() =>
              run("Posting", true, () => {
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
                text: "Now find someone to beat you.",
                txId,
                share: prizeLinks(noteIds[0], mode.result.score),
              }))
            }
          >
            Yes
          </button>
          <button className="secondary" onClick={() => setMode({ kind: "lobby" })}>
            No
          </button>
        </section>
      )}

      {mode.kind === "play-challenger" && (
        <Play cities={mode.challenges[0].storage.cities} places={places} onDone={settleAfterPlay(mode.challenges, mode.prize)} />
      )}

      {mode.kind === "busy" && (
        <section className="result">
          <p>{mode.text}… check your wallet.</p>
        </section>
      )}

      {mode.kind === "done" && (
        <section className="result">
          <h2>{mode.text}</h2>
          {mode.share && (
            <p>
              <a className="button" href={mode.share.x} target="_blank" rel="noreferrer">
                Share on X
              </a>{" "}
              <button className="secondary" onClick={() => void navigator.clipboard.writeText(mode.share!.url)}>
                Copy link
              </button>
            </p>
          )}
          <button onClick={() => setMode({ kind: "lobby" })}>OK</button>
        </section>
      )}
    </main>
  );
}
