// Plays one quiz: four cities, one click each, time measured in the browser.

import { useEffect, useRef, useState } from "react";
import { WorldMap, type LatLon } from "./WorldMap";
import { latToCd, lonToCd, quizScore, roundScore, TIME_CAP, type Answer, type City } from "@/lib/rules";
import type { Place } from "@/lib/quiz";

export type PlayResult = { answers: Answer[]; score: number };

const cdToLatLon = (c: { lat: number; lon: number }): LatLon => ({ lat: c.lat / 100 - 90, lon: c.lon / 100 - 180 });

export function Play({
  cities,
  places,
  onDone,
}: {
  cities: City[];
  places: Place[];
  onDone: (r: PlayResult) => void;
}) {
  const [round, setRound] = useState(0);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [lastPick, setLastPick] = useState<LatLon | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef(performance.now());

  const current = cities[round];
  const finished = round >= cities.length;

  useEffect(() => {
    if (finished || lastPick) return;
    const t = setInterval(() => setElapsed(Math.min(TIME_CAP, Math.floor((performance.now() - startedAt.current) / 10))), 100);
    return () => clearInterval(t);
  }, [round, finished, lastPick]);

  // time out at the cap: the round is lost
  useEffect(() => {
    if (!finished && !lastPick && elapsed >= TIME_CAP) pick({ lat: -90, lon: -180 }, TIME_CAP);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elapsed]);

  function pick(p: LatLon, t = Math.min(TIME_CAP, Math.floor((performance.now() - startedAt.current) / 10))) {
    if (finished || lastPick) return;
    setLastPick(p);
    setAnswers((a) => [...a, { lat: latToCd(p.lat), lon: lonToCd(p.lon), t }]);
  }

  function next() {
    const nextRound = round + 1;
    setLastPick(null);
    setRound(nextRound);
    startedAt.current = performance.now();
    setElapsed(0);
    if (nextRound >= cities.length) onDone({ answers, score: quizScore(cities, answers) });
  }

  if (finished) return null;
  const place = places[current.idx];
  const answered = lastPick ? answers[answers.length - 1] : null;

  return (
    <section className="play">
      <header className="play-header">
        <span className="muted">
          {round + 1} / {cities.length}
        </span>
        <strong>Where is {place?.name ?? `city #${current.idx}`}?</strong>
        <span className="timer">{(elapsed / 100).toFixed(0)}</span>
      </header>
      <WorldMap
        onPick={pick}
        disabled={!!lastPick}
        marks={
          lastPick && answered
            ? [
                { at: lastPick, color: "#d33", label: "you" },
                { at: cdToLatLon(current), color: "#2a7", label: place?.name },
              ]
            : []
        }
      />
      {answered && (
        <footer className="play-footer">
          <strong>+{roundScore(current, answered)}</strong>
          <button onClick={next}>{round + 1 < cities.length ? "Next" : "Done"}</button>
        </footer>
      )}
    </section>
  );
}
