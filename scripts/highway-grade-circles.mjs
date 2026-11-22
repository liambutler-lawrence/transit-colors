import { roadGradeMask, ROAD_GRADES } from '../src/circumference/grades.ts';
import { solveHighwayAreaCycle } from './highway-area-cycle.mjs';
import { biconnectedEdgeBlocks } from './highway-cycle.mjs';
import {
  highwayCycleTurnViolation,
  highwayEdgeUsable,
  highwayTurnAllowed,
} from './highway-turns.mjs';

function routingGraph(network) {
  const nodes = [...network.nodes];
  const edges = network.edges
    .flatMap((edge) => {
      if ((!edge.review.grade && !edge.review.junction) || edge.invalidTurn) return [];
      if (edge.fromId !== edge.toId) return [edge];
      const middle = Math.floor(edge.coordinates.length / 2);
      if (middle < 2) return [];
      // The integer model needs distinct endpoints. The two arcs retain the
      // review and display identity of the original closed road segment.
      const id = `closed-corridor:${edge.id}`;
      nodes.push({ id, coordinate: edge.coordinates[middle] });
      return [
        {
          ...edge,
          toId: id,
          toTurnPort: undefined,
          coordinates: edge.coordinates.slice(0, middle + 1),
        },
        {
          ...edge,
          fromId: id,
          fromTurnPort: undefined,
          coordinates: edge.coordinates.slice(middle),
        },
      ];
    })
    .filter(highwayEdgeUsable);
  return { nodes, edges };
}

function eligibleCycleEdges(nodes, edges) {
  const incident = new Map();
  for (const [index, edge] of edges.entries()) {
    for (const node of [edge.fromId, edge.toId]) {
      const legs = incident.get(node) ?? new Set();
      legs.add(index);
      incident.set(node, legs);
    }
  }
  const pending = edges.map((_, index) => index);
  while (pending.length) {
    const index = pending.pop();
    const edge = edges[index];
    const ends = [edge.fromId, edge.toId];
    if (!incident.get(edge.fromId).has(index)) continue;
    const deadEnd = ends.some(
      (node) =>
        ![...incident.get(node)].some((other) =>
          highwayTurnAllowed(edge, edges[other], node),
        ),
    );
    if (!deadEnd) continue;
    for (const node of ends) {
      const legs = incident.get(node);
      legs.delete(index);
      for (const neighbor of legs) pending.push(neighbor);
    }
  }
  const reduced = edges.filter((edge, index) => incident.get(edge.fromId).has(index));
  const cyclic = new Set(biconnectedEdgeBlocks(nodes, reduced).flat());
  return reduced.filter((_, index) => cyclic.has(index));
}

export async function solveHighwayGradeCircles(
  network,
  { onSolve = () => {}, ...options } = {},
) {
  const { nodes, edges } = routingGraph(network);
  const present = roadGradeMask(edges.map(({ review }) => review.grade));
  const selections = Array(1 << ROAD_GRADES.length).fill(null);
  const circles = [];
  const solved = new Map();
  for (let mask = present; mask > 0; mask = (mask - 1) & present) {
    const inherited = [...solved.keys()].find((superset) => {
      if ((mask & superset) !== mask) return false;
      const circle = solved.get(superset);
      return !circle || (mask & circle.gradeMask) === circle.gradeMask;
    });
    if (inherited !== undefined) {
      solved.set(mask, solved.get(inherited));
      continue;
    }
    const eligible = eligibleCycleEdges(
      nodes,
      edges.filter(
        ({ review }) => review.junction || (mask & roadGradeMask([review.grade])) !== 0,
      ),
    );
    onSolve({ mask, eligible: eligible.length });
    if (!eligible.length) {
      solved.set(mask, null);
      continue;
    }
    const exact = await solveHighwayAreaCycle(nodes, eligible, {
      ...options,
      allowEmpty: true,
    });
    if (!exact || exact.areaSquareMeters <= 1) {
      solved.set(mask, null);
      continue;
    }
    if (highwayCycleTurnViolation(exact.segments, eligible)) {
      throw new Error('A graded road circle contains a forbidden interchange turn.');
    }
    const routeEdges = exact.segments.map(({ edgeIndex }) => eligible[edgeIndex]);
    const segments = routeEdges.filter(({ review }) => !review.junction);
    const routeGrades = new Set(segments.map(({ review }) => review.grade));
    const grades = ROAD_GRADES.filter((grade) => routeGrades.has(grade));
    const circle = {
      id: String(circles.length + 1),
      edgeIds: [...new Set(segments.map(({ id }) => id))],
      grades,
      gradeMask: roadGradeMask(grades),
      areaSquareMeters: exact.areaSquareMeters,
      lengthMeters: exact.lengthMeters,
      coordinates: exact.coordinates,
    };
    circles.push(circle);
    solved.set(mask, circle);
  }
  for (const mask of selections.keys()) {
    selections[mask] = solved.get(mask & present)?.id ?? null;
  }
  return { circles, selections };
}
