// Grade-separated crossings remain separate graph edges. A simple boundary
// cannot select both geometries; this never creates a junction at a crossing.
function findCrossings(edges, edgeIndices, firstIntersectionOnly = false) {
  const cells = new Map(),
    pairs = new Map();
  const orientation = (a, b, c) => orient2d(...a, ...b, ...c);
  for (const i of edgeIndices) {
    const points = edges[i].coordinates;
    for (let j = 1; j < points.length; j++) {
      const a = points[j - 1],
        b = points[j],
        checked = new Set();
      const segment = { i, j, a, b };
      for (
        let x = Math.floor(Math.min(a[0], b[0]) * 100);
        x <= Math.floor(Math.max(a[0], b[0]) * 100);
        x++
      )
        for (
          let y = Math.floor(Math.min(a[1], b[1]) * 100);
          y <= Math.floor(Math.max(a[1], b[1]) * 100);
          y++
        ) {
          const key = `${x},${y}`,
            cell = cells.get(key) ?? [];
          for (const other of cell) {
            if (checked.has(other) || (i === other.i && Math.abs(j - other.j) <= 1))
              continue;
            checked.add(other);
            const pairKey = i < other.i ? `${i},${other.i}` : `${other.i},${i}`;
            if (pairs.has(pairKey)) continue;
            const c = other.a,
              d = other.b;
            if (
              orientation(a, b, c) * orientation(a, b, d) < 0 &&
              orientation(c, d, a) * orientation(c, d, b) < 0
            ) {
              if (firstIntersectionOnly) return [other.j - 1, j - 1];
              pairs.set(pairKey, i === other.i ? [i] : [i, other.i]);
            }
          }
          cell.push(segment);
          cells.set(key, cell);
        }
    }
  }
  return firstIntersectionOnly ? null : [...pairs.values()];
}

export function highwayCrossingEdgePairs(edges, edgeIndices) {
  return findCrossings(edges, edgeIndices);
}

export function properHighwayBoundaryIntersection(coordinates) {
  return findCrossings([{ coordinates }], [0], true);
}
import { orient2d } from 'robust-predicates';
