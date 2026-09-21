import geographicLib from 'geographiclib-geodesic';
import { pointInRing } from './natural-earth-land.mjs';
const earth = geographicLib.Geodesic.WGS84;
export const distance = (a, b) => earth.Inverse(a[1], a[0], b[1], b[0]).s12;
export const lineLength = (points) =>
  points.slice(1).reduce((sum, p, i) => sum + distance(points[i], p), 0);

// A segment can enter and leave the circle even when both endpoints are outside.
// Minimize ellipsoidal distance first, then bisect the first entry along travel.
export function firstCircleEntry(points, center, radius = 5000) {
  let travelled = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    const inverse = earth.Inverse(a[1], a[0], b[1], b[0]);
    const length = inverse.s12;
    const da = distance(a, center);
    if (da <= radius)
      return { coordinates: points.slice(0, i), distanceMeters: travelled };
    // Triangle inequality avoids expensive minimization for distant segments.
    if (da - length > radius) {
      travelled += length;
      continue;
    }
    const at = (s) => {
      const p = earth.Direct(a[1], a[0], inverse.azi1, s);
      return [p.lon2, p.lat2];
    };
    let low = 0,
      high = length;
    for (let n = 0; n < 45; n++) {
      const left = low + (high - low) / 3,
        right = high - (high - low) / 3;
      if (distance(at(left), center) < distance(at(right), center)) high = right;
      else low = left;
    }
    let inside = (low + high) / 2;
    if (distance(b, center) < distance(at(inside), center)) inside = length;
    if (distance(at(inside), center) > radius) {
      travelled += length;
      continue;
    }
    low = 0;
    high = inside;
    for (let n = 0; n < 45; n++) {
      const mid = (low + high) / 2;
      if (distance(at(mid), center) <= radius) high = mid;
      else low = mid;
    }
    return {
      coordinates: [...points.slice(0, i), at(high)],
      distanceMeters: travelled + high,
    };
  }
  if (points.length && distance(points.at(-1), center) <= radius)
    return { coordinates: points, distanceMeters: travelled };
  return null;
}

export function insideSubdivision(point, geometry) {
  const polygons =
    geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polygons.some(
    ([outer, ...holes]) =>
      pointInRing(point, outer) && !holes.some((hole) => pointInRing(point, hole)),
  );
}

// Test open intervals between all polygon-edge intersections, so a boundary
// touch does not count as traversing a subdivision and holes remain excluded.
export function lineTraversesSubdivision(points, geometry) {
  const polygons =
    geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const vertices = polygons.flat(2);
  const bounds = vertices.reduce(
    (b, p) => [
      Math.min(b[0], p[0]),
      Math.min(b[1], p[1]),
      Math.max(b[2], p[0]),
      Math.max(b[3], p[1]),
    ],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    if (
      Math.max(a[0], b[0]) < bounds[0] ||
      Math.min(a[0], b[0]) > bounds[2] ||
      Math.max(a[1], b[1]) < bounds[1] ||
      Math.min(a[1], b[1]) > bounds[3]
    )
      continue;
    if (insideSubdivision(a, geometry) || insideSubdivision(b, geometry)) return true;
    const cuts = [0, 1],
      dx = b[0] - a[0],
      dy = b[1] - a[1];
    for (const ring of polygons.flat())
      for (let j = 1; j < ring.length; j++) {
        const c = ring[j - 1],
          d = ring[j],
          ex = d[0] - c[0],
          ey = d[1] - c[1];
        const cross = dx * ey - dy * ex;
        if (Math.abs(cross) < 1e-16) continue;
        const t = ((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / cross;
        const u = ((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / cross;
        if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.push(t);
      }
    cuts.sort((x, y) => x - y);
    for (let j = 1; j < cuts.length; j++) {
      const t = (cuts[j - 1] + cuts[j]) / 2;
      if (insideSubdivision([a[0] + dx * t, a[1] + dy * t], geometry)) return true;
    }
  }
  return false;
}
