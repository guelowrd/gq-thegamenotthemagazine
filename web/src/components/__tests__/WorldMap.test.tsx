import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { latLonToPixel, MAP_H, MAP_W, pixelToLatLon } from "@/lib/map";
import { WorldMap } from "../WorldMap";

describe("equirectangular mapping", () => {
  it("maps the corners and the centre", () => {
    expect(pixelToLatLon(0, 0)).toEqual({ lat: 90, lon: -180 });
    expect(pixelToLatLon(MAP_W, MAP_H)).toEqual({ lat: -90, lon: 180 });
    expect(pixelToLatLon(MAP_W / 2, MAP_H / 2)).toEqual({ lat: 0, lon: 0 });
  });

  it("round-trips Paris", () => {
    const paris = { lat: 48.85, lon: 2.35 };
    const { x, y } = latLonToPixel(paris);
    const back = pixelToLatLon(x, y);
    expect(back.lat).toBeCloseTo(paris.lat, 6);
    expect(back.lon).toBeCloseTo(paris.lon, 6);
  });
});

describe("the grid over the map", () => {
  it("draws a line every 30°, on both hemispheres and both sides", () => {
    const { container } = render(<WorldMap />);
    const lines = [...container.querySelectorAll("line.grid")];
    const xs = lines.filter((l) => l.getAttribute("y1") === "0").map((l) => Number(l.getAttribute("x1")));
    const ys = lines.filter((l) => l.getAttribute("x1") === "0").map((l) => Number(l.getAttribute("y1")));
    expect(xs.map((x) => Math.round((x / MAP_W) * 360 - 180))).toEqual([-150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150]);
    expect(ys.map((y) => Math.round(90 - (y / MAP_H) * 180))).toEqual([60, 30, 0, -30, -60]);
  });
});

describe("aiming with a finger", () => {
  afterEach(() => vi.useRealTimers());
  // the map fills 1000 × 500 px, so a screen pixel is a map unit
  const mapOf = (onPick: (p: { lat: number; lon: number }) => void) => {
    const svg = render(<WorldMap onPick={onPick} />).container.querySelector("svg.world-map")!;
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 500 }) as DOMRect;
    return svg;
  };

  it("a finger held 200 ms shows the loupe and shoots where it lifts, once", () => {
    vi.useFakeTimers();
    const onPick = vi.fn();
    const svg = mapOf(onPick);
    fireEvent.pointerDown(svg, { pointerType: "touch", clientX: 500, clientY: 250 });
    expect(document.querySelector(".loupe")).toBeNull();
    act(() => vi.advanceTimersByTime(200));
    expect(document.querySelector(".loupe")).not.toBeNull();
    fireEvent.pointerMove(svg, { pointerType: "touch", clientX: 600, clientY: 250 });
    fireEvent.pointerUp(svg, { pointerType: "touch", clientX: 600, clientY: 250 });
    fireEvent.click(svg, { clientX: 600, clientY: 250 }); // the browser's trailing click
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0].lon).toBeCloseTo(36);
    expect(document.querySelector(".loupe")).toBeNull();
  });

  it("a quick tap shoots on the spot", () => {
    vi.useFakeTimers();
    const onPick = vi.fn();
    const svg = mapOf(onPick);
    fireEvent.pointerDown(svg, { pointerType: "touch", clientX: 500, clientY: 250 });
    act(() => vi.advanceTimersByTime(50));
    fireEvent.pointerUp(svg, { pointerType: "touch", clientX: 500, clientY: 250 });
    fireEvent.click(svg, { clientX: 500, clientY: 250 });
    act(() => vi.advanceTimersByTime(500));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0]).toEqual({ lat: 0, lon: 0 });
    expect(document.querySelector(".loupe")).toBeNull();
  });
});
