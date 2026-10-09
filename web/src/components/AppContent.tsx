// GQ screens: connect Bread → lobby → play → post a record / take a shot / settle / claim.
// The app's own Miden client only reads the chain; Bread signs everything.

import { useCallback, useEffect, useState } from "react";
import { useMidenClient, useMiden } from "@miden-sdk/react";
import { useMidenFiWallet } from "@miden-sdk/miden-wallet-adapter-react";
import { LOCAL_WALLET, useLocalWallet } from "@/lib/localWallet";
import { GEOCOIN_GRANT, useGeocoin } from "@/lib/geocoin";
import { CITIES_URL, MIN_SHOT_WINDOW_BLOCKS, RECORD_LIFETIME_BLOCKS, STAKE } from "@/config";
import { accountFelts, fetchGqNote, knownNote, listGqNotes, loadScripts, parseAccountId, recordLinks, syncGq, wordFromHex, type GqNote } from "@/lib/chain";
import { postShot, postRecord, settle, collect, selfCheckAuthArgs, setSubmitAttemptListener, waitFor, type Submitted } from "@/lib/bread";
import { type ChallengeStorage } from "@/lib/notes";
import { shotRefusal, myOpenShotsOn as openShotsOn, outcomeText, settlePlan, sharedRecordState } from "@/lib/flow";
import { datasetWord, quizCities, randomSeed, type Place, type Word4 } from "@/lib/quiz";
import { type City } from "@/lib/rules";
import { Lobby, fmtGc } from "./Lobby";
import { Play, type PlayResult } from "./Play";
import "./AppContent.css";

type Mode =
  | { kind: "lobby" }
  | { kind: "play-champion"; seed: Word4; cities: City[] }
  | { kind: "post-record"; seed: Word4; cities: City[]; result: PlayResult }
  | { kind: "play-rival"; shots: GqNote[]; record?: GqNote }
  | { kind: "busy"; text: string }
  | { kind: "done"; text: string; txId?: string; share?: { url: string; x: string } };

