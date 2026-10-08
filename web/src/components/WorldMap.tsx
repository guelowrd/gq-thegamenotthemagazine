// An equirectangular world map drawn from Natural Earth country outlines (public domain).
// Click → latitude/longitude is a linear mapping, so no map library is needed.

import { useEffect, useState, type MouseEvent } from "react";
import { WORLD_URL } from "@/config";

export const MAP_W = 1000;
export const MAP_H = 500;

export type LatLon = { lat: number; lon: number };

export const pixelToLatLon = (x: number, y: number): LatLon => ({
  lat: 90 - (y / MAP_H) * 180,
  lon: (x / MAP_W) * 360 - 180,
});
export const latLonToPixel = (p: LatLon) => ({
  x: ((p.lon + 180) / 360) * MAP_W,
  y: ((90 - p.lat) / 180) * MAP_H,
});

type Ring = [number, number][];
let worldPromise: Promise<Ring[]> | undefined;
const loadWorld = () => (worldPromise ??= fetch(WORLD_URL).then((r) => r.json() as Promise<Ring[]>));

export function WorldMap({
  onPick,
  marks = [],
  disabled = false,
}: {
  onPick?: (p: LatLon) => void;
  marks?: { at: LatLon; color: string; label?: string }[];
  disabled?: boolean;
}) {
  const [rings, setRings] = useState<Ring[]>([]);
  useEffect(() => {
    loadWorld().then(setRings).catch(() => setRings([]));
  }, []);

  const handleClick = (e: MouseEvent<SVGSVGElement>) => {
    if (disabled || !onPick) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * MAP_W;
    const y = ((e.clientY - rect.top) / rect.height) * MAP_H;
    onPick(pixelToLatLon(x, y));
  };

  return (
    <svg
      viewBox={`0 0 ${MAP_W} ${MAP_H}`}
      className="world-map"
      role="img"
      aria-label="World map"
      onClick={handleClick}
      style={{ cursor: disabled || !onPick ? "default" : "crosshair" }}
    >
      <rect width={MAP_W} height={MAP_H} className="sea" />
      {rings.map((ring, i) => (
        <polygon
          key={i}
          className="land"
          points={ring.map(([lon, lat]) => `${((lon + 180) / 360) * MAP_W},${((90 - lat) / 180) * MAP_H}`).join(" ")}
        />
      ))}
      {marks.map((m, i) => {
        const { x, y } = latLonToPixel(m.at);
        return (
          <g key={i}>
            <circle cx={x} cy={y} r={6} fill={m.color} stroke="#fff" strokeWidth={2} />
            {m.label && (
              <text x={x + 9} y={y - 9} fontSize={14} fill={m.color} stroke="#fff" strokeWidth={0.5}>
                {m.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
