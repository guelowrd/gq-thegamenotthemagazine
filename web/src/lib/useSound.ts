// Two original tracks, off by default; nothing loads until the toggle is on.
// ponytail: one <audio> element, no fades; the choice is remembered per browser.

import { useEffect, useRef, useState } from "react";

export const TRACKS = { home: "/brand/home.mp3", play: "/brand/play.mp3" } as const;
const KEY = "gq:sound";

export function useSound(track: keyof typeof TRACKS) {
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
    void a.play().catch(() => undefined); // autoplay policy: plays from the next click
    return () => a.pause();
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
