// Four original tracks, ON at every new visit. Browsers refuse sound before the first click or key
// on the page, so the home theme starts with CLICK TO START. SOUND OFF holds for the whole visit,
// reloads included (sessionStorage, one per tab); a new tab starts with sound again.
// ponytail: one <audio> element, no fades.

import { useEffect, useRef, useState } from "react";

export const TRACKS = {
  home: "/brand/home.mp3",
  play: "/brand/play.mp3", // the 1P World Tour
  vs: "/brand/vs.mp3", // a shot at someone's record
  result: "/brand/result.mp3", // a score on screen
} as const;
export type Track = keyof typeof TRACKS;
const KEY = "gq:sound";

export function useSound(track: Track) {
  const [on, setOn] = useState(() => {
    try {
      return sessionStorage.getItem(KEY) !== "off";
    } catch {
      return true;
    }
  });
  const audio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (!on) {
      audio.current?.pause();
      return;
    }
    let alive = true;
    const a = (audio.current ??= Object.assign(new Audio(), { loop: true, volume: 0.5 }));
    const src = TRACKS[track];
    if (!a.src.endsWith(src)) a.src = src;
    // refused before the first click or key: try again on the next one, unless this effect is over
    const retry = () => {
      if (alive) void a.play()?.catch(arm);
    };
    const arm = () => {
      if (!alive) return;
      window.addEventListener("pointerdown", retry, { once: true });
      window.addEventListener("keydown", retry, { once: true });
    };
    void a.play()?.catch(arm);
    return () => {
      alive = false;
      window.removeEventListener("pointerdown", retry);
      window.removeEventListener("keydown", retry);
      a.pause();
    };
  }, [on, track]);

  const toggle = () => {
    const next = !on;
    setOn(next);
    try {
      sessionStorage.setItem(KEY, next ? "on" : "off");
    } catch {
      /* storage blocked: the choice lasts until the page is left */
    }
  };
  return { on, toggle };
}
