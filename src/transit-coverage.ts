import type { Coordinate, StationFeature } from './domain.js';
import { metersPerDegreeAtLatitude } from './geodesy.js';

// The default distance legend reaches its darkest red at 5 km.
export const DEFAULT_NON_RED_DISTANCE_METERS = 5_000;

/** Area of the union of equal-radius station catchments in the same local
 * WGS84 distance plane used to color roads. Integrating exposed circle arcs
 * counts overlapping platforms/catchments once, without a sampled grid.
 * This measures geographic coverage, including water, rather than road ink.
 */
export function transitCoverageArea(
  stations: readonly StationFeature[],
  radius = DEFAULT_NON_RED_DISTANCE_METERS,
): number {
  const open = stations.filter((station) => station.properties.status === 'open');
  const origin = open[0]?.geometry.coordinates;
  if (!origin || radius <= 0) return 0;
  const scale = metersPerDegreeAtLatitude(
    open.reduce((sum, station) => sum + station.geometry.coordinates[1], 0) /
      open.length,
  );
  const unique = new Map<string, Coordinate>();
  for (const station of open) {
    const [longitude, latitude] = station.geometry.coordinates;
    unique.set(`${longitude},${latitude}`, [
      (longitude - origin[0]) * scale.longitude,
      (latitude - origin[1]) * scale.latitude,
    ]);
  }
  const centers = [...unique.values()];
  const full = 2 * Math.PI;
  let area = 0;
  for (const center of centers) {
    const [x, y] = center;
    const covered: Coordinate[] = [];
    for (const other of centers) {
      if (other === center) continue;
      const dx = other[0] - x;
      const dy = other[1] - y;
      const distance = Math.hypot(dx, dy);
      if (distance >= 2 * radius) continue;
      const half = Math.acos(distance / (2 * radius));
      const start = (((Math.atan2(dy, dx) - half) % full) + full) % full;
      const end = start + 2 * half;
      covered.push([start, Math.min(end, full)]);
      if (end > full) covered.push([0, end - full]);
    }
    covered.sort((a, b) => a[0] - b[0]);
    const arcArea = (start: number, end: number): number =>
      (radius *
        (x * (Math.sin(end) - Math.sin(start)) +
          y * (Math.cos(start) - Math.cos(end)) +
          radius * (end - start))) /
      2;
    let end = 0;
    for (const [start, nextEnd] of covered) {
      if (start > end) area += arcArea(end, start);
      end = Math.max(end, nextEnd);
    }
    area += arcArea(end, full);
  }
  return Math.max(0, area);
}
