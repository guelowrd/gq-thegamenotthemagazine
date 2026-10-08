import { describe, expect, it } from "vitest";
import { latLonToPixel, MAP_H, MAP_W, pixelToLatLon } from "../WorldMap";

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
