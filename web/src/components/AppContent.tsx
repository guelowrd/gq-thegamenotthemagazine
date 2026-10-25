// GeoQuizz screens: welcome → 1P World Tour (play, then put a Gamecoin on it) / VS (a record by
// link, code or from the open list, take a shot) / Player Hub (my records, my shots, what rivals left me).
// The app's own Miden client only reads the chain (and mints Gamecoins); the wallet signs the rest.

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { useMidenClient, useMiden } from "@miden-sdk/react";
import { useMidenFiWallet } from "@miden-sdk/miden-wallet-adapter-react";
import { LOCAL_WALLET, useLocalWallet } from "@/lib/localWallet";
import { openSales, pickSale, type Sale } from "@/lib/shop";
import { useSound, type Track } from "@/lib/useSound";
import { RECORD_LIFETIME_BLOCKS, STAKE, TEST_ACCOUNTS, ADMIN, GC_DECIMALS, GC_PRICE, MAX_BUY_GC } from "@/config";
import { accountFelts, bech32Of, fetchChallengeNote, hexOf, knownNote, listChallengeNotes, loadScripts, parseAccountId, syncNotes, wordFromHex, type ChallengeNote } from "@/lib/chain";
import { boards, history as pastGames, keyOf, lettersBackward, nicknames, owed, playersInOrder, stageTag } from "@/lib/hub";
import { postShot, postRecord, settle, collect, setSubmitAttemptListener, setSubmitStageListener, waitFor, type Submitted, openSale, buyGamecoin, gcBalance } from "@/lib/bread";
import { shotDeadline, shotStorage, ZERO_WORD, type AccountFelts, type ChallengeStorage } from "@/lib/notes";
import { blockToMs, breadLink, claimVerdict, explain, fmtGamecoin, NOT_FINISHED, sameAccount, SHOT_LOST, shotRefusal, withoutRecord, withTimeout, type Trouble, myOpenShotsOn as openShotsOn, outcomeText, parseCode, reportRows, settlePlan, sharedRecordState, type ReportRow } from "@/lib/flow";
import { cityNames, datasetWord, decodeGame, encodeGame, gameStage, quizCities, randomSeed, type Place, type Word4 } from "@/lib/quiz";
import { registerDataset, STAGES, stageById, WORLD, type Stage as GameStage, type StageId } from "@/lib/stages";
import { LANGS, LangContext, PIXEL12, storedLang, storeLang, useLang, useT, type Lang } from "@/lib/i18n";
import { gqAnswer, type City } from "@/lib/rules";
import { History } from "./History";
import { Leaderboards } from "./Leaderboards";
import { Lobby } from "./Lobby";
import { ShareButtons } from "./ShareButtons";
import { Play, type PlayResult } from "./Play";
import { Shell } from "./Shell";
import { ClaimButton, EndsIn, ErrorBox, Waiting, type Stage } from "./Status";
import { type Tab } from "@/lib/tabs";
import { StageTiles } from "./StageTiles";
import { Welcome } from "./Welcome";
import { WorldMap } from "./WorldMap";

type Mode =
  | { kind: "lobby" }
  | { kind: "play-champion"; seed: Word4; cities: City[]; stage: GameStage }
  | { kind: "post-record"; seed: Word4; cities: City[]; result: PlayResult; stage: GameStage }
  | { kind: "play-rival"; shots: ChallengeNote[]; record?: ChallengeNote }
  /** `back`: where the Back button, a failure or a wallet that never finishes returns to */
  /** `track`: the music of the screen it came from, which keeps playing while it waits */
  | { kind: "busy"; text: string; back: Mode; stage: Stage; since: number; track: Track }
  /** `claimed`: the record is won, OK leaves it behind; after a round (`rows` or `share`) OK goes back to the splash screen */
  | { kind: "done"; title?: string; text: string; rows?: ReportRow[]; txId?: string; share?: ComponentProps<typeof ShareButtons>; retry?: () => void; retryLabel?: string; claimed?: boolean;
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
/** `?admin=1`: the sale desk, for the admin account alone. */
const ADMIN_PANEL = new URLSearchParams(window.location.search).has("admin");

type Intent = { kind: "post"; m: Extract<Mode, { kind: "post-record" }> } | { kind: "shot"; record: ChallengeNote } | { kind: "buy"; gc: bigint } | { kind: "sell"; gc: bigint };

export function AppContent({ onStarted }: { onStarted?: () => void }) {
  // the language: the device remembers it; the splash and the ribbon change it
  const [lang, setLangState] = useState<Lang>(storedLang);
  const setLang = (l: Lang) => {
    storeLang(l);
    setLangState(l);
  };
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.classList.toggle("pixel12", PIXEL12.test(lang));
  }, [lang]);
  return (
    <LangContext.Provider value={{ lang, setLang }}>
      <Gate onStarted={onStarted} />
    </LangContext.Provider>
  );
}

