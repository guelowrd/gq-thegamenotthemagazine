// The map: the pixel world (1000 × 500, Natural Earth geometry quantised) or a stage's region as
// the picture, the projection in lib/map.ts, a 30° graticule on the world and the marks. No map
// library. A stage shows the centred box its stretched coordinates fill (lib/stages.ts).
// On a phone a finger held on the map aims: a loupe shows what is under it, three times bigger,
// with a crosshair, and the shot lands where the finger lifts. A quick tap shoots on the spot.

import { useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { frameOf, latLonToPixel, MAP_H, MAP_W, pixelToLatLon, type LatLon } from "@/lib/map";
import { useT } from "@/lib/i18n";
import { WORLD, type Stage } from "@/lib/stages";

// a graticule every 30°: meridians from 150°W to 150°E, parallels from 60°N to 60°S
const MERIDIANS = Array.from({ length: 11 }, (_, i) => latLonToPixel({ lat: 0, lon: -150 + 30 * i }).x);
const PARALLELS = Array.from({ length: 5 }, (_, i) => latLonToPixel({ lat: 60 - 30 * i, lon: 0 }).y);

const HOLD_MS = 200;
const LOUPE = 120; // px, square
const ZOOM = 3;

export function WorldMap({
  onPick,
  marks = [],
  disabled = false,
  stage = WORLD,
}: {
  onPick?: (p: LatLon) => void;
  marks?: { at: LatLon; color: string; label?: string }[];
  disabled?: boolean;
  stage?: Stage;
}) {
  const t = useT();
  const frame = frameOf(stage);
  const pickable = !disabled && !!onPick;
  // the finger's spot in map units and on the screen, while it aims
  const [aim, setAim] = useState<{ x: number; y: number; cx: number; cy: number; scale: number } | null>(null);
  const hold = useRef(0);
  const aiming = useRef(false);
  const at = (e: { clientX: number; clientY: number; currentTarget: SVGSVGElement }) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: frame.x + ((e.clientX - rect.left) / rect.width) * frame.w,
      y: frame.y + ((e.clientY - rect.top) / rect.height) * frame.h,
      cx: e.clientX,
      cy: e.clientY,
      scale: rect.width / frame.w,
    };
  };
  const shoot = (p: { x: number; y: number }) => onPick!(pixelToLatLon(p.x, p.y));

  const handleClick = (e: MouseEvent<SVGSVGElement>) => {
    if (!pickable || aiming.current) return; // an aimed shot already landed on pointerup
    shoot(at(e));
  };
  const down = (e: PointerEvent<SVGSVGElement>) => {
    aiming.current = false;
    if (!pickable || e.pointerType !== "touch") return;
    const p = at(e);
    hold.current = window.setTimeout(() => {
      aiming.current = true;
      setAim(p);
    }, HOLD_MS);
  };
  const move = (e: PointerEvent<SVGSVGElement>) => {
    if (aiming.current) setAim(at(e));
  };
  const up = (e: PointerEvent<SVGSVGElement>) => {
    clearTimeout(hold.current);
    if (!aiming.current) return;
    setAim(null);
    shoot(at(e));
  };
  const cancel = () => {
    clearTimeout(hold.current);
    aiming.current = false;
    setAim(null);
  };

  const picture = (
    <>
      <image href={stage.map} x={frame.x} y={frame.y} width={frame.w} height={frame.h} preserveAspectRatio="none" />
      {stage.id === "world" && (
        <>
          {MERIDIANS.map((x) => <line key={`v${x}`} className="grid" x1={x} y1={0} x2={x} y2={MAP_H} />)}
          {PARALLELS.map((y) => <line key={`h${y}`} className="grid" x1={0} y1={y} x2={MAP_W} y2={y} />)}
        </>
      )}
    </>
  );
  const w = aim ? LOUPE / (aim.scale * ZOOM) : 0; // the loupe's window, in map units

  return (
    <>
      <svg
        viewBox={`${frame.x} ${frame.y} ${frame.w} ${frame.h}`}
        className="world-map"
        role="img"
        aria-label={stage.id === "world" ? t("World map") : t(stage.name)}
        onClick={handleClick}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={cancel}
        style={{ cursor: pickable ? "crosshair" : "default", touchAction: pickable ? "none" : undefined }}
      >
        {picture}
        {marks.map((m, i) => {
          const { x, y } = latLonToPixel(m.at);
          return (
            <g key={i}>
              <rect x={x - 6} y={y - 6} width={12} height={12} fill={m.color} stroke="#0c0827" strokeWidth={2} transform={`rotate(45 ${x} ${y})`} />
              {m.label && (
                <text x={x + 10} y={y - 10} fontSize={16} fontFamily="GeoQuizz Pixel, monospace" fill={m.color} stroke="#0c0827" strokeWidth={0.8}>
                  {m.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {aim && (
        <div
          className="loupe"
          aria-hidden
          style={{
            left: Math.min(Math.max(aim.cx - LOUPE / 2, 4), window.innerWidth - LOUPE - 4),
            top: aim.cy > LOUPE + 40 ? aim.cy - LOUPE - 24 : aim.cy + 24,
          }}
        >
          <svg viewBox={`${aim.x - w / 2} ${aim.y - w / 2} ${w} ${w}`}>
            {picture}
            <line x1={aim.x - w / 2} y1={aim.y} x2={aim.x + w / 2} y2={aim.y} vectorEffect="non-scaling-stroke" />
            <line x1={aim.x} y1={aim.y - w / 2} x2={aim.x} y2={aim.y + w / 2} vectorEffect="non-scaling-stroke" />
          </svg>
        </div>
      )}
    </>
  );
}
