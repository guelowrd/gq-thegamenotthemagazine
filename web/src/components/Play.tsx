// Plays one quiz: ten cities, one click each, time measured in the browser. Map left, HUD right.

import { useEffect, useRef, useState } from "react";
import { WorldMap, type LatLon } from "./WorldMap";
import { latToCd, lonToCd, quizScore, roundScore, TIME_CAP, type Answer, type City } from "@/lib/rules";
import type { Place } from "@/lib/quiz";
import { blocksToClock } from "@/lib/flow";

export type PlayResult = { answers: Answer[]; score: number };

const cdToLatLon = (c: { lat: number; lon: number }): LatLon => ({ lat: c.lat / 100 - 90, lon: c.lon / 100 - 180 });
const BARS = 15;


export function Play({
  cities,
  places,
  onDone,
  rival,
}: {
  cities: City[];
  places: Place[];
  onDone: (r: PlayResult) => void;
  /** Playing a shot: the rival sprite and the shot clock (blocks left) show in the HUD. */
  rival?: { blocksLeft: number };
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

  // show where the city was for a moment, then move on by itself: no extra click
  useEffect(() => {
    if (!lastPick) return;
    const t = setTimeout(next, 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastPick]);

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
  const name = place?.name ?? `city #${current.idx}`;
  const answered = lastPick ? answers[answers.length - 1] : null;
  const points = answered ? roundScore(current, answered) : null;
  const total = quizScore(cities.slice(0, answers.length), answers);
  const secondsLeft = Math.max(0, TIME_CAP - elapsed) / 100;

  return (
    <section className="play">
      <h1>{answered ? (points ? "Nice shot!" : "Missed!") : `Find ${name}!`}</h1>
      <div className="chips" aria-label={`Round ${round + 1} of ${cities.length}`}>
        {cities.map((_, i) => (
          <span key={i} className={i < round ? "done" : i === round ? "now" : ""}>
            {i + 1}
          </span>
        ))}
      </div>
      <div className="cols">
        <div className="panel map-frame">
          <WorldMap
            onPick={pick}
            disabled={!!lastPick}
            marks={
              lastPick && answered
                ? [
                    { at: lastPick, color: "#ff2c9c", label: "you" },
                    { at: cdToLatLon(current), color: "#ffe83b", label: name },
                  ]
                : []
            }
          />
          {answered && (
            <div className={`banner${points ? "" : " miss"}`}>
              {points ? "Nice shot!" : "Missed!"} +{points}
            </div>
          )}
        </div>
        <aside className={`panel hud${rival ? " pink" : ""}`}>
          {rival && (
            <div className="rival">
              <img src="/brand/rival.svg" alt="" width={130} height={160} />
              <div className="bubble">Beat my record!</div>
            </div>
          )}
          <div className="eyebrow">
            City {String(round + 1).padStart(2, "0")} / {cities.length}
          </div>
          <div className="city">{name}</div>
          <div className="country">{place?.country ?? ""}</div>
          <div className="eyebrow">Round time</div>
          <div className="clock" aria-live="off">
            {answered ? "Done" : `0:${String(Math.ceil(secondsLeft)).padStart(2, "0")}`}
          </div>
          <div className="bar" aria-hidden="true">
            {Array.from({ length: BARS }, (_, i) => (
              <i key={i} className={i < Math.ceil(secondsLeft) ? "on" : ""} />
            ))}
          </div>
          <div className="eyebrow">Total score</div>
          <div className="total">{total.toLocaleString()}</div>
          {rival && <div className="deadline">Shot ends: {blocksToClock(rival.blocksLeft)}</div>}
        </aside>
      </div>
    </section>
  );
}
