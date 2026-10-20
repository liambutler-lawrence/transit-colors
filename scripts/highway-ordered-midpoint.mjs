import geographicLib from 'geographiclib-geodesic';
import { orderedMidline, curve, taperMatches } from './ordered-midline.mjs';
import { geodesicDistanceMeters, geodesicMidpoint } from './wgs84-geodesy.mjs';

const earth = geographicLib.Geodesic.WGS84;
export const HIGHWAY_MIDPOINT_TAPER_METERS = 200;

// Drop redundant vertices, not shape: every removed point stays within 10 cm
// of its retained segment in the local metric plane. Endpoints remain exact.
export function compactMidpointIndices(coordinates, tolerance = 0.1) {
  if (coordinates.length <= 2) return coordinates.map((_, i) => i);
  const scale = Math.cos((coordinates[0][1] * Math.PI) / 180);
  const points = coordinates.map(([x, y]) => [
    (x - coordinates[0][0]) * 111320 * scale,
    (y - coordinates[0][1]) * 110574,
  ]);
  const keep = new Set([0, points.length - 1]);
  const pending = [[0, points.length - 1]];
  while (pending.length) {
    const [start, end] = pending.pop();
    const a = points[start],
      b = points[end];
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    const denominator = dx * dx + dy * dy;
    let maximum = tolerance * tolerance,
      furthest = -1;
    for (let i = start + 1; i < end; i++) {
      const x = points[i][0] - a[0],
        y = points[i][1] - a[1];
      const t = Math.max(0, Math.min(1, (x * dx + y * dy) / (denominator || 1)));
      const squared = (x - t * dx) ** 2 + (y - t * dy) ** 2;
      if (squared > maximum) {
        maximum = squared;
        furthest = i;
      }
    }
    if (furthest >= 0) {
      keep.add(furthest);
      pending.push([start, furthest], [furthest, end]);
    }
  }
  return [...keep].sort((a, b) => a - b);
}

/** Inputs are proven source pairs oriented in the same travel direction. */
export function orderedCarriagewayMidpoints(first, second, options = {}) {
  if (first.length < 2 || second.length < 2) return null;
  const reverse =
    JSON.stringify([first.at(-1), second.at(-1)].sort()) <
    JSON.stringify([first[0], second[0]].sort());
  if (reverse) {
    const result = orderedCarriagewayMidpoints(
      first.toReversed(),
      second.toReversed(),
      options,
    );
    if (!result) return null;
    const a = result.pairs.at(-1).firstDistance,
      b = result.pairs.at(-1).secondDistance;
    return {
      ...result,
      coordinates: result.coordinates.toReversed(),
      pairs: result.pairs.toReversed().map((p) => ({
        ...p,
        firstDistance: a - p.firstDistance,
        secondDistance: b - p.secondDistance,
        firstPosition: first.length - 1 - p.firstPosition,
        secondPosition: second.length - 1 - p.secondPosition,
      })),
    };
  }
  // Canonical side order makes swapping the two source arguments identical,
  // including projection origin and deterministic equal-cost grid tie breaks.
  const swapped = JSON.stringify(first) > JSON.stringify(second);
  const sides = swapped ? [second, first] : [first, second];
  const origin = sides[0][0];
  const project = (p) => {
    const g = earth.Inverse(origin[1], origin[0], p[1], p[0]);
    const angle = (g.azi1 * Math.PI) / 180;
    return [g.s12 * Math.sin(angle), g.s12 * Math.cos(angle)];
  };
  const projected = sides.map((side) => side.map(project));
  const curves = projected.map(curve);
  if (curves.some((c) => c.length < 0.01)) return null;
  const result = orderedMidline(...projected, 1, 1, HIGHWAY_MIDPOINT_TAPER_METERS);
  const sourcePoint = (side, s) => {
    const distances = curves[side].along;
    let lo = 0,
      hi = distances.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (distances[mid] <= s) lo = mid;
      else hi = mid;
    }
    const fraction = Math.max(
      0,
      Math.min(1, (s - distances[lo]) / (distances[hi] - distances[lo] || 1)),
    );
    return {
      coordinate: sides[side][lo].map(
        (v, k) => v + fraction * (sides[side][hi][k] - v),
      ),
      position: lo + fraction,
    };
  };
  // The bounded optimization grid can be coarse on very long highways. Follow
  // its continuous source correspondence at <=10 m increments before applying
  // the taper, preserving source bends and the physical 200 m taper width.
  let matches = result.matches;
  if (
    result.rawMatches.some(
      (p, i, all) => i > 0 && Math.max(p.sa - all[i - 1].sa, p.sb - all[i - 1].sb) > 10,
    )
  ) {
    const dense = [];
    for (let i = 0; i < result.rawMatches.length; i++) {
      const p = result.rawMatches[i],
        before = result.rawMatches[i - 1];
      const count = before
        ? Math.max(1, Math.ceil(Math.max(p.sa - before.sa, p.sb - before.sb) / 10))
        : 1;
      for (let j = 1; j <= count; j++)
        dense.push(
          before
            ? {
                sa: before.sa + ((p.sa - before.sa) * j) / count,
                sb: before.sb + ((p.sb - before.sb) * j) / count,
              }
            : p,
        );
    }
    matches = taperMatches(dense, curves[0], curves[1], HIGHWAY_MIDPOINT_TAPER_METERS);
  }
  const pairs = matches.map((p) => {
    const a = sourcePoint(0, p.sa),
      b = sourcePoint(1, p.sb);
    return swapped
      ? {
          first: b.coordinate,
          second: a.coordinate,
          firstPosition: b.position,
          secondPosition: a.position,
          firstDistance: p.sb,
          secondDistance: p.sa,
        }
      : {
          first: a.coordinate,
          second: b.coordinate,
          firstPosition: a.position,
          secondPosition: b.position,
          firstDistance: p.sa,
          secondDistance: p.sb,
        };
  });
  const coordinates = pairs.map((p) =>
    geodesicMidpoint(p.first, p.second).map((v) => Number(v.toFixed(7))),
  );
  // Retain metre-scale shape without turning sub-centimetre coordinate rounding
  // into artificial bends, or adding redundant routing vertices every metre.
  const kept = [0];
  for (let i = 1; i < coordinates.length - 1; i++)
    if (geodesicDistanceMeters(coordinates[kept.at(-1)], coordinates[i]) >= 5)
      kept.push(i);
  if (
    kept.length > 1 &&
    geodesicDistanceMeters(coordinates[kept.at(-1)], coordinates.at(-1)) < 1
  )
    kept.pop();
  kept.push(coordinates.length - 1);
  const compact = options.compact
    ? compactMidpointIndices(kept.map((i) => coordinates[i])).map((i) => kept[i])
    : kept;
  return {
    coordinates: compact.map((i) => coordinates[i]),
    pairs: compact.map((i) => pairs[i]),
    spacing: [result.spacingA, result.spacingB],
    taper: result.taper,
  };
}
