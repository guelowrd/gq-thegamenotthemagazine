// GeoQuizz scoring, rules version 2. Mirrors integration/src/rules.rs and masm/games/gq_score.masm;
// all three are checked against rules/vectors.json.
//
// A round scores accuracy + speed from a closeness `a` in per-mille that falls off as
// exp(-distance / 500 km): accuracy = 850 * a / 1000, speed = 150 * a * (1500 - t) / 1 500 000.
// The distance is the flat approximation sqrt(dlat² + (dlon * cos)²) in centi-degrees
// (1 cd ≈ 1.112 km); `a` comes from a table of 128 bands of 25 cd (≈ 27.8 km).

export const RULES_VERSION = 2;
export const ROUNDS = 10;
export const LON_WRAP = 36000;
export const TIME_CAP = 1500; // 10 ms units = 15 s
export const BAND_CD = 25;
export const ACCURACY_MAX = 850;
export const SPEED_MAX = 150;
export const ROUND_MAX = ACCURACY_MAX + SPEED_MAX;
export const QUIZ_MAX = ROUND_MAX * ROUNDS;

/** `round(1000 * exp(-i * 25 * 1.11195 / 500))` per band; verbatim from integration/src/rules.rs. */
// prettier-ignore
export const EXP_MILLI = [
  1000, 946, 895, 846, 801, 757, 716, 678, 641, 606, 574, 542, 513, 485, 459, 434,
  411, 389, 368, 348, 329, 311, 294, 278, 263, 249, 236, 223, 211, 199, 189, 178,
  169, 160, 151, 143, 135, 128, 121, 114, 108, 102, 97, 92, 87, 82, 77, 73,
  69, 66, 62, 59, 56, 53, 50, 47, 44, 42, 40, 38, 36, 34, 32, 30,
  28, 27, 25, 24, 23, 22, 20, 19, 18, 17, 16, 15, 15, 14, 13, 12,
  12, 11, 10, 10, 9, 9, 8, 8, 8, 7, 7, 6, 6, 6, 5, 5,
  5, 5, 4, 4, 4, 4, 3, 3, 3, 3, 3, 3, 2, 2, 2, 2,
  2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
];

/** A city as stored in the note: dataset index plus its truth in centi-degrees. */
export type City = { idx: number; lat: number; lon: number; cos: number };
/** One answered round: click in centi-degrees, time in 10 ms units. */
export type Answer = { lat: number; lon: number; t: number };

/** Degrees → shifted centi-degrees used everywhere on chain. */
export const latToCd = (lat: number) => Math.round((lat + 90) * 100);
export const lonToCd = (lon: number) => (Math.round((lon + 180) * 100) + LON_WRAP) % LON_WRAP;
export const cosX100 = (lat: number) => Math.round(Math.cos((lat * Math.PI) / 180) * 100);

/** Squared flat distance between the city and the answer, in centi-degrees². */
export function distance2(city: City, a: Answer): number {
  const dlat = Math.abs(city.lat - a.lat);
  const raw = Math.abs(city.lon - a.lon);
  const dlon = Math.floor((Math.min(raw, LON_WRAP - raw) * city.cos) / 100);
  return dlat * dlat + dlon * dlon;
}

/** Closeness in per-mille for a squared distance: the first band that contains it, 0 past the last. */
export function closeness(d2: number): number {
  const i = EXP_MILLI.findIndex((_, i) => d2 <= ((i + 1) * BAND_CD) ** 2);
  return i < 0 ? 0 : EXP_MILLI[i];
}

export function roundScore(city: City, a: Answer): number {
  const c = closeness(distance2(city, a));
  const accuracy = Math.floor((ACCURACY_MAX * c) / 1000);
  const speed = Math.floor((SPEED_MAX * c * (TIME_CAP - Math.min(a.t, TIME_CAP))) / (1000 * TIME_CAP));
  return accuracy + speed;
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

/** The answers as they travel in the advice map: ten packed rounds, in round order. */
export function packAnswers(answers: Answer[]): bigint[] {
  if (answers.length !== ROUNDS) throw new Error(`expected ${ROUNDS} answers`);
  return answers.map(packRound);
}
