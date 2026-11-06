// Plays one quiz: ten cities, one click each, time measured in the browser. Map left, HUD right.

import { useEffect, useRef, useState } from "react";
import { WorldMap } from "./WorldMap";
import type { LatLon } from "@/lib/map";
import { latToCd, lonToCd, quizScore, roundScore, TIME_CAP, type Answer, type City } from "@/lib/rules";
import type { Place } from "@/lib/quiz";
import { blocksToClock, secondsToClock } from "@/lib/flow";
import { useT } from "@/lib/i18n";
import type { Stage } from "@/lib/stages";

export type PlayResult = { answers: Answer[]; score: number };

const cdToLatLon = (c: { lat: number; lon: number }): LatLon => ({ lat: c.lat / 100 - 90, lon: c.lon / 100 - 180 });
const BARS = 15;
/** Phones held sideways, as in theme.css: the map and the city panel fill the screen, the ribbon waits above. */
const SIDEWAYS = "(orientation: landscape) and (max-height: 500px)";


export function Play({
  cities,
  places,
  onDone,
  rival,
  stage,
}: {
  cities: City[];
  places: Place[];
  onDone: (r: PlayResult) => void;
  /** Playing a shot: the rival sprite and the shot clock (blocks left) show in the HUD. */
  rival?: { blocksLeft: number; /** the champion's arcade name */ name: string };
  stage: Stage;
}) {
  const t = useT();
  const [round, setRound] = useState(0);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [lastPick, setLastPick] = useState<LatLon | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef(performance.now());
  const section = useRef<HTMLElement>(null);

  // also when the phone turns mid-quiz: people start upright, see the hint, and turn it
  useEffect(() => {
    const sideways = window.matchMedia?.(SIDEWAYS);
    if (!sideways) return;
    const fill = () => sideways.matches && section.current?.scrollIntoView?.({ block: "start" });
    fill();
    sideways.addEventListener("change", fill);
    return () => sideways.removeEventListener("change", fill);
  }, []);

  const current = cities[round];
  const finished = round >= cities.length;

  useEffect(() => {
    if (finished || lastPick) return;
    const timer = setInterval(() => setElapsed(Math.min(TIME_CAP, Math.floor((performance.now() - startedAt.current) / 10))), 100);
    return () => clearInterval(timer);
  }, [round, finished, lastPick]);

  // time out at the cap: the round is lost
  useEffect(() => {
    if (!finished && !lastPick && elapsed >= TIME_CAP) pick({ lat: -90, lon: -180 }, TIME_CAP);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elapsed]);

  function pick(p: LatLon, ms = Math.min(TIME_CAP, Math.floor((performance.now() - startedAt.current) / 10))) {
    if (finished || lastPick) return;
    setLastPick(p);
    setAnswers((a) => [...a, { lat: latToCd(p.lat), lon: lonToCd(p.lon), t: ms }]);
  }

  // show where the city was for a moment, then move on by itself: no extra click
  useEffect(() => {
    if (!lastPick) return;
    const timer = setTimeout(next, 1500);
    return () => clearTimeout(timer);
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
    <section className="play" ref={section}>
      <h1>{answered ? (points ? t("Nice shot!") : t("Missed!")) : t("Find {city}!", { city: name })}</h1>
      <div className="chips" aria-label={t("Round {n} of {total}", { n: round + 1, total: cities.length })}>
        {cities.map((_, i) => (
          <span key={i} className={i < round ? "done" : i === round ? "now" : ""}>
            {i + 1}
          </span>
        ))}
      </div>
      <div className="cols">
        <div className="panel map-frame">
          <WorldMap
            stage={stage}
            onPick={pick}
            disabled={!!lastPick}
            marks={
              lastPick && answered
                ? [
                    { at: lastPick, color: "#ff2c9c", label: t("you") },
                    { at: cdToLatLon(current), color: "#ffe83b", label: name },
                  ]
                : []
            }
          />
          {answered && (
            <div className={`banner${points ? "" : " miss"}`}>
              {points ? t("Nice shot!") : t("Missed!")} +{points}
            </div>
          )}
        </div>
        <aside className={`panel hud${rival ? " pink" : ""}`}>
          {rival && (
            <div className="rival">
              <img src="/brand/rival.svg" alt="" width={130} height={160} />
              <div className="bubble">
                {rival.name}
                <br />
                {t("Beat my record!")}
              </div>
            </div>
          )}
          <div className="eyebrow">{t("City {n} / {total}", { n: String(round + 1).padStart(2, "0"), total: cities.length })}</div>
          <div className="city">{name}</div>
          <div className="country">{place?.country ?? ""}</div>
          <div className="eyebrow">{t("Round time")}</div>
          <div className="clock" aria-live="off">
            {answered ? t("Done") : secondsToClock(Math.ceil(secondsLeft))}
          </div>
          <div className="bar" aria-hidden="true">
            {Array.from({ length: BARS }, (_, i) => (
              <i key={i} className={i < Math.ceil(secondsLeft) ? "on" : ""} />
            ))}
          </div>
          <div className="eyebrow">{t("Total score")}</div>
          <div className="total">{total.toLocaleString()}</div>
          {rival && <div className="deadline">{t("Shot ends: {time}", { time: blocksToClock(rival.blocksLeft) })}</div>}
        </aside>
      </div>
    </section>
  );
}
