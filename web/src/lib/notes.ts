// The challenge mechanic's note storage, host side (masm/challenge/challenge_core.masm); mirrors
// integration/src/storage.rs. A record note and its shot notes share one layout: a 16-felt header
// the core owns, then the game's own data in whole words, opaque here. All felts are bigint.

/** Four field elements. */
export type Word4 = [bigint, bigint, bigint, bigint];

/** This app's note tag ("GQ"): clients sync it and filter by script root. An app picks its own. */
export const NOTE_TAG = 0x47510001;
export const HEADER_ITEMS = 16;
export const SHOT_DEADLINE_INDEX = 7;

/** An account id as the two felts the scripts compare: [suffix, prefix]. */
export type AccountFelts = { suffix: bigint; prefix: bigint };

export type ChallengeStorage = {
  expiryBlock: number;
  target: number;
  minStake: bigint;
  champion: AccountFelts;
  /** zero in a record note */
  rival: AccountFelts | null;
  /** zero in a record note */
  recordId: Word4;
  shotRoot: Word4;
  /** the game's data, whole words (GeoQuizz: quiz.ts encodeGame) */
  game: bigint[];
  /** block by which the rival must settle; 0 in a record note. Settleable before min(this, expiryBlock). */
  shotDeadline: number;
};

/**
 * What a claim hands the game: the note argument (one word) and the advice-map entries the game
 * reads (GeoQuizz: rules.ts gqAnswer, the commitment to ten answers and the answers under it).
 */
export type GameAnswer = { arg: Word4; advice: [Word4, bigint[]][] };

export const ZERO_WORD: Word4 = [0n, 0n, 0n, 0n];

export function encodeStorage(s: ChallengeStorage): bigint[] {
  if (s.game.length % 4 !== 0) throw new Error("game data must be whole words");
  const rival = s.rival ?? { suffix: 0n, prefix: 0n };
  return [
    s.champion.suffix,
    s.champion.prefix,
    BigInt(s.target),
    s.minStake,
    BigInt(s.expiryBlock),
    rival.suffix,
    rival.prefix,
    BigInt(s.shotDeadline),
    ...s.recordId,
    ...s.shotRoot,
    ...s.game,
  ];
}

export function decodeStorage(felts: bigint[]): ChallengeStorage {
  if (felts.length < HEADER_ITEMS || felts.length % 4 !== 0) throw new Error(`not a challenge note storage (${felts.length} felts)`);
  const word = (at: number): Word4 => [felts[at], felts[at + 1], felts[at + 2], felts[at + 3]];
  const rival = { suffix: felts[5], prefix: felts[6] };
  return {
    champion: { suffix: felts[0], prefix: felts[1] },
    target: Number(felts[2]),
    minStake: felts[3],
    expiryBlock: Number(felts[4]),
    rival: rival.suffix === 0n && rival.prefix === 0n ? null : rival,
    recordId: word(8),
    shotRoot: word(12),
    game: felts.slice(HEADER_ITEMS),
    shotDeadline: Number(felts[SHOT_DEADLINE_INDEX]),
  };
}

/** The block a shot stops being settleable (and the champion may collect). */
export const shotDeadline = (s: ChallengeStorage) => Math.min(s.shotDeadline, s.expiryBlock);

/** The shot note's storage for `rival` at the record note `recordId`, settleable until `deadline`. */
export function shotStorage(record: ChallengeStorage, rival: AccountFelts, recordId: Word4, deadline: number): ChallengeStorage {
  return { ...record, rival, recordId, shotDeadline: deadline };
}

/** True when `shot` is a well-formed shot at `record` (same game data, same terms). */
export function isShotAt(shot: ChallengeStorage, record: ChallengeStorage, recordId: Word4): boolean {
  if (!shot.rival) return false;
  const expected = encodeStorage(shotStorage(record, shot.rival, recordId, shot.shotDeadline));
  const actual = encodeStorage(shot);
  return expected.length === actual.length && expected.every((f, i) => f === actual[i]);
}
