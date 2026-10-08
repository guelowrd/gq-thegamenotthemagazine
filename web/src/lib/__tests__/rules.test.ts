import { describe, expect, it } from "vitest";
import vectors from "../../../../rules/vectors.json";
import { packAnswers, quizScore, QUIZ_MAX, roundScore, unpackRound, type Answer, type City } from "../rules";

const PARIS: City = { idx: 0, lat: 13885, lon: 18235, cos: 66 };
const ans = (lat: number, lon: number, t: number): Answer => ({ lat, lon, t });

describe("rules v1", () => {
  it("matches every shared vector (score and packed answer word)", () => {
    for (const v of vectors) {
      expect(quizScore(v.cities, v.answers), v.name).toBe(v.score);
      expect(packAnswers(v.answers).map(String), v.name).toEqual(v.packed.map(String));
    }
  });

  it("scores a perfect fast round at the round max", () => {
    expect(roundScore(PARIS, ans(13885, 18235, 0))).toBe(1300);
    expect(QUIZ_MAX).toBe(5200);
  });

  it("gives no speed bonus on a miss and respects band edges", () => {
    expect(roundScore(PARIS, ans(0, 0, 0))).toBe(0);
    expect(roundScore(PARIS, ans(13885 + 100, 18235, 2000))).toBe(1000);
    expect(roundScore(PARIS, ans(13885 + 101, 18235, 2000))).toBe(700);
    expect(roundScore(PARIS, ans(13885, 18235, 301))).toBe(1200);
  });

  it("round-trips the packed representation", () => {
    for (const a of [ans(0, 0, 0), ans(18000, 35999, 2047), ans(13885, 18235, 437)]) {
      expect(unpackRound(packAnswers([a, a, a, a])[0])).toEqual(a);
    }
  });
});