function Gate({ onStarted }: { onStarted?: () => void }) {
  const t = useT();
  // `useMidenClient()` throws until the provider has created the client, so gate on readiness first.
  const { isReady, error } = useMiden();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 20_000);
    return () => clearTimeout(timer);
  }, []);
  if (!isReady) {
    return (
      <main>
        {error ? (
          <ErrorBox trouble={{ ...explain(error), title: "The game could not start." }} onRetry={() => location.reload()} onClose={() => location.reload()} />
        ) : (
          <>
            <p className="muted">{t("Loading…")}</p>
            {slow && (
              <p className="muted">
                {t("This is taking long. Check your connection, or")}{" "}
                <button className="btn" onClick={() => location.reload()}>
                  {t("Reload")}
                </button>
              </p>
            )}
          </>
        )}
      </main>
    );
  }
  return <GqApp onStarted={onStarted} />;
}

function GqApp({ onStarted }: { onStarted?: () => void }) {
  const t = useT();
  const { lang } = useLang();
  const client = useMidenClient();
  const { runExclusive } = useMiden();
  const bread = useMidenFiWallet();
  const local = useLocalWallet(client, runExclusive);
  const wallet = LOCAL_WALLET ? local : bread;

  const params = new URLSearchParams(location.search);
  const sharedRecordId = params.get("record");

  const [started, setStarted] = useState(!!sharedRecordId);
  useEffect(() => {
    if (started) onStarted?.();
  }, [started, onStarted]);
  const [tab, setTab] = useState<Tab>(sharedRecordId ? "vs" : "1p");
  // every stage's city list (the World Tour's is cities.json) with its dataset hash; all five load at the start
  const [datasets, setDatasets] = useState<Partial<Record<StageId, { places: Place[]; word: Word4 }>>>({});
  // the 1P stage on the table
  const [stageId, setStageId] = useState<StageId>("world");
  const stage = stageById(stageId);
  // the cities' names in the current language's family, keyed "City|Country", fetched when a language with its own names is on; the lists themselves stay as hashed
  const placesFile = LANGS.find((v) => v.lang === lang)?.places;
  const [placeNames, setPlaceNames] = useState<{ file: string; names: Record<string, [string, string]> } | null>(null);
  useEffect(() => {
    if (!placesFile || placeNames?.file === placesFile) return;
    fetch(`/places.${placesFile}.json`)
      .then((r) => r.json())
      .then((names: Record<string, [string, string]>) => setPlaceNames({ file: placesFile, names }))
      .catch((e) => console.warn("[gq] place names", e));
  }, [placesFile, placeNames]);
  /** A stage's city list as loaded: English names, the ones the post and the quiz check use. */
  const listOf = (s: GameStage | undefined): Place[] => (s && datasets[s.id]?.places) ?? [];
  /** A stage's cities as the player reads them: names in the current language once loaded. */
  const placesOf = (s: GameStage | undefined): Place[] => {
    const list = listOf(s);
    if (!placesFile || placeNames?.file !== placesFile) return list;
    return list.map((p) => {
      const n = placeNames.names[`${p.name}|${p.country}`];
      return n ? { ...p, name: n[0], country: n[1] } : p;
    });
  };
  const dataset = datasets[stageId]?.word ?? null;
  const places = placesOf(stage);
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
  /** The last Gamecoin grant, so a second press does not mint again before Bread takes the first. */
  const [buyGc, setBuyGc] = useState("10");
  // the wallet's Gamecoin: read once a session (Bread confirms each read), when a shop first comes on
  // screen or a post first needs it; it then follows the game's own transactions. null while unknown.
  const [held, setHeld] = useState<bigint | null>(null);
  const walletRef = useRef(wallet);
  useEffect(() => {
    walletRef.current = wallet;
  });
  /** One wallet read; which wallet it was for, so a shop visit never asks twice. */
  const readFor = useRef<string | null>(null);
  const readBalance = useCallback(async (key: string) => {
    readFor.current = key;
    const balance = await gcBalance(walletRef.current);
    setHeld(balance);
    return balance;
  }, []);
  const [sellGc, setSellGc] = useState("1000");

  const me = wallet.connected && wallet.address ? accountFelts(parseAccountId(wallet.address)) : null;
  const meKey = me && keyOf(me);
  const shopOnScreen = tab === "vs" || tab === "hub";
  useEffect(() => {
    setHeld(null);
  }, [meKey]);
  useEffect(() => {
    if (meKey && shopOnScreen && readFor.current !== meKey) readBalance(meKey).catch(() => setHeld(null));
  }, [meKey, shopOnScreen, readBalance]);
  /** Enough Gamecoin for `needed`? The number on hand answers yes on its own; short or unknown, one wallet read decides. */
  async function enoughGc(needed: bigint): Promise<boolean> {
    try {
      const balance = held !== null && held >= needed ? held : await readBalance(meKey!);
      if (balance >= needed) return true;
      setTrouble({ t: { kind: "funds", title: "Not enough Gamecoins in your wallet. Get Gamecoins first." } });
    } catch (e) {
      oops(e);
    }
    return false;
  }
  // the boards and the nickname order leave the development wallets' test rounds out
  const publicNotes = useMemo(() => {
    const test = (a: AccountFelts | null) => !!a && TEST_ACCOUNTS.includes(hexOf(a));
    return notes.filter((n) => !test(n.storage.champion) && !test(n.storage.rival));
  }, [notes]);
  // arcade names for everyone who played, in the order they first did; a newcomer comes last
  const names = useMemo(() => {
    const players = playersInOrder(publicNotes);
    if (me && !players.some((p) => keyOf(p) === meKey)) players.push(me);
    return nicknames(players.map((p) => ({ key: keyOf(p), address: bech32Of(p) })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicNotes, meKey]);
  const nameOf = (a: AccountFelts) => names.get(keyOf(a)) ?? lettersBackward(bech32Of(a)).slice(0, 3);
  /** The records I posted, on any map: how many and the best unlock the 1P stages. A shot at anyone's record needs none. */
  const myRecords = notes.filter((n) => n.kind === "record" && sameAccount(n.storage.champion, me));
  const myBest = Math.max(0, ...myRecords.map((n) => n.storage.target));
  const unlocked = (s: GameStage) => s.threshold <= myBest && s.records <= myRecords.length;
  /** The tiles appear once they can tell locked from open: the notes read and the wallet back. */
  const stagesKnown = notesRead && (!!me || !wallet.connecting);

  /** A failure in plain words, with a way to try again when there is one. */
  const oops = (e: unknown, retry?: () => void) => setTrouble({ t: explain(e), retry });
  /** A message that is already in plain words. */
  const say = (title: string) => setTrouble({ t: { kind: "unknown", title } });
  const reload = () => location.reload();

  /** A record opened by link or code; a slow network gets "Try again". */
  const loadRecord = (id: string) =>
    withTimeout(fetchChallengeNote(id), 30_000, "Loading the record")
      .then((r) => {
        // a slower answer for a record picked before the current one stays out
        setSharedRecord((cur) => (cur && cur.id !== r.id ? cur : r));
        setTrouble(null);
      })
      .catch((e) => oops(e, () => void loadRecord(id)));

  useEffect(() => {
    for (const s of STAGES)
      withTimeout(fetch(s.cities), 30_000, "Loading the cities")
        .then(async (r) => {
          if (!r.ok) throw new Error(`Loading the cities: HTTP ${r.status}`);
          const bytes = new Uint8Array(await r.arrayBuffer());
          const word = await datasetWord(bytes);
          registerDataset(s, word);
          setDatasets((d) => ({ ...d, [s.id]: { places: JSON.parse(new TextDecoder().decode(bytes)), word } }));
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
    [client, runExclusive],
  );

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(!notesReadRef.current), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const connect = (): void => void wallet.connect().catch((e) => oops(e, connect));
  const connected = !!me;

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
    if (intent.kind === "sell") return sell(intent.gc);
    return buy(intent.gc);
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
  async function run<S extends Submitted>(text: string, posted: boolean, fn: () => Promise<S>, back: Mode, onConfirmed?: (s: S) => Mode | void, previous?: S) {
    const token = ++runToken.current;
    const live = () => runToken.current === token;
    const update = (patch: Partial<Extract<Mode, { kind: "busy" }>>) => setMode((m) => (live() && m.kind === "busy" ? { ...m, ...patch } : m));
    const again = (attempt?: S) => () => void run(text, posted, fn, back, onConfirmed, attempt);
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
    const finish = (s: S) => {
      void refresh();
      setHeld((h) => (h === null ? null : h + s.gc));
      setMode(onConfirmed?.(s) ?? { kind: "done", text: outcomeText(text, true, t), txId: s.txId });
    };
    setTrouble(null);
    // waiting keeps the song of the screen it came from; after a quiz, the song of what comes next
    const track = mode.kind === "play-champion" || mode.kind === "play-rival" ? trackOf(back) : trackOf(mode);
    setMode({ kind: "busy", text, back, stage: previous ? "network" : "prepare", since: Date.now(), track });
    setSubmitAttemptListener((attempt) => update({ text: attempt > 1 ? t("{text} (try {n})", { text, n: attempt }) : text }));
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
    if (!dataset) return say(t("Still loading the cities, try again in a second."));
    setTrouble(null);
    const seed = randomSeed();
    quizCities(seed, places, stage)
      .then((cities) => setMode({ kind: "play-champion", seed, cities, stage }))
      .catch((e) => oops(e, startChampion));
  }

  async function postMyRecord(m: Extract<Mode, { kind: "post-record" }>) {
    const dataset = datasets[m.stage.id]?.word;
    if (!dataset) return;
    const champion = accountFelts(parseAccountId(wallet.address!));
    if (!(await enoughGc(STAKE))) return;
    await run(
      t("Posting your record"),
      true,
      () => {
        const storage: ChallengeStorage = {
          expiryBlock: height + RECORD_LIFETIME_BLOCKS,
          target: m.result.score,
          minStake: STAKE,
          champion,
          rival: null,
          recordId: ZERO_WORD,
          shotRoot: ZERO_WORD, // filled from the loaded script
          game: encodeGame({ seed: m.seed, dataset, cities: m.cities }),
          shotDeadline: 0,
        };
        return postRecord(client, wallet, storage, STAKE);
      },
      m,
      ({ txId, noteIds }) => ({ kind: "done", title: t("Record posted!"), text: t("Now find someone to beat you."), txId, share: { recordId: noteIds[0], score: m.result.score, expiresAt: blockToMs(height + RECORD_LIFETIME_BLOCKS, height), cities: cityNames(m.cities, listOf(m.stage)), stage: m.stage } }),
    );
  }

  const myOpenShotsOn = (record: ChallengeNote) => openShotsOn(notes, me, record, height);

  /** Posts the shot note and, once it is on chain, starts the quiz right away. */
  async function takeShot(record: ChallengeNote) {
    const rival = accountFelts(parseAccountId(wallet.address!));
    const refusal = shotRefusal(record, height, rival);
    if (refusal) return say(refusal);
    const recordStage = gameStage(record.storage.game);
    if (!recordStage) return say(t("This record uses another city list. It can't be played here."));
    const open = openShotsOn(notes, rival, record, height);
    if (open.length > 0) {
      // one Gamecoin per sitting: play the shot already on the table instead of paying again
      setMode({ kind: "play-rival", shots: open, record });
      return;
    }
    if (!(await enoughGc(record.storage.minStake))) return;
    await run(
      t("Inserting your Gamecoin"),
      true,
      async () => {
        // refuse a quiz that does not come from the seed and this dataset
        const game = decodeGame(record.storage.game);
        const expected = await quizCities(game.seed, listOf(recordStage), recordStage);
        if (!expected.every((c, i) => JSON.stringify(c) === JSON.stringify(game.cities[i]))) throw new Error("This record's quiz does not match the dataset.");
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
            storage: shotStorage(record.storage, rival, record.idWord, submitted.deadline),
            faucet: record.faucet,
            amount: record.storage.minStake,
            consumed: false,
          },
        ],
      }),
    );
  }

  const settleAfterPlay = (shots: ChallengeNote[], record: ChallengeNote | undefined) => (r: PlayResult) => {
    const plan = settlePlan(shots, record, r.score, height, t);
    const rows = reportRows(decodeGame(shots[0].storage.game).cities, r.answers, placesOf(gameStage(shots[0].storage.game)));
    const claimUntil = blockToMs(shotDeadline(shots[0].storage), height);
    if (!plan.won) {
      // nothing to sign on a loss: the Gamecoin waits for the champion at the deadline; until then the shot can be played again
      const retry = plan.again ? () => setMode({ kind: "play-rival", shots, record }) : undefined;
      setMode({ kind: "done", title: t("The record stands."), text: plan.text, rows, retry, claimUntil });
      return;
    }
    const claim = (): void =>
      void run(
        plan.text,
        false,
        async () => {
          // ask the chain first: a claim that already landed (or a shot already taken) needs no wallet
          const now = await Promise.all(shots.map((s) => withTimeout(fetchChallengeNote(s.id), 30_000, "Checking your shot")));
          const verdict = claimVerdict(now.map((s) => ({ consumedAt: s.consumedAt, deadline: shotDeadline(s.storage) })));
          if (verdict === "claimed") return { txId: "", noteIds: shots.map((s) => s.id), gc: [...(plan.claimPrize && record ? [record] : []), ...shots].reduce((sum, n) => sum + n.amount, 0n) };
          if (verdict === "lost") throw new Error(SHOT_LOST);
          return settle(client, wallet, shots, plan.claimPrize ? record : undefined, gqAnswer(r.answers));
        },
        // the win stands on failure: the report stays and the claim can be sent again until the shot ends
        { kind: "done", title: t("Record smashed!"), text: plan.text, rows, retry: claim, retryLabel: plan.claimPrize ? t("Claim my prize") : t("Get my Gamecoin back"), claimUntil },
        () => {
          // the prize is ours: the record card must not offer it again
          if (plan.claimPrize && record) setSharedRecord((r) => (r && r.id === record.id ? { ...r, consumed: true } : r));
          return { kind: "done", title: t("Record smashed!"), text: outcomeText(plan.text, true, t), rows, claimed: true };
        },
      );
    claim();
  };

  /** Buys `gc` Gamecoin from the cheapest sale note at or under the price; the coins land in the wallet with the fill. */
  async function buy(gc: bigint) {
    const token = ++runToken.current;
    setTrouble(null);
    setMode({ kind: "busy", text: t("Buying Gamecoin"), back: { kind: "lobby" }, stage: "network", since: Date.now(), track: trackOf(mode) });
    let sale: Sale | undefined;
    try {
      sale = pickSale(await openSales((await client.feeFaucetId()).toString()), gc, me ? hexOf(me) : undefined);
    } catch (e) {
      if (runToken.current !== token) return;
      oops(e, () => withWallet({ kind: "buy", gc }));
      return setMode({ kind: "lobby" });
    }
    if (runToken.current !== token) return;
    if (!sale) {
      setMode({ kind: "lobby" });
      return say(t("No Gamecoin on sale right now. Try again later."));
    }
    const picked = sale;
    void run(t("Buying Gamecoin"), false, () => buyGamecoin(client, wallet, picked, gc), { kind: "lobby" }, () => ({ kind: "done", text: t("{gc} in your wallet.", { gc: fmtGamecoin(gc, t) }) }));
  }

  /** Admin: puts `gc` Gamecoin on sale at the price. */
  const sell = (gc: bigint) =>
    run("Putting Gamecoin on sale", true, async () => openSale(client, wallet, gc, GC_PRICE, (await client.feeFaucetId()).toString()), { kind: "lobby" }, () => ({ kind: "done", text: `${fmtGamecoin(gc, t)} on sale.` }));

  /** A pasted link or id opens the record exactly like the link would. */
  const openCode = () => {
    const parsed = parseCode(code);
    if ("hint" in parsed) return say(parsed.hint);
    setTrouble(null);
    void loadRecord(parsed.id);
  };

  const refreshButton = (
    <button className="btn" onClick={() => void refresh()} disabled={refreshing}>
      {refreshing ? t("Refreshing…") : t("Refresh")}
    </button>
  );
  const gc = BigInt(Math.min(MAX_BUY_GC, Math.max(1, Math.floor(Number(buyGc) || 1)))) * 10n ** BigInt(GC_DECIMALS);
  const shopBox = (
    <section className="panel shop">
      <div className="panel-title">{t("Buy Gamecoins")}</div>
      <p className="muted">
        {held !== null && (
          <>
            {t("You have {gc}.", { gc: fmtGamecoin(held, t) })}
            <br />
          </>
        )}
        {t("0.001 USDCx each, 100 max at a time.")}
      </p>
      <input type="number" min={1} max={MAX_BUY_GC} value={buyGc} onChange={(e) => setBuyGc(e.target.value)} aria-label={t("How many")} />
      <button className="btn" onClick={() => withWallet({ kind: "buy", gc })}>
        {t("Buy")}
      </button>
    </section>
  );
  // the admin's sale desk: plain English, one reader
  const adminBox = ADMIN_PANEL && me && hexOf(me) === parseAccountId(ADMIN).toString() && (
    <section className="panel shop">
      <div className="panel-title">Put Gamecoin on sale</div>
      <p className="muted">{t("0.001 USDCx each, 100 max at a time.").split(",")[0]}, from this wallet.</p>
      <input type="number" min={1} value={sellGc} onChange={(e) => setSellGc(e.target.value)} aria-label="How many to sell" />
      <button className="btn" onClick={() => withWallet({ kind: "sell", gc: BigInt(Math.max(1, Math.floor(Number(sellGc) || 1))) * 10n ** BigInt(GC_DECIMALS) })}>
        Put on sale
      </button>
    </section>
  );
  const codeBox = (
    <section className="panel">
      <div className="panel-title">{t("Have a code?")}</div>
      <p className="muted">{t("Paste a record link or code.")}</p>
      <input value={code} onChange={(e) => setCode(e.target.value)} placeholder={t("paste the link or code")} aria-label={t("Record link or code")} />
      <button className="btn" onClick={openCode}>
        {t("Go")}
      </button>
    </section>
  );

  // funded records a rival can still take a shot at, easiest first
  const openRecords = publicNotes
    .filter((n) => n.kind === "record" && n.amount > 0n && !shotRefusal(n, height))
    .sort((a, b) => a.storage.target - b.storage.target);
  const cardRef = useRef<HTMLElement>(null);
  /** Opens a listed record like its link would, fresh from the node: the list may be a while old. */
  const viewChallenge = (n: ChallengeNote) => {
    flushSync(() => setSharedRecord(n));
    cardRef.current?.focus(); // the card opens above the list: bring it into view
    void loadRecord(n.id);
  };
  const openList = (
    <section className="panel open-challenges">
      <div className="panel-title">
        {t("Open challenges")}
        {refreshButton}
      </div>
      {!notesRead ? (
        <p className="muted">{t("Loading…")}</p>
      ) : openRecords.length === 0 ? (
        <p className="muted">{t("No open challenges yet.")}</p>
      ) : (
        openRecords.map((n) => {
          const map = stageTag(n.storage.game);
          return (
            <div key={n.id} className="row">
              <div>
                <div className="value">{t("{n} pts", { n: n.storage.target.toLocaleString() })}</div>
                {map && <div className="small tag">{t(map)}</div>}
                <div className="small muted">
                  <EndsIn until={blockToMs(n.storage.expiryBlock, height)} />
                </div>
              </div>
              <button className="btn" onClick={() => viewChallenge(n)} aria-label={`${t("View challenge, {n} pts", { n: n.storage.target.toLocaleString() })}${map ? `, ${t(map)}` : ""}`}>
                {t("View challenge")}
              </button>
            </div>
          );
        })
      )}
    </section>
  );

  // the record as loaded from its link, updated by what the background sync has seen since
  const record = sharedRecord && { ...sharedRecord, consumed: sharedRecord.consumed || notes.some((n) => n.consumed && n.id.toLowerCase() === sharedRecord.id.toLowerCase()) };

  const recordCard = () => {
    if (!record) return null;
    const state = sharedRecordState(record, me, me ? myOpenShotsOn(record) : [], height);
    const recordStage = gameStage(record.storage.game);
    if (state === "claimed" || state === "expired") {
      return (
        <section className="panel pink" ref={cardRef} tabIndex={-1}>
          <div className="panel-title">{t("Record")}</div>
          <h2>{t("This one is over.")}</h2>
        </section>
      );
    }
    return (
      <section className="panel pink" ref={cardRef} tabIndex={-1}>
        <div className="panel-title">{t("Record")}</div>
        <div className="big-score">{t("{n} pts to beat", { n: record.storage.target.toLocaleString() })}</div>
        {recordStage && recordStage.id !== "world" && (
          <div className="row">
            <span>{t("Map")}</span>
            <span className="value">{t(recordStage.name)}</span>
          </div>
        )}
        <div className="row">
          <span>{t("Prize")}</span>
          <span className="value">{fmtGamecoin(record.amount, t)}</span>
        </div>
        <div className="row">
          <span>{t("One shot")}</span>
          <span className="value">{fmtGamecoin(record.storage.minStake, t)}</span>
        </div>
        {state === "mine" && <p className="muted">{t("This is yours.")}</p>}
        {(state === "open" || state === "already-challenged") && (
          <button className="btn primary wide" onClick={() => withWallet({ kind: "shot", record })}>
            {state === "open" ? t("Insert Gamecoin") : t("Play")}
          </button>
        )}
        <p className="muted terms" style={{ margin: "14px 0 0" }}>
          {t("Win and get your Gamecoin back plus the prize :)")}
          <br />
          {t("Lose and your Gamecoin goes to the champion :(")}
        </p>
      </section>
    );
  };

  const openTab = (next: Tab) => {
    setTab(next);
    setTrouble(null);
    setMode({ kind: "lobby" });
  };

  const goHome = () => {
    runToken.current++;
    setTrouble(null);
    setMode({ kind: "lobby" });
    setTab("1p");
    setStarted(false);
  };

  const walletLabel = me ? `${LOCAL_WALLET ? t("Test wallet") : t("Wallet")} / ${nameOf(me)}` : null;
  const openInBread = !LOCAL_WALLET && wallet.wallet?.readyState !== "Installed" ? breadLink(location.href) : undefined;
  const title1p = stage.id === "world" ? t("1P World Tour") : t("1P {stage}", { stage: t(stage.name) });

  if (!started) return <Welcome onStart={() => setStarted(true)} />;

  return (
    <Shell
      tab={tab}
      title1p={title1p}
      onTab={openTab}
      onHome={goHome}
      walletLabel={walletLabel}
      netSlow={netSlow}
      hubAlert={owed(notes, height, me).length > 0}
      onWallet={() => (wallet.connected ? void wallet.disconnect() : connect())}
      openInBread={openInBread}
      soundOn={sound.on}
      onSound={sound.toggle}
    >
      {trouble && (
        <ErrorBox
          trouble={trouble.t}
          openInBread={openInBread}
          onRetry={
            trouble.retry &&
            (() => {
              const retry = trouble.retry!;
              setTrouble(null);
              retry();
            })
          }
          onGamecoins={() => {
            setTrouble(null);
            withWallet({ kind: "buy", gc });
          }}
          onClose={() => setTrouble(null)}
        />
      )}

      {mode.kind === "lobby" && tab === "1p" && (
        <>
          <h1 className="slogan">
            <span>{t("Locate.")}</span> <span>{t("Challenge.")}</span> <span>{t("Win.")}</span>
          </h1>
          <div className="cols tour">
            <div className="panel map-frame">
              <WorldMap stage={stage} />
              {stagesKnown ? (
                <StageTiles shown={stage} unlocked={unlocked} onPick={setStageId} />
              ) : (
                <div className="stages-loading" role="status">
                  {t("Loading bonus maps")}
                </div>
              )}
            </div>
            <div>
              <aside className="panel">
                <div className="panel-title">{title1p}</div>
                <p>{t("10 cities, 15 seconds each.")}</p>
                <p className="muted">{t("Free to play. Once you're happy with your score, post it on X to challenge your rivals.")}</p>
                <button className="btn primary wide" onClick={startChampion} disabled={!dataset}>
                  {t("Locate first city")}
                </button>
              </aside>
              <button className="text-link" onClick={() => openTab("vs")}>
                {t("Find a challenge in CHAMPION VS RIVAL mode →")}
              </button>
            </div>
          </div>
        </>
      )}

      {mode.kind === "lobby" && tab === "vs" && (
        <div className="arena">
          <img className="hero" src="/brand/hero-arena.webp" alt="" width={1440} height={960} />
          <div className="overlay">
            <div className="stack">
              {recordCard() ?? codeBox}
              {shopBox}
              {adminBox}
            </div>
            <div className="beside">{openList}</div>
          </div>
        </div>
      )}

      {mode.kind === "lobby" && tab === "hub" && (
        <>
          <div className="page-head">
            <h1>{t("Player Hub")}</h1>
            {refreshButton}
          </div>
          {wallet.connected ? (
            <>
              <Lobby
                me={me}
                notes={notes}
                height={height}
                places={(game) => listOf(gameStage(game))}
                onSettle={(shot, record) => {
                  const open = record && me ? myOpenShotsOn(record) : [];
                  setMode({ kind: "play-rival", shots: open.length > 0 ? open : [shot], record });
                }}
                onCollect={(picked) => void run(picked.length > 1 ? t("Taking them") : t("Taking it"), false, () => collect(client, wallet, picked), { kind: "lobby" })}
              />
              {shopBox}
            </>
          ) : null}
          <History
            key={meKey ?? ""}
            items={me && notesRead ? pastGames(notes, me, height, nameOf, t) : null}
            connect={
              !wallet.connected && (
                <section className="panel">
                  <p>{t("Connect to see your games.")}</p>
                  <button className="btn primary" onClick={connect} disabled={wallet.connecting}>
                    {wallet.connecting ? (LOCAL_WALLET && local.status) || "…" : t("Connect wallet")}
                  </button>
                  {openInBread && <p className="muted">{t("You need the Bread wallet first.")}</p>}
                </section>
              )
            }
          />
        </>
      )}

      {mode.kind === "lobby" && tab === "boards" && <Leaderboards data={notesRead ? boards(publicNotes, height, me) : null} me={me} name={nameOf} action={refreshButton} />}

      {mode.kind === "play-champion" && (
        <Play stage={mode.stage} cities={mode.cities} places={placesOf(mode.stage)} onDone={(result) => setMode({ kind: "post-record", seed: mode.seed, cities: mode.cities, result, stage: mode.stage })} />
      )}

      {mode.kind === "post-record" && (
        <div className="cols wide-aside">
          <section className="panel">
            <div className="panel-title">{t("Run complete!")}</div>
            <div className="big-score">{t("{n} pts", { n: mode.result.score.toLocaleString() })}</div>
            <Report rows={reportRows(mode.cities, mode.result.answers, placesOf(mode.stage))} />
          </section>
          <aside className="panel yellow">
            <div className="panel-title">{t("Post your record?")}</div>
            <p className="terms">
              {t("Rivals must pay 1 Gamecoin to try to beat you.")}
              <br />
              {t("If they do, they take your Gamecoin :(")}
              <br />
              {t("Otherwise, their Gamecoin is yours!!!")}
            </p>
            <button className="btn primary wide" onClick={() => withWallet({ kind: "post", m: mode })}>
              {t("Post it")}
            </button>
            <button className="btn wide" onClick={() => setMode({ kind: "lobby" })}>
              {t("Not now")}
            </button>
          </aside>
        </div>
      )}

      {mode.kind === "play-rival" && (
        <Play
          stage={gameStage(mode.shots[0].storage.game) ?? WORLD}
          cities={decodeGame(mode.shots[0].storage.game).cities}
          places={placesOf(gameStage(mode.shots[0].storage.game))}
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
          {mode.share && <ShareButtons {...mode.share} />}
          {mode.retry &&
            (mode.claimUntil ? (
              <ClaimButton until={mode.claimUntil} label={mode.retryLabel ?? t("Try again")} onClaim={mode.retry} />
            ) : (
              <button className="btn primary" onClick={mode.retry}>
                {mode.retryLabel ?? t("Try again")}
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
            {t("OK")}
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
