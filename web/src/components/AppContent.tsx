// GeoQuizz screens: welcome → 1P World Tour (play, then put a Geocoin on it) / VS (a record by
// link or code, take a shot) / Player Hub (my records, my shots, what rivals left me).
// The app's own Miden client only reads the chain (and mints Geocoins); the wallet signs the rest.

import { useCallback, useEffect, useRef, useState } from "react";
import { useMidenClient, useMiden } from "@miden-sdk/react";
import { useMidenFiWallet } from "@miden-sdk/miden-wallet-adapter-react";
import { LOCAL_WALLET, useLocalWallet } from "@/lib/localWallet";
import { GEOCOIN_GRANT, useGeocoin } from "@/lib/geocoin";
import { useSound } from "@/lib/useSound";
import { CITIES_URL, MIN_SHOT_WINDOW_BLOCKS, RECORD_LIFETIME_BLOCKS, STAKE } from "@/config";
import { accountFelts, fetchGqNote, knownNote, listGqNotes, loadScripts, parseAccountId, recordLinks, syncGq, wordFromHex, type GqNote } from "@/lib/chain";
import { postShot, postRecord, settle, collect, selfCheckAuthArgs, setSubmitAttemptListener, waitFor, type Submitted } from "@/lib/bread";
import { shotDeadline, type ChallengeStorage } from "@/lib/notes";
import { NOT_FINISHED, shotRefusal, myOpenShotsOn as openShotsOn, outcomeText, parseCode, reportRows, settlePlan, sharedRecordState, type ReportRow } from "@/lib/flow";
import { datasetWord, quizCities, randomSeed, type Place, type Word4 } from "@/lib/quiz";
import { type City } from "@/lib/rules";
import { Lobby, fmtGc } from "./Lobby";
import { Play, type PlayResult } from "./Play";
import { Shell } from "./Shell";
import { TAB_LABEL, type Tab } from "@/lib/tabs";
import { Welcome } from "./Welcome";
import { WorldMap } from "./WorldMap";

type Mode =
  | { kind: "lobby" }
  | { kind: "play-champion"; seed: Word4; cities: City[] }
  | { kind: "post-record"; seed: Word4; cities: City[]; result: PlayResult }
  | { kind: "play-rival"; shots: GqNote[]; record?: GqNote }
  /** `back`: where the Back button, a failure or a wallet that never finishes returns to */
  | { kind: "busy"; text: string; back: Mode }
  | { kind: "done"; title?: string; text: string; rows?: ReportRow[]; txId?: string; share?: { url: string; x: string }; retry?: () => void };

/** Something that needs a connected wallet; it runs once the wallet is there. */
type Intent = { kind: "post"; m: Extract<Mode, { kind: "post-record" }> } | { kind: "shot"; record: GqNote } | { kind: "geocoins" };

