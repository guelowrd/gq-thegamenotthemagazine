// GeoQuizz screens: welcome → 1P World Tour (play, then put a Geocoin on it) / VS (a record by
// link or code, take a shot) / Player Hub (my records, my shots, what rivals left me).
// The app's own Miden client only reads the chain (and mints Geocoins); the wallet signs the rest.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMidenClient, useMiden } from "@miden-sdk/react";
import { useMidenFiWallet } from "@miden-sdk/miden-wallet-adapter-react";
import { LOCAL_WALLET, useLocalWallet } from "@/lib/localWallet";
import { GEOCOIN_GRANT, geocoinRefusal, GRANT_PENDING_MS, useGeocoin } from "@/lib/geocoin";
import { useSound, type Track } from "@/lib/useSound";
import { BLOCK_SECONDS, CITIES_URL, MIN_SHOT_WINDOW_BLOCKS, RECORD_LIFETIME_BLOCKS, STAKE, TEST_ACCOUNTS } from "@/config";
import { accountFelts, bech32Of, fetchChallengeNote, hexOf, knownNote, listChallengeNotes, loadScripts, parseAccountId, syncNotes, wordFromHex, type ChallengeNote } from "@/lib/chain";
import { boards, history as pastGames, keyOf, lettersBackward, nicknames, playersInOrder } from "@/lib/hub";
import { gcBalance, postShot, postRecord, settle, collect, reportBreadOutcome, setSubmitAttemptListener, setSubmitStageListener, waitFor, type Submitted } from "@/lib/bread";
import { shotDeadline, type ChallengeStorage } from "@/lib/notes";
import { claimVerdict, explain, fmtGeocoin, NOT_FINISHED, SHOT_LOST, shotRefusal, withoutRecord, withTimeout, type Trouble, myOpenShotsOn as openShotsOn, outcomeText, parseCode, reportRows, settlePlan, sharedRecordState, type ReportRow } from "@/lib/flow";
import { datasetWord, decodeGame, encodeGame, quizCities, randomSeed, type Place, type Word4 } from "@/lib/quiz";
import { gqAnswer, type City } from "@/lib/rules";
import { History } from "./History";
import { Leaderboards } from "./Leaderboards";
import { Lobby } from "./Lobby";
import { ShareButtons } from "./ShareButtons";
import { Play, type PlayResult } from "./Play";
import { Shell } from "./Shell";
import { ClaimButton, ErrorBox, Waiting, type Stage } from "./Status";
import { type Tab } from "@/lib/tabs";
import { Welcome } from "./Welcome";
import { WorldMap } from "./WorldMap";

type Mode =
  | { kind: "lobby" }
  | { kind: "play-champion"; seed: Word4; cities: City[] }
  | { kind: "post-record"; seed: Word4; cities: City[]; result: PlayResult }
  | { kind: "play-rival"; shots: ChallengeNote[]; record?: ChallengeNote }
  /** `back`: where the Back button, a failure or a wallet that never finishes returns to */
  /** `track`: the music of the screen it came from, which keeps playing while it waits */
  | { kind: "busy"; text: string; back: Mode; stage: Stage; since: number; track: Track }
  /** `claimed`: the record is won, OK leaves it behind; after a round (`rows` or `share`) OK goes back to the splash screen */
  | { kind: "done"; title?: string; text: string; rows?: ReportRow[]; txId?: string; share?: { recordId: string; score: number }; retry?: () => void; retryLabel?: string; claimed?: boolean;
      /** when a retried claim stops making sense: the shot's end, as a clock time (ms) */
      claimUntil?: number };

/**
 * The music each screen plays: the solo song during a 1P run, the result song from "Post your
 * record?" until OK on "Record posted!", the VS song during a shot and the result song from the
 * moment it ends (claiming included); a waiting screen keeps the song of the screen it came from;
 * the home theme elsewhere.
 */
