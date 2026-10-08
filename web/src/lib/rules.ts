// GeoQuiz scoring, rules version 1. Mirrors integration/src/rules.rs and masm/games/gq_score.masm;
// all three are checked against rules/vectors.json.

export const RULES_VERSION = 1;
export const ROUNDS = 4;
export const LON_WRAP = 36000;
export const TIME_CAP = 1500; // 10 ms units = 15 s
export const ROUND_MAX = 1300;
export const QUIZ_MAX = ROUND_MAX * ROUNDS;

const DISTANCE_BANDS: [number, number][] = [
  [100 * 100, 1000],
  [300 * 300, 700],
  [800 * 800, 400],
  [2000 * 2000, 150],
];
const SPEED_BANDS: [number, number][] = [
  [300, 300],
  [600, 200],
  [1000, 100],
];

/** A city as stored in the note: dataset index plus its truth in centi-degrees. */
export type City = { idx: number; lat: number; lon: number; cos: number };
/** One answered round: click in centi-degrees, time in 10 ms units. */
export type Answer = { lat: number; lon: number; t: number };

/** Degrees → shifted centi-degrees used everywhere on chain. */
export const latToCd = (lat: number) => Math.round((lat + 90) * 100);
export const lonToCd = (lon: number) => (Math.round((lon + 180) * 100) + LON_WRAP) % LON_WRAP;
export const cosX100 = (lat: number) => Math.round(Math.cos((lat * Math.PI) / 180) * 100);

export function roundScore(city: City, a: Answer): number {
  const dlat = Math.abs(city.lat - a.lat);
  const raw = Math.abs(city.lon - a.lon);
  const dlon = Math.floor((Math.min(raw, LON_WRAP - raw) * city.cos) / 100);
  const d2 = dlat * dlat + dlon * dlon;
  const dist = DISTANCE_BANDS.find(([max]) => d2 <= max)?.[1] ?? 0;
  if (dist === 0) return 0;
  const speed = SPEED_BANDS.find(([max]) => a.t <= max)?.[1] ?? 0;
  return dist + speed;
}

export function quizScore(cities: City[], answers: Answer[]): number {
  return cities.reduce((sum, c, i) => sum + roundScore(c, answers[i]), 0);
}

/** `felt = lat << 32 | (lon * 2048 + t)`; one field element per round. */
export function packRound(a: Answer): bigint {
  if (a.lat > 18000 || a.lon >= LON_WRAP || a.t >= 2048) throw new Error("answer out of range");
  return (BigInt(a.lat) << 32n) | BigInt(a.lon * 2048 + a.t);
}

export function unpackRound(v: bigint): Answer {
  const lo = Number(v & 0xffffffffn);
  return { lat: Number(v >> 32n), lon: Math.floor(lo / 2048), t: lo % 2048 };
}

/** The note argument: four packed rounds, in round order. */
export function packAnswers(answers: Answer[]): bigint[] {
  if (answers.length !== ROUNDS) throw new Error(`expected ${ROUNDS} answers`);
  return answers.map(packRound);
}
