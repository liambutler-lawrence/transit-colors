import { highwayEdgeUsable, highwayTurnAllowed } from './highway-turns.mjs';
import {
  adjacency,
  otherEnd,
  oriented,
  MinHeap,
} from './government-connections-routing.mjs';

// Discover both approaches in source topology, before any display simplification.
// The search stays within a single mainline/connector junction: after the first
// ramp corridor it may only continue along the receiving mainline. It cannot
// leave for a second interchange to manufacture access to the opposite side.
export function interchangeApproaches(
  network,
  { maximumJoinSpanMeters = 10000, maximumBoundarySpanMeters = 20000 } = {},
) {
  const { edges, rawEdges } = network,
    incident = adjacency(edges),
    seeds = [];
  const boundaryEdges = new Set(edges.flatMap((e, i) => (e.boundary ? [i] : [])));
  const boundaryNodes = new Set(
    [...boundaryEdges].flatMap((i) => [edges[i].fromId, edges[i].toId]),
  );
  for (const node of boundaryNodes) {
    const boundary = (incident.get(node) ?? []).filter((i) => boundaryEdges.has(i));
    if (boundary.length !== 2) continue;
    for (const exit of (incident.get(node) ?? []).filter(
      (i) => !boundaryEdges.has(i),
    )) {
      const edge = edges[exit];
      if (!highwayEdgeUsable(edge)) continue;
      for (const incoming of boundary) {
        if (!highwayTurnAllowed(edges[incoming], edge, node)) continue;
        const bound = edges[incoming];
        const rawIndex =
          bound.fromId === node ? bound.rawIndices[0] : bound.rawIndices.at(-1);
        const atom = rawEdges[rawIndex];
        const towardNode = atom.toId === node;
        const direction = towardNode === atom.boundaryForward ? 1 : -1;
        seeds.push({
          id: seeds.length,
          node,
          incoming,
          exit,
          direction,
          boundaryIndex: atom.boundaryIndex,
        });
      }
    }
  }
  const arrivals = new Map();
  for (const seed of seeds) {
    const edge = edges[seed.exit],
      next = otherEnd(edge, seed.node);
    const heap = new MinHeap(),
      best = new Map();
    heap.push({
      node: next,
      incoming: seed.exit,
      distance: edge.lengthMeters,
      continuation: 0,
      steps: [
        {
          edgeIndex: seed.exit,
          fromId: seed.node,
          coordinates: oriented(edge, seed.node),
        },
      ],
      seed,
    });
    while (heap.values.length) {
      const state = heap.pop(),
        key = `${state.node}|${state.incoming}`;
      if ((best.get(key) ?? Infinity) <= state.distance) continue;
      best.set(key, state.distance);
      if (boundaryNodes.has(state.node)) continue;
      for (const i of incident.get(state.node) ?? []) {
        const outgoing = edges[i];
        if (
          outgoing.boundary ||
          (outgoing.role !== 'mainline' && !outgoing.mainlineContinuation) ||
          !highwayEdgeUsable(outgoing) ||
          !highwayTurnAllowed(edges[state.incoming], outgoing, state.node)
        )
          continue;
        if (outgoing.role === 'mainline') {
          const departure = `${state.node}|${i}`;
          const list = arrivals.get(departure) ?? [];
          list.push({ ...state, outgoing: i });
          arrivals.set(departure, list);
        }
        const continuation = state.continuation + outgoing.lengthMeters;
        if (continuation > maximumJoinSpanMeters) continue;
        heap.push({
          ...state,
          node: otherEnd(outgoing, state.node),
          incoming: i,
          distance: state.distance + outgoing.lengthMeters,
          continuation,
          steps: [
            ...state.steps,
            {
              edgeIndex: i,
              fromId: state.node,
              coordinates: oriented(outgoing, state.node),
            },
          ],
        });
      }
    }
  }
  const starts = [];
  for (const list of arrivals.values()) {
    list.sort((a, b) => a.distance - b.distance);
    for (const a of list) {
      const b = list.find(
        (b) =>
          b.seed.direction === -a.seed.direction &&
          b.seed.exit !== a.seed.exit &&
          b.incoming !== a.incoming &&
          sameBoundaryInterchangeSpan(
            a.seed,
            b.seed,
            edges,
            incident,
            maximumBoundarySpanMeters,
          ),
      );
      if (!b) continue;
      // At least one distinct reciprocal ramp must prove the freeway change;
      // two arbitrary arms of an unported mainline crossing are insufficient.
      if (
        ![...a.steps, ...b.steps].some((s) => edges[s.edgeIndex].role === 'connector')
      )
        continue;
      starts.push({
        node: a.node,
        incoming: a.incoming,
        distance: a.distance,
        seed: { primary: a, secondary: b, outgoing: a.outgoing },
      });
    }
  }
  return { starts, seeds, boundaryEdges };
}

function sameBoundaryInterchangeSpan(a, b, edges, incident, maximumBoundarySpanMeters) {
  // Allow the circumference itself to turn through this interchange: a
  // capital branch can use one straight mainline approach and one ramp pair.
  // Traversing multiple boundary interchanges cannot establish local access.
  const pending = [{ node: a.node, previous: -1, distance: 0, connectors: 0 }],
    seen = new Set();
  while (pending.length) {
    const state = pending.pop();
    if (seen.has(state.node) || state.distance > maximumBoundarySpanMeters) continue;
    if (state.node === b.node) return true;
    seen.add(state.node);
    for (const i of incident.get(state.node) ?? []) {
      const e = edges[i];
      if (i === state.previous || !e.boundary) continue;
      const connectors = state.connectors + (e.role === 'connector' ? 1 : 0);
      if (connectors > 1) continue;
      pending.push({
        node: otherEnd(e, state.node),
        previous: i,
        distance: state.distance + e.lengthMeters,
        connectors,
      });
    }
  }
  return false;
}
