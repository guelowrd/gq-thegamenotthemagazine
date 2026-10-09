// Four original tracks, off by default; nothing loads until the toggle is on.
// ponytail: one <audio> element, no fades; the choice is remembered per browser.

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
      return localStorage.getItem(KEY) === "on";
    } catch {
      return false;
    }
  });
  const audio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (!on) {
      audio.current?.pause();
      return;
    }
    const a = (audio.current ??= Object.assign(new Audio(), { loop: true, volume: 0.5 }));
    const src = TRACKS[track];
    if (!a.src.endsWith(src)) a.src = src;
    // after a reload the browser refuses to play before the first click or key: try again then
    const retry = () => void a.play().catch(() => undefined);
    void a.play().catch(() => {
      window.addEventListener("pointerdown", retry, { once: true });
      window.addEventListener("keydown", retry, { once: true });
    });
    return () => {
      window.removeEventListener("pointerdown", retry);
      window.removeEventListener("keydown", retry);
      a.pause();
    };
  }, [on, track]);

  const toggle = () => {
    const next = !on;
    setOn(next);
    try {
      localStorage.setItem(KEY, next ? "on" : "off");
    } catch {
      /* private window */
    }
  };
  return { on, toggle };
}