export function AppContent() {
  // `useMidenClient()` throws until the provider has created the client, so gate on readiness first.
  const { isReady } = useMiden();
  if (!isReady) {
    return (
      <main className="gq">
        <h1>GQ · GeoQuizz on Miden</h1>
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
  const mintGeocoins = useGeocoin(client, runExclusive);

  const [places, setPlaces] = useState<Place[]>([]);
  const [dataset, setDataset] = useState<Word4 | null>(null);
  const [notes, setNotes] = useState<GqNote[]>([]);
  const [height, setHeight] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "lobby" });
  const [error, setError] = useState<string | null>(null);
  const [authCheck, setAuthCheck] = useState<boolean | null>(null);
  const [sharedRecord, setSharedRecord] = useState<GqNote | null>(null);
  const [code, setCode] = useState("");
  const params = new URLSearchParams(location.search);
  const sharedRecordId = params.get("record") ?? params.get("prize"); // ?prize= is the old link form

  /** A pasted link or id opens the record exactly like the link would. */
  const openCode = () => {
    const id = /0x[0-9a-f]{64}/i.exec(code)?.[0];
    if (!id) return setError("That is not a game code.");
    setError(null);
    fetchGqNote(id).then(setSharedRecord).catch((e) => setError(`Not found: ${e instanceof Error ? e.message : e}`));
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
    if (sharedRecordId) fetchGqNote(sharedRecordId).then(setSharedRecord).catch((e) => setError(`Shared record: ${e instanceof Error ? e.message : e}`));
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
        const records = await Promise.all(noteIds.map((id) => knownNote(client, id)));
        return posted ? records.every((r) => !!r) : records.every((r) => !!r?.consumed);
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
    if (!dataset || places.length === 0) return setError("Still loading the cities, try again in a second.");
    const seed = randomSeed();
    quizCities(seed, places)
      .then((cities) => {
        setMode({ kind: "play-champion", seed, cities });
      })
      .catch((e) => setError(`Could not start: ${e instanceof Error ? e.message : e}`));
  }

  const myOpenShotsOn = (record: GqNote) => openShotsOn(notes, me, record, height);

  /** Posts the shot note and, once it is on chain, starts the quiz right away. */
  function takeShot(record: GqNote) {
    if (!wallet.address || !dataset || !me) return;
    const refusal = shotRefusal(record, height, MIN_SHOT_WINDOW_BLOCKS);
    if (refusal) return setError(refusal);
    const open = myOpenShotsOn(record);
    if (open.length > 0) {
      // one Geocoin per sitting: play the shot already on the table instead of paying again
      setMode({ kind: "play-rival", shots: open, record });
      return;
    }
    const rival = me;
    run(
      "Taking your shot",
      true,
      async () => {
        // refuse a quiz that does not come from the seed and this dataset
        const expected = await quizCities(record.storage.seed, places);
        const same = expected.every((c, i) => JSON.stringify(c) === JSON.stringify(record.storage.cities[i]));
        if (!same || record.storage.dataset.some((f, i) => f !== dataset[i])) throw new Error("This record's quiz does not match the dataset.");
        return postShot(client, wallet, record, rival);
      },
      (submitted) => ({
        kind: "play-rival",
        record,
        shots: [
          {
            id: submitted.noteIds[0],
            idWord: wordFromHex(submitted.noteIds[0]),
            kind: "shot",
            storage: { ...record.storage, rival, recordId: record.idWord, shotDeadline: (submitted as Submitted & { deadline: number }).deadline },
            amount: record.storage.minStake,
            consumed: false,
          },
        ],
      }),
    );
  }

  const settleAfterPlay = (shots: GqNote[], record: GqNote | undefined) => (r: PlayResult) => {
    const plan = settlePlan(shots, record, r.score, height);
    if (!plan.won) {
      // nothing to sign on a loss: the Geocoin waits for the champion at the deadline
      setMode({ kind: "done", text: plan.text });
      return;
    }
    run(plan.text, false, () => settle(client, wallet, shots, plan.claimPrize ? record : undefined, r.answers));
  };

  const sharedRecordCard = (connected: boolean) => {
    if (!sharedRecord) return null;
    const state = sharedRecordState(sharedRecord, connected ? me : null, connected ? myOpenShotsOn(sharedRecord) : [], height);
    if (state === "claimed" || state === "expired") {
      return (
        <section className="result">
          <h2>This one is over.</h2>
        </section>
      );
    }
    return (
      <section className="result">
        <h2>Beat {sharedRecord.storage.target}?</h2>
        <p>Win {fmtGc(sharedRecord.amount)}.</p>
        {!connected && <button onClick={connect}>Play ({fmtGc(sharedRecord.storage.minStake)})</button>}
        {state === "mine" && <p className="muted">This is yours.</p>}
        {state === "already-challenged" && <button onClick={() => takeShot(sharedRecord)}>Play</button>}
        {state === "open" && connected && <button onClick={() => takeShot(sharedRecord)}>Play ({fmtGc(sharedRecord.storage.minStake)})</button>}
      </section>
    );
  };

  const connect = () => wallet.connect().catch((e) => setError(e instanceof Error ? e.message : String(e)));

  /** Mints the grant to the connected wallet; the local wallet then claims it, Bread claims by itself. */
  async function getGeocoins() {
    if (!wallet.address) return;
    setError(null);
    setMode({ kind: "busy", text: "Getting Geocoins" });
    try {
      const txId = await mintGeocoins(wallet.address);
      if (LOCAL_WALLET) await local.claim();
      setMode({ kind: "done", text: `${fmtGc(GEOCOIN_GRANT)} in your pocket. Done!`, txId });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMode({ kind: "lobby" });
    }
  }

  if (!wallet.connected) {
    return (
      <main className="gq">
        <h1>GQ</h1>
        <p>Find the city on the map.</p>
        {sharedRecord ? sharedRecordCard(false) : (
          <button onClick={connect} disabled={wallet.connecting}>
            {wallet.connecting ? (LOCAL_WALLET && local.status) || "…" : "Play"}
          </button>
        )}
        {wallet.wallet?.readyState !== "Installed" && <p className="muted">You need the Bread wallet first.</p>}
        {error && <p className="error">{error}</p>}
        {import.meta.env.DEV && authCheck === false && <p className="error">dev: auth-args self-check MISMATCH</p>}
        {!sharedRecord && codeBox}
      </main>
    );
  }

  return (
    <main className="gq">
      <header className="top">
        <h1>GQ</h1>
        <span className="muted">{LOCAL_WALLET ? `test wallet ${wallet.address}` : `${wallet.address?.slice(0, 10)}…`}</span>
        <button className="secondary" onClick={() => void getGeocoins()}>Empty pockets? Get Geocoins now!</button>
        <button className="secondary" onClick={() => void wallet.disconnect()}>Leave</button>
      </header>
      {error && <p className="error">{error}</p>}

      {mode.kind === "lobby" && (
        <>
          {sharedRecordCard(true)}
          <section className="cta">
            <button onClick={startChampion} disabled={!dataset || places.length === 0}>
              Play
            </button>
          </section>
          <Lobby
            me={me}
            notes={notes}
            height={height}
            onSettle={(shot, record) => {
              const open = record ? myOpenShotsOn(record) : [];
              setMode({ kind: "play-rival", shots: open.length > 0 ? open : [shot], record });
            }}
            onCollect={(note) => run("Taking it", false, () => collect(client, wallet, note))}
          />
          {!sharedRecord && codeBox}
        </>
      )}

      {mode.kind === "play-champion" && (
        <Play cities={mode.cities} places={places} onDone={(result) => setMode({ kind: "post-record", seed: mode.seed, cities: mode.cities, result })} />
      )}

      {mode.kind === "post-record" && (
        <section className="result">
          <h2>{mode.result.score} points</h2>
          <p>Put {fmtGc(STAKE)} on it? Whoever beats you takes it. Whoever fails pays you {fmtGc(STAKE)}.</p>
          <button
            onClick={() =>
              run("Posting", true, () => {
                const storage: ChallengeStorage = {
                  expiryBlock: height + RECORD_LIFETIME_BLOCKS,
                  target: mode.result.score,
                  minStake: STAKE,
                  champion: me!,
                  rival: null,
                  recordId: [0n, 0n, 0n, 0n],
                  shotRoot: [0n, 0n, 0n, 0n], // filled from the loaded script
                  seed: mode.seed,
                  dataset: dataset!,
                  cities: mode.cities,
                  shotDeadline: 0,
                };
                return postRecord(client, wallet, storage, STAKE);
              }, ({ txId, noteIds }) => ({
                kind: "done",
                text: "Now find someone to beat you.",
                txId,
                share: recordLinks(noteIds[0], mode.result.score),
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

      {mode.kind === "play-rival" && (
        <Play cities={mode.shots[0].storage.cities} places={places} onDone={settleAfterPlay(mode.shots, mode.record)} />
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
