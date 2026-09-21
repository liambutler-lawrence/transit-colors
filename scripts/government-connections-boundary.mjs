import { compressHighwayCore, highwayTwoCore } from './highway-graph.mjs';
import { highwayTurnAllowed, highwayEdgeUsable } from './highway-turns.mjs';
const key = (p) => p.map((v) => v.toFixed(7)).join(',');
const atom = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// Display junction clipping can trim an edge without changing its topology.
// Recover whole source corridors, then require their IDs and turn ports to form
// the published ordered cycle. Coincident geometry cannot add boundary branches.
export function matchBoundaryCorridors(graph, route) {
  const core = highwayTwoCore(new Set(graph.coordinateByNodeId.keys()), graph.edges);
  const compressed = compressHighwayCore(graph.coordinateByNodeId, graph.edges, core, {
    includeSourceEdges: true,
  });
  const owners = new Map();
  route.segments.forEach((segment, i) => {
    for (let j = 1; j < segment.coordinates.length; j++) {
      const a = key(segment.coordinates[j - 1]),
        b = key(segment.coordinates[j]);
      if (a === b) continue;
      const k = atom(a, b),
        entries = owners.get(k) ?? new Set();
      entries.add(i);
      owners.set(k, entries);
    }
  });
  const scores = route.segments.map(() => new Map());
  compressed.edges.forEach((edge, i) => {
    if (!highwayEdgeUsable(edge)) return;
    for (let j = 1; j < edge.coordinates.length; j++) {
      const a = key(edge.coordinates[j - 1]),
        b = key(edge.coordinates[j]);
      if (a === b) continue;
      for (const owner of owners.get(atom(a, b)) ?? [])
        scores[owner].set(i, (scores[owner].get(i) ?? 0) + 1);
    }
  });
  const unmatchedVertices = new Map();
  scores.forEach((score, i) => {
    if (score.size) return;
    for (const p of route.segments[i].coordinates) {
      const k = key(p),
        entries = unmatchedVertices.get(k) ?? new Set();
      entries.add(i);
      unmatchedVertices.set(k, entries);
    }
  });
  if (unmatchedVertices.size)
    compressed.edges.forEach((edge, i) => {
      if (!highwayEdgeUsable(edge)) return;
      for (const coordinate of edge.coordinates)
        for (const owner of unmatchedVertices.get(key(coordinate)) ?? [])
          scores[owner].set(i, 0.01);
    });
  const candidates = scores.map((s, i) => {
    if (!s.size)
      throw new Error(`No source corridor matches circumference segment ${i}`);
    return [...s]
      .sort((a, b) => b[1] - a[1])
      .map(([edgeIndex, score]) => ({ edgeIndex, score }));
  });
  let winner = null;
  for (const first of candidates[0])
    for (const forward of [true, false]) {
      const edge = compressed.edges[first.edgeIndex],
        fromId = forward ? edge.fromId : edge.toId,
        toId = forward ? edge.toId : edge.fromId;
      let states = [
        { step: { ...first, fromId, toId }, score: first.score, previous: null },
      ];
      for (let i = 1; i < candidates.length && states.length; i++) {
        const next = new Map();
        for (const state of states)
          for (const candidate of candidates[i]) {
            const e = compressed.edges[candidate.edgeIndex],
              node = state.step.toId;
            if (e.fromId !== node && e.toId !== node) continue;
            if (!highwayTurnAllowed(compressed.edges[state.step.edgeIndex], e, node))
              continue;
            const toId = e.fromId === node ? e.toId : e.fromId;
            const score = state.score + candidate.score,
              k = `${candidate.edgeIndex}|${toId}`;
            if ((next.get(k)?.score ?? -Infinity) >= score) continue;
            next.set(k, {
              step: { ...candidate, fromId: node, toId },
              score,
              previous: state,
            });
          }
        states = [...next.values()];
      }
      for (const state of states)
        if (
          state.step.toId === fromId &&
          highwayTurnAllowed(compressed.edges[state.step.edgeIndex], edge, fromId) &&
          (!winner || state.score > winner.score)
        )
          winner = state;
    }
  if (!winner)
    throw new Error(
      'Matched circumference corridors do not form a legal source-topology cycle',
    );
  const steps = [];
  for (let state = winner; state; state = state.previous) steps.push(state.step);
  steps.reverse();
  const boundary = new Map();
  for (const [segmentIndex, step] of steps.entries()) {
    const corridor = compressed.edges[step.edgeIndex];
    const indices =
      step.fromId === corridor.fromId
        ? corridor.sourceEdgeIndices
        : [...corridor.sourceEdgeIndices].reverse();
    let node = step.fromId;
    for (const index of indices) {
      if (boundary.has(index)) throw new Error('Circumference repeats a source edge');
      const edge = graph.edges[index],
        forward = edge.fromId === node;
      boundary.set(index, { segmentIndex, forward });
      node = forward ? edge.toId : edge.fromId;
    }
  }
  return { boundary, selectedCorridorCount: steps.length };
}
