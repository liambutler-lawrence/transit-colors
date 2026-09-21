import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import geographicLib from 'geographiclib-geodesic';

export const RADIUS_METERS = 5000;
export function governmentSeatFeatures(seats) {
  return {
    type: 'FeatureCollection',
    features: seats.flatMap((seat) => {
      const [longitude, latitude] = seat.coordinates;
      const ring = Array.from({ length: 180 }, (_, index) => {
        const point = geographicLib.Geodesic.WGS84.Direct(
          latitude,
          longitude,
          -index * 2,
          RADIUS_METERS,
        );
        return [Number(point.lon2.toFixed(7)), Number(point.lat2.toFixed(7))];
      });
      ring.push([...ring[0]]);
      return [
        {
          type: 'Feature',
          properties: { id: seat.id, subdivision: seat.subdivision },
          geometry: { type: 'Point', coordinates: seat.coordinates },
        },
        {
          type: 'Feature',
          properties: { id: seat.id, radiusMeters: RADIUS_METERS },
          geometry: { type: 'Polygon', coordinates: [ring] },
        },
      ];
    }),
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const catalog = JSON.parse(
    await readFile(
      new URL('../data/north-america-government-seats.json', import.meta.url),
      'utf8',
    ),
  );
  await writeFile(
    new URL('../data/north-america-government-seats.geojson', import.meta.url),
    JSON.stringify(governmentSeatFeatures(catalog.seats)) + '\n',
  );
}
