import { boundaryRotationRanks } from './highway-boundary-search.mjs';

// Geometric face traversal deliberately ignores legal road pairings. Keeping
// it separate is essential: a legal traversal through an overpass is not a face.
export function boundaryFaceWalks(
  graph,
  indices,
  ranks = boundaryRotationRanks(graph),
) {
  const outgoing = new Map();
  for (const i of indices)
    for (let r = 0; r < 2; r++) {
      const e = graph.edges[i],
        v = r ? e.toId : e.fromId;
      if (!outgoing.has(v)) outgoing.set(v, []);
      outgoing.get(v).push(2 * i + r);
    }
  const next = new Map();
  for (const row of outgoing.values()) {
    row.sort((a, b) => ranks[a] - ranks[b]);
    for (let j = 0; j < row.length; j++)
      next.set(row[j] ^ 1, row[(j + row.length - 1) % row.length]);
  }
  const seen = new Set(),
    faces = [];
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    let h = start,
      area = 0;
    const cycle = [];
    do {
      if (h === undefined || seen.has(h)) throw new Error('Invalid face successor');
      seen.add(h);
      cycle.push(h);
      area += (h % 2 ? -1 : 1) * graph.edges[h >> 1].area;
      h = next.get(h);
    } while (h !== start);
    faces.push({ cycle, area });
  }
  return faces;
}

// The exterior of a connected graph is a closed walk, not necessarily a
// simple cycle: bridges are retraced and touching loops revisit their joint.
// Extract each loop as soon as its vertex is revisited. The remaining stack
// continues the parent loop, without connecting unrelated pieces of pavement.
export function splitBoundaryLoops(graph, halfedges) {
  if (!halfedges.length) return [];
  const origin = (h) => {
    const edge = graph.edges[h >> 1];
    return h % 2 ? edge.toId : edge.fromId;
  };
  const destination = (h) => origin(h ^ 1);
  const vertices = [origin(halfedges[0])];
  const positions = new Map([[vertices[0], 0]]);
  const pending = [],
    loops = [];
  for (const h of halfedges) {
    if (origin(h) !== vertices.at(-1)) throw Error('Disconnected boundary walk');
    pending.push(h);
    const v = destination(h),
      start = positions.get(v);
    if (start === undefined) {
      positions.set(v, vertices.length);
      vertices.push(v);
      continue;
    }
    const cycle = pending.splice(start);
    const area = cycle.reduce(
      (sum, piece) => sum + (piece % 2 ? -1 : 1) * graph.edges[piece >> 1].area,
      0,
    );
    loops.push({ cycle, area });
    while (vertices.length > start + 1) positions.delete(vertices.pop());
  }
  if (pending.length || vertices.length !== 1) throw Error('Open boundary walk');
  return loops;
}

export function largestBoundaryRegion(graph, halfedges, ranks) {
  const faces = boundaryFaceWalks(
    graph,
    [...new Set(halfedges.map((h) => h >> 1))],
    ranks,
  );
  // GeographicLib's sign is negative for the CCW bounded faces. The exterior
  // walk may contain several touching lobes: never use its sum as the score.
  return faces
    .flatMap((face) => splitBoundaryLoops(graph, face.cycle))
    .reduce(
      (best, face) =>
        face.area < 0 && -face.area > best.area
          ? { area: -face.area, boundary: face.cycle }
          : best,
      { area: 0, boundary: [] },
    );
}
