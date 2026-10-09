// The map's projection: equirectangular on a 1000 × 500 picture, so a click maps to latitude and
// longitude linearly, and back.

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
