import { matchBoundaryCorridors } from './government-connections-boundary.mjs';
import { highwayTurnAllowed, highwayTurnPort } from './highway-turns.mjs';
import { adjacency, otherEnd } from './government-connections-routing.mjs';
import { lineLength } from './government-connections-geometry.mjs';
export const coordinateKey = (p) => p.map((v) => v.toFixed(7)).join(',');
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function connectionNetwork(graph, route, detailedParts = []) {
  const { boundary, selectedCorridorCount } = matchBoundaryCorridors(graph, route);
  const routeAtoms = new Map();
  for (let i = 1; i < route.coordinates.length; i++) {
    const a = coordinateKey(route.coordinates[i - 1]),
      b = coordinateKey(route.coordinates[i]);
    if (a !== b) routeAtoms.set(pairKey(a, b), { index: i - 1, from: a, to: b });
  }
  const coordinateKeys = new Map(
    [...graph.coordinateByNodeId].map(([id, p]) => [id, coordinateKey(p)]),
  );
  const covered = new Set();
  const edges = graph.edges.map((edge, index) => {
    const a = coordinateKeys.get(edge.fromId),
      b = coordinateKeys.get(edge.toId);
    const atom = routeAtoms.get(pairKey(a, b));
    if (atom) covered.add(atom.index);
    const roles = [...edge.partIndices].map((i) => graph.parts[i].role);
    return {
      ...edge,
      index,
      boundary: boundary.has(index),
      boundaryIndex: boundary.get(index)?.segmentIndex,
      boundaryForward: boundary.get(index)?.forward,
      role: roles.includes('mainline') ? 'mainline' : 'connector',
    };
  });
  const incident = adjacency(edges);
  const junctions = new Set(
    [...incident]
      .filter(
        ([, ids]) =>
          ids.length !== 2 ||
          edges[ids[0]].role !== edges[ids[1]].role ||
          edges[ids[0]].boundary !== edges[ids[1]].boundary,
      )
      .map(([id]) => id),
  );
  const visited = new Set(),
    corridors = [];
  function walk(start, initial) {
    const points = [graph.coordinateByNodeId.get(start)],
      rawIndices = [],
      partIndices = new Set();
    let node = start,
      index = initial,
      previous = null,
      invalidTurn = false;
    while (true) {
      const edge = edges[index];
      visited.add(index);
      rawIndices.push(index);
      for (const p of edge.partIndices) partIndices.add(p);
      if (previous && !highwayTurnAllowed(previous, edge, node)) invalidTurn = true;
      node = otherEnd(edge, node);
      points.push(graph.coordinateByNodeId.get(node));
      if (junctions.has(node)) break;
      const next = (incident.get(node) ?? []).find((i) => i !== index);
      if (next === undefined || visited.has(next)) break;
      previous = edge;
      index = next;
    }
    corridors.push({
      fromId: start,
      toId: node,
      coordinates: points,
      rawIndices,
      partIndices: [...partIndices],
      role: edges[initial].role,
      boundary: edges[initial].boundary,
      fromTurnPort: highwayTurnPort(edges[initial], start),
      toTurnPort: highwayTurnPort(edges[index], node),
      invalidTurn,
      lengthMeters: lineLength(points),
    });
  }
  for (const node of junctions)
    for (const i of incident.get(node)) if (!visited.has(i)) walk(node, i);
  for (let i = 0; i < edges.length; i++)
    if (!visited.has(i)) {
      junctions.add(edges[i].fromId);
      walk(edges[i].fromId, i);
    }
  const continuations = new Set(
    detailedParts
      .filter(
        (part) =>
          part.role === 'connector' && (part.throughMainline || part.mixedMainline),
      )
      .map((part) => part.id),
  );
  for (const edge of corridors)
    edge.mainlineContinuation =
      edge.role === 'connector' &&
      edge.partIndices.every((index) => continuations.has(graph.parts[index].id));
  const boundaryDegree = new Map();
  for (const edge of corridors)
    if (edge.boundary)
      for (const node of [edge.fromId, edge.toId])
        boundaryDegree.set(node, (boundaryDegree.get(node) ?? 0) + 1);
  const boundaryJunctionAnomalies = [...boundaryDegree].filter(
    ([, degree]) => degree !== 2,
  );
  const missing = [...routeAtoms.values()].filter((a) => !covered.has(a.index));
  return {
    edges: corridors,
    parts: graph.parts,
    routeMatch: {
      atomCount: routeAtoms.size,
      matchedAtoms: covered.size,
      missing,
      boundaryJunctionAnomalies,
      selectedCorridorCount,
    },
    rawEdges: edges,
  };
}
