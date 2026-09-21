import { highwayEdgeUsable, highwayTurnAllowed } from './highway-turns.mjs';
import { firstCircleEntry, lineLength } from './government-connections-geometry.mjs';

export class MinHeap {
  values = [];
  push(value) {
    const a = this.values;
    a.push(value);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].distance <= value.distance) break;
      a[i] = a[p];
      i = p;
    }
    a[i] = value;
  }
  pop() {
    const a = this.values,
      first = a[0],
      last = a.pop();
    if (a.length) {
      let i = 0;
      while (i * 2 + 1 < a.length) {
        let c = i * 2 + 1;
        if (c + 1 < a.length && a[c + 1].distance < a[c].distance) c++;
        if (a[c].distance >= last.distance) break;
        a[i] = a[c];
        i = c;
      }
      a[i] = last;
    }
    return first;
  }
}
export const otherEnd = (edge, node) =>
  edge.fromId === node ? edge.toId : edge.fromId;
export const oriented = (edge, node) =>
  edge.fromId === node ? edge.coordinates : [...edge.coordinates].reverse();
export function adjacency(edges) {
  const incident = new Map();
  edges.forEach((edge, i) => {
    for (const node of [edge.fromId, edge.toId]) {
      if (!incident.has(node)) incident.set(node, []);
      incident.get(node).push(i);
    }
  });
  return incident;
}

// Edge-arrival states preserve the exact circumference turn-port contract.
// No spatial snapping, degree-based U-turns, or cosmetic display filters.
export function shortestCircleRoute({
  edges,
  incident = adjacency(edges),
  starts,
  center,
  forbiddenEdges = new Set(),
}) {
  const heap = new MinHeap(),
    best = new Map();
  const traversals = new Map();
  let winner = null;
  for (const start of starts) {
    let prefixDistance = 0,
      reached = false;
    for (const step of start.seed?.primary?.steps ?? []) {
      const cut = firstCircleEntry(step.coordinates, center);
      if (cut) {
        const distance = prefixDistance + cut.distanceMeters;
        if (!winner || distance < winner.distance)
          winner = { distance, seed: start.seed };
        reached = true;
        break;
      }
      prefixDistance += lineLength(step.coordinates);
    }
    if (!reached)
      heap.push({
        ...start,
        distance: start.distance ?? 0,
        previous: null,
        step: null,
        requiredOutgoing: start.seed?.outgoing,
      });
  }
  while (heap.values.length) {
    const state = heap.pop();
    if (winner && state.distance >= winner.distance) break;
    const key = `${state.node}|${state.incoming}|${state.requiredOutgoing ?? ''}`;
    if ((best.get(key) ?? Infinity) <= state.distance) continue;
    best.set(key, state.distance);
    for (const i of incident.get(state.node) ?? []) {
      const edge = edges[i];
      if (state.requiredOutgoing !== undefined && i !== state.requiredOutgoing)
        continue;
      if (forbiddenEdges.has(i) || !highwayEdgeUsable(edge)) continue;
      if (
        state.incoming !== undefined &&
        !highwayTurnAllowed(edges[state.incoming], edge, state.node)
      )
        continue;
      const traversalKey = `${i}|${state.node}`;
      let traversal = traversals.get(traversalKey);
      if (!traversal) {
        const coordinates = oriented(edge, state.node);
        traversal = { coordinates, entry: firstCircleEntry(coordinates, center) };
        traversals.set(traversalKey, traversal);
      }
      const { coordinates, entry } = traversal;
      if (entry && entry.coordinates.length >= 2) {
        const distance = state.distance + entry.distanceMeters;
        if (!winner || distance < winner.distance)
          winner = {
            distance,
            previous: state,
            step: { edgeIndex: i, fromId: state.node, coordinates: entry.coordinates },
            seed: state.seed,
          };
      }
      const distance = state.distance + (edge.lengthMeters ?? lineLength(coordinates));
      if (winner && distance >= winner.distance) continue;
      heap.push({
        node: otherEnd(edge, state.node),
        incoming: i,
        distance,
        previous: state,
        step: { edgeIndex: i, fromId: state.node, coordinates },
        seed: state.seed,
      });
    }
  }
  if (!winner) return null;
  const steps = [];
  let state = winner;
  while (state) {
    if (state.step) steps.push(state.step);
    state = state.previous;
  }
  return { distanceMeters: winner.distance, steps: steps.reverse(), seed: winner.seed };
}
