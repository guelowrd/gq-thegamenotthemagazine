import { describe, expect, it } from "vitest";
import vectors from "../../../../rules/vectors.json";
import { answerCommitment, closeness, EXP_MILLI, packAnswers, quizScore, QUIZ_MAX, ROUNDS, roundScore, unpackRound, type Answer, type City } from "../rules";

const PARIS: City = { idx: 0, lat: 13885, lon: 18235, cos: 66 };
const ans = (lat: number, lon: number, t: number): Answer => ({ lat, lon, t });

describe("rules v2", () => {
  it("matches every shared vector: score, packed answers and their commitment", () => {
    for (const v of vectors) {
      expect(quizScore(v.cities, v.answers), v.name).toBe(v.score);
      expect(packAnswers(v.answers).map(String), v.name).toEqual(v.packed);
      expect(answerCommitment(v.answers).toHex(), v.name).toBe(v.commitment);
    }
  });

  it("scores a perfect instant round at 1000 and a quiz of ten at 10 000", () => {
    expect(ROUNDS).toBe(10);
    expect(roundScore(PARIS, ans(13885, 18235, 0))).toBe(1000);
    expect(roundScore(PARIS, ans(13885, 18235, 1500))).toBe(850);
    expect(QUIZ_MAX).toBe(10_000);
  });

  it("falls off by bands of 25 centi-degrees and gives nothing far away, however fast", () => {
    expect(closeness(25 * 25)).toBe(1000);
    expect(closeness(25 * 25 + 1)).toBe(EXP_MILLI[1]);
    expect(closeness(450 * 450)).toBe(EXP_MILLI[17]); // ≈ 500 km
    expect(closeness(3200 * 3200 + 1)).toBe(0);
    expect(roundScore(PARIS, ans(13885 + 26, 18235, 1500))).toBe(Math.floor((850 * 946) / 1000));
    expect(roundScore(PARIS, ans(0, 0, 0))).toBe(0);
  });

  it("round-trips the packed representation", () => {
    for (const a of [ans(0, 0, 0), ans(18000, 35999, 2047), ans(13885, 18235, 437)]) {
      expect(unpackRound(packAnswers(Array(ROUNDS).fill(a))[0])).toEqual(a);
    }
  });
});