const trackOf = (m: Mode): Track =>
  m.kind === "play-champion"
    ? "play"
    : m.kind === "play-rival"
      ? "vs"
      : m.kind === "post-record" || (m.kind === "done" && (m.share || m.rows))
        ? "result"
        : m.kind === "busy"
          ? m.track
          : "home";

/** Something that needs a connected wallet; it runs once the wallet is there. */
type Intent = { kind: "post"; m: Extract<Mode, { kind: "post-record" }> } | { kind: "shot"; record: ChallengeNote } | { kind: "geocoins" };

export function AppContent() {
  // `useMidenClient()` throws until the provider has created the client, so gate on readiness first.
  const { isReady, error } = useMiden();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 20_000);
    return () => clearTimeout(t);
  }, []);
  if (!isReady) {
    return (
      <main>
        {error ? (
          <ErrorBox trouble={{ ...explain(error), title: "The game could not start." }} onRetry={() => location.reload()} onClose={() => location.reload()} />
        ) : (
          <>
            <p className="muted">Loading…</p>
            {slow && (
              <p className="muted">
                This is taking long. Check your connection, or{" "}
                <button className="btn" onClick={() => location.reload()}>
                  Reload
                </button>
              </p>
            )}
          </>
        )}
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
  const [notes, setNotes] = useState<ChallengeNote[]>([]);
  // the first read of every game's notes, history and boards wait for it
  const [notesRead, setNotesRead] = useState(false);
  const [height, setHeight] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "lobby" });
  const [trouble, setTrouble] = useState<{ t: Trouble; retry?: () => void } | null>(null);
  const [netSlow, setNetSlow] = useState(false);
  const [sharedRecord, setSharedRecord] = useState<ChallengeNote | null>(null);
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<Intent | null>(null);
  const sound = useSound(trackOf(mode));
  // a Back press (or a newer run) makes an older run's late answer land nowhere
  const runToken = useRef(0);
  /** The last Geocoin grant, so a second press does not mint again before Bread takes the first. */
  const lastGrant = useRef<{ to: string; at: number } | null>(null);

  const me = wallet.connected && wallet.address ? accountFelts(parseAccountId(wallet.address)) : null;
  const meKey = me && keyOf(me);
  // the boards and the nickname order leave the development wallets' test rounds out
  const publicNotes = useMemo(() => {
    const test = (a: ChallengeStorage["rival"]) => !!a && TEST_ACCOUNTS.includes(hexOf(a));
    return notes.filter((n) => !test(n.storage.champion) && !test(n.storage.rival));
  }, [notes]);
  // arcade names for everyone who played, in the order they first did; a newcomer comes last
  const names = useMemo(() => {
    const players = playersInOrder(publicNotes);
    if (me && !players.some((p) => keyOf(p) === meKey)) players.push(me);
    return nicknames(players.map((p) => ({ key: keyOf(p), address: bech32Of(p) })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicNotes, meKey]);
  const nameOf = (a: Parameters<typeof keyOf>[0]) => names.get(keyOf(a)) ?? lettersBackward(bech32Of(a)).slice(0, 3);

  /** A failure in plain words, with a way to try again when there is one. */
  const oops = (e: unknown, retry?: () => void) => setTrouble({ t: explain(e), retry });
  /** A message that is already in plain words. */
  const say = (title: string) => setTrouble({ t: { kind: "unknown", title } });
  const reload = () => location.reload();

  /** A record opened by link or code; a slow network gets "Try again". */
  const loadRecord = (id: string) =>
    withTimeout(fetchChallengeNote(id), 30_000, "Loading the record")
      .then((r) => {
        setSharedRecord(r);
        setTrouble(null);
      })
      .catch((e) => oops(e, () => void loadRecord(id)));

  useEffect(() => {
    withTimeout(fetch(CITIES_URL), 30_000, "Loading the cities")
      .then(async (r) => {
        if (!r.ok) throw new Error(`Loading the cities: HTTP ${r.status}`);
        const bytes = new Uint8Array(await r.arrayBuffer());
        setDataset(await datasetWord(bytes));
        setPlaces(JSON.parse(new TextDecoder().decode(bytes)));
      })
      .catch((e) => oops(e, reload));
    loadScripts().catch((e) => oops(e, reload));
    if (sharedRecordId) void loadRecord(sharedRecordId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // a failed background sync is not the player's problem: a tag in the ribbon until the next good one.
  // The chain height every 15 s (the countdowns need it). The game's notes cost the node a request per
  // open note: read on a timer only until the first read works, then after my own moves and on Refresh.
  const [refreshing, setRefreshing] = useState(false);
  const notesReadRef = useRef(false);
  const refresh = useCallback(
    async (withNotes = true) => {
      if (!isReady || !client) return;
      if (withNotes) setRefreshing(true);
      try {
        const h = await withTimeout(runExclusive(() => syncNotes(client)), 30_000, "Syncing");
        setHeight(h);
        if (withNotes) {
          setNotes(await listChallengeNotes(h));
          notesReadRef.current = true;
          setNotesRead(true);
        }
        setNetSlow(false);
      } catch (e) {
        console.warn("[gq] background sync failed", e);
        setNetSlow(true);
      } finally {
        if (withNotes) setRefreshing(false);
      }
    },
    [client, isReady, runExclusive],
  );

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(!notesReadRef.current), 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  const connect = (): void => void wallet.connect().catch((e) => oops(e, connect));
  const connected = wallet.connected && !!wallet.address;

  /** Runs `intent` now, or connects first (Bread opens its popup, the test wallet creates itself) and runs it then. */
  function withWallet(intent: Intent) {
    if (connected) return void perform(intent);
    setPending(intent);
    void wallet.connect().catch((e) => {
      setPending(null);
      oops(e, () => withWallet(intent));
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
   * `back` with the error in plain words and Try again: the score or the record stays on screen.
   * `previous`: the attempt that never showed. Try again first looks whether it landed after all,
   * so a slow network never makes anyone post or pay twice.
   */
  async function run(text: string, posted: boolean, fn: () => Promise<Submitted>, back: Mode, onConfirmed?: (s: Submitted) => Mode | void, previous?: Submitted) {
    const token = ++runToken.current;
    const live = () => runToken.current === token;
    const update = (patch: Partial<Extract<Mode, { kind: "busy" }>>) => setMode((m) => (live() && m.kind === "busy" ? { ...m, ...patch } : m));
    const again = (attempt?: Submitted) => () => void run(text, posted, fn, back, onConfirmed, attempt);
    const landed = async (ids: string[]) => {
      const records = await Promise.all(ids.map((id) => knownNote(id)));
      return posted ? records.every((r) => !!r) : records.every((r) => !!r?.consumed);
    };
    // a screen with its own retry button (the claim after a win) gets the smarter retry and the
    // error box only explains: one button, named for what it does
    const fallBack = (e: unknown, retry: () => void) => {
      if (back.kind === "done" && back.retry) {
        oops(e);
        // too late is final: no claim button to press any more
        setMode({ ...back, retry: explain(e).kind === "too-late" ? undefined : retry });
      } else {
        oops(e, retry);
        setMode(back);
      }
    };
    const finish = (s: Submitted) => {
      void refresh();
      setMode(onConfirmed?.(s) ?? { kind: "done", text: outcomeText(text, true), txId: s.txId });
    };
    setTrouble(null);
    // waiting keeps the song of the screen it came from; after a quiz, the song of what comes next
    const track = mode.kind === "play-champion" || mode.kind === "play-rival" ? trackOf(back) : trackOf(mode);
    setMode({ kind: "busy", text, back, stage: previous ? "network" : "prepare", since: Date.now(), track });
    setSubmitAttemptListener((attempt) => update({ text: attempt > 1 ? `${text} (try ${attempt})` : text }));
    setSubmitStageListener((stage) => update({ stage, since: Date.now() }));
    try {
      if (previous) {
        await runExclusive(() => syncNotes(client)).catch(() => undefined);
        if (await runExclusive(() => landed(previous.noteIds))) return live() ? finish(previous) : undefined;
        update({ stage: "prepare", since: Date.now() });
      }
      const submitted = await fn();
      update({ stage: "network", since: Date.now() });
      const seen = await waitFor(client, runExclusive, () => landed(submitted.noteIds));
      reportBreadOutcome(seen);
      if (!live()) return;
      if (seen) return finish(submitted);
      void refresh();
      fallBack(new Error(NOT_FINISHED), again(submitted));
    } catch (e) {
      if (!live()) return;
      fallBack(e, again(previous));
    }
  }

  function startChampion() {
    if (!dataset || places.length === 0) return say("Still loading the cities, try again in a second.");
    setTrouble(null);
    const seed = randomSeed();
    quizCities(seed, places)
      .then((cities) => setMode({ kind: "play-champion", seed, cities }))
      .catch((e) => oops(e, startChampion));
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
          game: encodeGame({ seed: m.seed, dataset, cities: m.cities }),
          shotDeadline: 0,
        };
        return postRecord(client, wallet, storage, STAKE);
      },
      m,
      ({ txId, noteIds }) => ({ kind: "done", title: "Record posted!", text: "Now find someone to beat you.", txId, share: { recordId: noteIds[0], score: m.result.score } }),
    );
  }

  const myOpenShotsOn = (record: ChallengeNote) => openShotsOn(notes, me, record, height);

  /** Posts the shot note and, once it is on chain, starts the quiz right away. */
  async function takeShot(record: ChallengeNote) {
    if (!dataset) return;
    const rival = accountFelts(parseAccountId(wallet.address!));
    const refusal = shotRefusal(record, height, MIN_SHOT_WINDOW_BLOCKS);
    if (refusal) return say(refusal);
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
        const game = decodeGame(record.storage.game);
        const expected = await quizCities(game.seed, places);
        const same = expected.every((c, i) => JSON.stringify(c) === JSON.stringify(game.cities[i]));
        if (!same || game.dataset.some((f, i) => f !== dataset[i])) throw new Error("This record's quiz does not match the dataset.");
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

  const settleAfterPlay = (shots: ChallengeNote[], record: ChallengeNote | undefined) => (r: PlayResult) => {
    const plan = settlePlan(shots, record, r.score, height);
    const rows = reportRows(decodeGame(shots[0].storage.game).cities, r.answers, places);
    if (!plan.won) {
      // nothing to sign on a loss: the Geocoin waits for the champion at the deadline
      setMode({ kind: "done", title: "The record stands.", text: plan.text, rows });
      return;
    }
    const claimUntil = Date.now() + (shotDeadline(shots[0].storage) - height) * BLOCK_SECONDS * 1000;
    const claim = (): void =>
      void run(
        plan.text,
        false,
        async () => {
          // ask the chain first: a claim that already landed (or a shot already taken) needs no wallet
          const now = await Promise.all(shots.map((s) => withTimeout(fetchChallengeNote(s.id), 30_000, "Checking your shot")));
          const verdict = claimVerdict(now.map((s) => ({ consumedAt: s.consumedAt, deadline: shotDeadline(s.storage) })));
          if (verdict === "claimed") return { txId: "", noteIds: shots.map((s) => s.id) };
          if (verdict === "lost") throw new Error(SHOT_LOST);
          return settle(client, wallet, shots, plan.claimPrize ? record : undefined, gqAnswer(r.answers));
        },
        // the win stands on failure: the report stays and the claim can be sent again until the shot ends
        { kind: "done", title: "Record smashed!", text: plan.text, rows, retry: claim, retryLabel: plan.claimPrize ? "Claim my prize" : "Get my Geocoin back", claimUntil },
        () => {
          // the prize is ours: the record card must not offer it again
          if (plan.claimPrize && record) setSharedRecord((r) => (r && r.id === record.id ? { ...r, consumed: true } : r));
          return { kind: "done", title: "Record smashed!", text: outcomeText(plan.text, true), rows, claimed: true };
        },
      );
    claim();
  };

  /** Mints the grant to the connected wallet; the local wallet then claims it, Bread claims by itself. */
  async function getGeocoins() {
    const token = ++runToken.current;
    setTrouble(null);
    setMode({ kind: "busy", text: "Getting Geocoins", back: { kind: "lobby" }, stage: "network", since: Date.now(), track: trackOf(mode) });
    try {
      const grant = lastGrant.current;
      const refusal = geocoinRefusal(await gcBalance(wallet), grant?.to === wallet.address && Date.now() - grant.at < GRANT_PENDING_MS);
      if (refusal) {
        if (runToken.current !== token) return;
        setMode({ kind: "lobby" });
        return say(refusal);
      }
      const txId = await withTimeout(mintGeocoins(wallet.address!), 180_000, "Getting Geocoins");
      lastGrant.current = { to: wallet.address!, at: Date.now() };
      if (LOCAL_WALLET) await local.claim();
      if (runToken.current !== token) return;
      setMode({ kind: "done", text: `${fmtGeocoin(GEOCOIN_GRANT)} for you! Open your wallet to take them.`, txId });
    } catch (e) {
      if (runToken.current !== token) return;
      oops(e, () => withWallet({ kind: "geocoins" }));
      setMode({ kind: "lobby" });
    }
  }

  /** A pasted link or id opens the record exactly like the link would. */
  const openCode = () => {
    const parsed = parseCode(code);
    if ("hint" in parsed) return say(parsed.hint);
    setTrouble(null);
    void loadRecord(parsed.id);
  };

  const refreshButton = (
    <button className="btn" onClick={() => void refresh()} disabled={refreshing}>
      {refreshing ? "Refreshing…" : "Refresh"}
    </button>
  );
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

  // the record as loaded from its link, updated by what the background sync has seen since
  const record = sharedRecord && { ...sharedRecord, consumed: sharedRecord.consumed || notes.some((n) => n.consumed && n.id.toLowerCase() === sharedRecord.id.toLowerCase()) };

  const recordCard = () => {
    if (!record) return null;
    const sharedRecord = record;
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
          <span className="value">{fmtGeocoin(sharedRecord.amount)}</span>
        </div>
        <div className="row">
          <span>One shot</span>
          <span className="value">{fmtGeocoin(sharedRecord.storage.minStake)}</span>
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
        <p className="muted terms" style={{ margin: "14px 0 0" }}>
          Win and get your Geocoin back plus the prize :)
          <br />
          Lose and your Geocoin goes to the champion :(
        </p>
      </section>
    );
  };

  const goHome = () => {
    runToken.current++;
    setTrouble(null);
    setMode({ kind: "lobby" });
    setTab("1p");
    setStarted(false);
  };

  const walletLabel = wallet.connected && me ? `${LOCAL_WALLET ? "Test wallet" : "Wallet"} / ${nameOf(me)}` : null;

  if (!started) return <Welcome onStart={() => setStarted(true)} />;

  return (
    <Shell
      tab={tab}
      onTab={(t) => {
        setTab(t);
        setTrouble(null);
        setMode({ kind: "lobby" });
      }}
      onHome={goHome}
      walletLabel={walletLabel}
      netSlow={netSlow}
      onWallet={() => (wallet.connected ? void wallet.disconnect() : connect())}
      soundOn={sound.on}
      onSound={sound.toggle}
    >
      {trouble && (
        <ErrorBox
          trouble={trouble.t}
          onRetry={
            trouble.retry &&
            (() => {
              const retry = trouble.retry!;
              setTrouble(null);
              retry();
            })
          }
          onGeocoins={() => {
            setTrouble(null);
            withWallet({ kind: "geocoins" });
          }}
          onClose={() => setTrouble(null)}
        />
      )}

      {mode.kind === "lobby" && tab === "1p" && (
        <>
          <h1 className="slogan">
            <span>Locate.</span> <span>Challenge.</span> <span>Win.</span>
          </h1>
          <div className="cols tour">
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
          <div className="page-head">
            <h1>Player Hub</h1>
            {refreshButton}
          </div>
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
                onCollect={(picked) => void run(picked.length > 1 ? "Taking them" : "Taking it", false, () => collect(client, wallet, picked), { kind: "lobby" })}
              />
              <p>{geocoinButton}</p>
            </>
          ) : null}
          <History
            items={me && notesRead ? pastGames(notes, me, height, nameOf) : null}
            connect={
              !wallet.connected && (
                <section className="panel">
                  <p>Connect to see your games.</p>
                  <button className="btn primary" onClick={connect} disabled={wallet.connecting}>
                    {wallet.connecting ? (LOCAL_WALLET && local.status) || "…" : "Connect wallet"}
                  </button>
                  {!LOCAL_WALLET && wallet.wallet?.readyState !== "Installed" && <p className="muted">You need the Bread wallet first.</p>}
                </section>
              )
            }
          />
        </>
      )}

      {mode.kind === "lobby" && tab === "boards" && <Leaderboards data={notesRead ? boards(publicNotes, height, me) : null} me={me} name={nameOf} action={refreshButton} />}

      {mode.kind === "play-champion" && <Play cities={mode.cities} places={places} onDone={(result) => setMode({ kind: "post-record", seed: mode.seed, cities: mode.cities, result })} />}

      {mode.kind === "post-record" && (
        <div className="cols wide-aside">
          <section className="panel">
            <div className="panel-title">Run complete!</div>
            <div className="big-score">{mode.result.score.toLocaleString()} pts</div>
            <Report rows={reportRows(mode.cities, mode.result.answers, places)} />
          </section>
          <aside className="panel yellow">
            <div className="panel-title">Post your record?</div>
            <p className="terms">
              Rivals must pay 1 Geocoin to try to beat you.
              <br />
              If they do, they take your Geocoin :(
              <br />
              Otherwise, their Geocoin is yours!!!
            </p>
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
          cities={decodeGame(mode.shots[0].storage.game).cities}
          places={places}
          rival={{ blocksLeft: shotDeadline(mode.shots[0].storage) - height }}
          onDone={settleAfterPlay(mode.shots, mode.record)}
        />
      )}

      {mode.kind === "busy" && (
        <Waiting
          text={mode.text}
          stage={mode.stage}
          since={mode.since}
          local={LOCAL_WALLET}
          onBack={() => {
            runToken.current++;
            setMode(mode.back);
          }}
        />
      )}

      {mode.kind === "done" && (
        <section className="panel yellow">
          {mode.title && <h2>{mode.title}</h2>}
          <p>{mode.text}</p>
          {mode.rows && <Report rows={mode.rows} />}
          {mode.share && <ShareButtons recordId={mode.share.recordId} score={mode.share.score} />}
          {mode.retry &&
            (mode.claimUntil ? (
              <ClaimButton until={mode.claimUntil} label={mode.retryLabel ?? "Try again"} onClaim={mode.retry} />
            ) : (
              <button className="btn primary" onClick={mode.retry}>
                {mode.retryLabel ?? "Try again"}
              </button>
            ))}
          <button
            className={mode.retry ? "btn" : "btn primary"}
            onClick={() => {
              if (mode.claimed) {
                // the record is won: nothing left to do with it
                setSharedRecord(null);
                setCode("");
                history.replaceState(null, "", withoutRecord(location.href));
              }
              // a round is over: back to the splash screen
              if (mode.rows || mode.share) goHome();
              else setMode({ kind: "lobby" });
            }}
          >
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