export function AppContent() {
  // `useMidenClient()` throws until the provider has created the client, so gate on readiness first.
  const { isReady } = useMiden();
  if (!isReady) {
    return (
      <main>
        <p className="muted">Loading…</p>
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

  const params = new URLSearchParams(location.search);
  const sharedRecordId = params.get("record") ?? params.get("prize"); // ?prize= is the old link form

  const [started, setStarted] = useState(!!sharedRecordId);
  const [tab, setTab] = useState<Tab>(sharedRecordId ? "vs" : "1p");
  const [places, setPlaces] = useState<Place[]>([]);
  const [dataset, setDataset] = useState<Word4 | null>(null);
  const [notes, setNotes] = useState<GqNote[]>([]);
  const [height, setHeight] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "lobby" });
  const [error, setError] = useState<string | null>(null);
  const [authCheck, setAuthCheck] = useState<boolean | null>(null);
  const [sharedRecord, setSharedRecord] = useState<GqNote | null>(null);
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<Intent | null>(null);
  const sound = useSound(
    mode.kind === "play-champion" ? "play" : mode.kind === "play-rival" ? "vs" : mode.kind === "post-record" || (mode.kind === "done" && mode.rows) ? "result" : "home",
  );
  // a Back press (or a newer run) makes an older run's late answer land nowhere
  const runToken = useRef(0);

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

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const connect = () => wallet.connect().catch(fail);
  const connected = wallet.connected && !!wallet.address;

  /** Runs `intent` now, or connects first (Bread opens its popup, the test wallet creates itself) and runs it then. */
  function withWallet(intent: Intent) {
    if (connected) return void perform(intent);
    setPending(intent);
    void wallet.connect().catch((e) => {
      setPending(null);
      fail(e);
    });
  }
  useEffect(() => {
    if (!pending || !connected) return;
    const intent = pending;
    setPending(null);
    void perform(intent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, connected]);

  function perform(intent: Intent) {
    if (intent.kind === "post") return postMyRecord(intent.m);
    if (intent.kind === "shot") return takeShot(intent.record);
    return getGeocoins();
  }

  /**
   * Runs a wallet transaction, then waits until the chain shows its effect (`posted`: the new note
   * exists; otherwise: the consumed notes are gone). A wallet only acknowledges the request (Bread
   * answers as soon as you approve, and can still fail afterwards in its own queue), so nothing is
   * called done before the chain shows it. A failure, or a wallet that never finishes, returns to
   * `back` with the error: the score or the record stays on screen, ready for another try.
   */
  async function run(text: string, posted: boolean, fn: () => Promise<Submitted>, back: Mode, onConfirmed?: (s: Submitted) => Mode | void) {
    const token = ++runToken.current;
    const live = () => runToken.current === token;
    setError(null);
    setMode({ kind: "busy", text, back });
    setSubmitAttemptListener((attempt) => live() && setMode({ kind: "busy", text: attempt > 1 ? `${text} (try ${attempt})` : text, back }));
    try {
      const submitted = await fn();
      const { txId, noteIds } = submitted;
      const seen = await waitFor(client, runExclusive, async () => {
        const records = await Promise.all(noteIds.map((id) => knownNote(client, id)));
        return posted ? records.every((r) => !!r) : records.every((r) => !!r?.consumed);
      });
      if (!live()) return;
      void refresh();
      if (seen) return setMode(onConfirmed?.(submitted) ?? { kind: "done", text: outcomeText(text, true), txId });
      setError(NOT_FINISHED);
      setMode(back);
    } catch (e) {
      if (!live()) return;
      fail(e);
      setMode(back);
    }
  }

  function startChampion() {
    if (!dataset || places.length === 0) return setError("Still loading the cities, try again in a second.");
    setError(null);
    const seed = randomSeed();
    quizCities(seed, places)
      .then((cities) => setMode({ kind: "play-champion", seed, cities }))
      .catch((e) => setError(`Could not start: ${e instanceof Error ? e.message : e}`));
  }

  async function postMyRecord(m: Extract<Mode, { kind: "post-record" }>) {
    if (!dataset) return;
    const champion = accountFelts(parseAccountId(wallet.address!));
    await run(
      "Posting your record",
      true,
      () => {
        const storage: ChallengeStorage = {
          expiryBlock: height + RECORD_LIFETIME_BLOCKS,
          target: m.result.score,
          minStake: STAKE,
          champion,
          rival: null,
          recordId: [0n, 0n, 0n, 0n],
          shotRoot: [0n, 0n, 0n, 0n], // filled from the loaded script
          seed: m.seed,
          dataset,
          cities: m.cities,
          shotDeadline: 0,
        };
        return postRecord(client, wallet, storage, STAKE);
      },
      m,
      ({ txId, noteIds }) => ({ kind: "done", title: "Record posted!", text: "Now find someone to beat you.", txId, share: recordLinks(noteIds[0], m.result.score) }),
    );
  }

  const myOpenShotsOn = (record: GqNote) => openShotsOn(notes, me, record, height);

  /** Posts the shot note and, once it is on chain, starts the quiz right away. */
  async function takeShot(record: GqNote) {
    if (!dataset) return;
    const rival = accountFelts(parseAccountId(wallet.address!));
    const refusal = shotRefusal(record, height, MIN_SHOT_WINDOW_BLOCKS);
    if (refusal) return setError(refusal);
    const open = openShotsOn(notes, rival, record, height);
    if (open.length > 0) {
      // one Geocoin per sitting: play the shot already on the table instead of paying again
      setMode({ kind: "play-rival", shots: open, record });
      return;
    }
    await run(
      "Inserting your Geocoin",
      true,
      async () => {
        // refuse a quiz that does not come from the seed and this dataset
        const expected = await quizCities(record.storage.seed, places);
        const same = expected.every((c, i) => JSON.stringify(c) === JSON.stringify(record.storage.cities[i]));
        if (!same || record.storage.dataset.some((f, i) => f !== dataset[i])) throw new Error("This record's quiz does not match the dataset.");
        return postShot(client, wallet, record, rival);
      },
      { kind: "lobby" },
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
    const rows = reportRows(shots[0].storage.cities, r.answers, places);
    if (!plan.won) {
      // nothing to sign on a loss: the Geocoin waits for the champion at the deadline
      setMode({ kind: "done", title: "The record stands.", text: plan.text, rows });
      return;
    }
    const claim = (): void =>
      void run(
        plan.text,
        false,
        () => settle(client, wallet, shots, plan.claimPrize ? record : undefined, r.answers),
        // the win stands on failure: the report stays and the claim can be sent again
        { kind: "done", title: "Record smashed!", text: plan.text, rows, retry: claim },
        () => ({ kind: "done", title: "Record smashed!", text: outcomeText(plan.text, true), rows }),
      );
    claim();
  };

  /** Mints the grant to the connected wallet; the local wallet then claims it, Bread claims by itself. */
  async function getGeocoins() {
    setError(null);
    setMode({ kind: "busy", text: "Getting Geocoins", back: { kind: "lobby" } });
    try {
      const txId = await mintGeocoins(wallet.address!);
      if (LOCAL_WALLET) await local.claim();
      setMode({ kind: "done", text: `${fmtGc(GEOCOIN_GRANT)} for you! Open your wallet to take them.`, txId });
    } catch (e) {
      fail(e);
      setMode({ kind: "lobby" });
    }
  }

  /** A pasted link or id opens the record exactly like the link would. */
  const openCode = () => {
    const parsed = parseCode(code);
    if ("hint" in parsed) return setError(parsed.hint);
    setError(null);
    fetchGqNote(parsed.id).then(setSharedRecord).catch((e) => setError(`Not found: ${e instanceof Error ? e.message : e}`));
  };

  const geocoinButton = (
    <button className="btn" onClick={() => withWallet({ kind: "geocoins" })}>
      Empty pockets? Get Geocoins now!
    </button>
  );
  const codeBox = (
    <section className="panel">
      <div className="panel-title">Have a code?</div>
      <p className="muted">Paste a record link or code.</p>
      <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="paste the link or code" aria-label="Record link or code" />
      <button className="btn" onClick={openCode}>
        Go
      </button>
    </section>
  );

  const recordCard = () => {
    if (!sharedRecord) return null;
    const state = sharedRecordState(sharedRecord, me, me ? myOpenShotsOn(sharedRecord) : [], height);
    if (state === "claimed" || state === "expired") {
      return (
        <section className="panel pink">
          <div className="panel-title">Record</div>
          <h2>This one is over.</h2>
        </section>
      );
    }
    return (
      <section className="panel pink">
        <div className="panel-title">Record</div>
        <div className="big-score">{sharedRecord.storage.target.toLocaleString()} pts to beat</div>
        <div className="row">
          <span>Prize</span>
          <span className="value">{fmtGc(sharedRecord.amount)}</span>
        </div>
        <div className="row">
          <span>One shot</span>
          <span className="value">{fmtGc(sharedRecord.storage.minStake)}</span>
        </div>
        {state === "mine" && <p className="muted">This is yours.</p>}
        {state === "already-challenged" && (
          <button className="btn primary wide" onClick={() => withWallet({ kind: "shot", record: sharedRecord })}>
            Play
          </button>
        )}
        {state === "open" && (
          <button className="btn primary wide" onClick={() => withWallet({ kind: "shot", record: sharedRecord })}>
            Insert Geocoin
          </button>
        )}
        <p className="muted small" style={{ marginTop: 14 }}>
          Win: your Geocoin back, plus the prize. Lose: your Geocoin goes to the champion.
        </p>
      </section>
    );
  };

  const walletLabel = wallet.connected && wallet.address ? `${LOCAL_WALLET ? "Test wallet" : "Wallet"} ${wallet.address.slice(0, 10)}…` : null;

  if (!started) return <Welcome onStart={() => setStarted(true)} />;

  return (
    <Shell
      tab={tab}
      onTab={(t) => {
        setTab(t);
        setMode({ kind: "lobby" });
      }}
      crumb={TAB_LABEL[tab]}
      walletLabel={walletLabel}
      onWallet={() => (wallet.connected ? void wallet.disconnect() : connect())}
      soundOn={sound.on}
      onSound={sound.toggle}
    >
      {error && <p className="error">{error}</p>}
      {import.meta.env.DEV && authCheck === false && <p className="error">dev: auth-args self-check MISMATCH</p>}

      {mode.kind === "lobby" && tab === "1p" && (
        <>
          <h1 className="slogan">
            <span>Locate.</span> <span>Challenge.</span> <span>Win.</span>
          </h1>
          <div className="cols">
            <div className="panel map-frame">
              <WorldMap />
            </div>
            <aside className="panel">
              <div className="panel-title">1P World Tour</div>
              <p>10 cities, 15 seconds each.</p>
              <p className="muted">Free to play.</p>
              <button className="btn primary wide" onClick={startChampion} disabled={!dataset || places.length === 0}>
                Locate first city
              </button>
            </aside>
          </div>
        </>
      )}

      {mode.kind === "lobby" && tab === "vs" && (
        <div className="arena">
          <img className="hero" src="/brand/hero-arena.webp" alt="" width={1440} height={960} />
          <div className="overlay">
            {recordCard() ?? codeBox}
            {geocoinButton}
          </div>
        </div>
      )}

      {mode.kind === "lobby" && tab === "hub" && (
        <>
          <h1>Player Hub</h1>
          {wallet.connected ? (
            <>
              <Lobby
                me={me}
                notes={notes}
                height={height}
                onSettle={(shot, record) => {
                  const open = record && me ? myOpenShotsOn(record) : [];
                  setMode({ kind: "play-rival", shots: open.length > 0 ? open : [shot], record });
                }}
                onCollect={(note) => void run("Taking it", false, () => collect(client, wallet, note), { kind: "lobby" })}
              />
              <p>{geocoinButton}</p>
            </>
          ) : (
            <section className="panel">
              <p>Connect your wallet to see your records and shots.</p>
              <button className="btn primary" onClick={connect} disabled={wallet.connecting}>
                {wallet.connecting ? (LOCAL_WALLET && local.status) || "…" : "Connect wallet"}
              </button>
              {!LOCAL_WALLET && wallet.wallet?.readyState !== "Installed" && <p className="muted">You need the Bread wallet first.</p>}
            </section>
          )}
        </>
      )}

      {mode.kind === "play-champion" && <Play cities={mode.cities} places={places} onDone={(result) => setMode({ kind: "post-record", seed: mode.seed, cities: mode.cities, result })} />}

      {mode.kind === "post-record" && (
        <div className="cols">
          <section className="panel">
            <div className="panel-title">Run complete!</div>
            <div className="big-score">{mode.result.score.toLocaleString()} pts</div>
            <Report rows={reportRows(mode.cities, mode.result.answers, places)} />
          </section>
          <aside className="panel yellow">
            <div className="panel-title">Post your record?</div>
            <p>Rivals pay 1 Geocoin to try to beat you. If they do, they take your Geocoin. Otherwise, their Geocoin is yours!</p>
            <button className="btn primary wide" onClick={() => withWallet({ kind: "post", m: mode })}>
              Post it
            </button>
            <button className="btn wide" onClick={() => setMode({ kind: "lobby" })}>
              Not now
            </button>
          </aside>
        </div>
      )}

      {mode.kind === "play-rival" && (
        <Play
          cities={mode.shots[0].storage.cities}
          places={places}
          rival={{ blocksLeft: shotDeadline(mode.shots[0].storage) - height }}
          onDone={settleAfterPlay(mode.shots, mode.record)}
        />
      )}

      {mode.kind === "busy" && (
        <section className="panel">
          <h2>{mode.text}…</h2>
          <p className="muted">Check your wallet.</p>
          <button
            className="btn"
            onClick={() => {
              runToken.current++;
              setMode(mode.back);
            }}
          >
            Back
          </button>
        </section>
      )}

      {mode.kind === "done" && (
        <section className="panel yellow">
          {mode.title && <h2>{mode.title}</h2>}
          <p>{mode.text}</p>
          {mode.rows && <Report rows={mode.rows} />}
          {mode.share && (
            <p>
              <a className="btn primary" href={mode.share.x} target="_blank" rel="noreferrer">
                Share on X
              </a>
              <button className="btn" onClick={() => void navigator.clipboard.writeText(mode.share!.url)}>
                Copy link
              </button>
            </p>
          )}
          {mode.retry && (
            <button className="btn primary" onClick={mode.retry}>
              Try again
            </button>
          )}
          <button className={mode.retry ? "btn" : "btn primary"} onClick={() => setMode({ kind: "lobby" })}>
            OK
          </button>
        </section>
      )}
    </Shell>
  );
}

function Report({ rows }: { rows: ReportRow[] }) {
  return (
    <table className="report">
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td>{r.name}</td>
            <td>{r.seconds}</td>
            <td>{r.points}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
