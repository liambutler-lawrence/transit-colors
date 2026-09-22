import { createRequire } from 'node:module';
import { signedAreaContributionSquareMeters } from './wgs84-geodesy.mjs';
import { geodesicLineLengthMeters } from '../src/geodesy.ts';
import { biconnectedEdgeBlocks } from './highway-cycle.mjs';
import {
  highwayEdgeUsable,
  highwayTurnAllowed,
  highwayTurnPort,
} from './highway-turns.mjs';
import {
  highwayCrossingEdgePairs,
  properHighwayBoundaryIntersection,
} from './highway-area-crossings.mjs';
import { balancedHighwayAreaCoefficients } from './highway-area-objective.mjs';

const sum = (terms) =>
  terms.map(([c, v]) => `${c < 0 ? '-' : '+'} ${Math.abs(c)} ${v}`).join(' ') || '0';

// Maximize the additive WGS84 signed area of a single simple directed cycle.
// Both orientations of every eligible edge are available. Neither geography,
// road class, connector count, nor distance contributes to the objective.
export async function solveHighwayAreaCycle(
  nodes,
  edges,
  { onIteration = () => {}, timeLimitSeconds = 300, solveModel = null } = {},
) {
  const require = createRequire(import.meta.url);
  const highs = solveModel ? null : await require('highs')();
  const arcs = [],
    incoming = new Map(),
    outgoing = new Map(),
    incident = new Map();
  const add = (map, key, value) => {
    const list = map.get(key) ?? [];
    list.push(value);
    map.set(key, list);
  };
  const usable = [];
  for (const [edgeIndex, edge] of edges.entries()) {
    if (!highwayEdgeUsable(edge)) continue;
    usable.push(edgeIndex);
    const area = signedAreaContributionSquareMeters(edge.coordinates) / 1e6;
    for (const reverse of [false, true]) {
      const arc = {
        index: arcs.length,
        edgeIndex,
        fromId: reverse ? edge.toId : edge.fromId,
        toId: reverse ? edge.fromId : edge.toId,
        reverse,
        area: reverse ? -area : area,
      };
      arcs.push(arc);
      add(outgoing, arc.fromId, arc.index);
      add(incoming, arc.toId, arc.index);
    }
    add(incident, edge.fromId, edgeIndex);
    add(incident, edge.toId, edgeIndex);
  }
  const byEdge = new Map();
  for (const arc of arcs) add(byEdge, arc.edgeIndex, arc.index);
  const x = (i) => `x${i}`;
  const terms = (indices, coefficient = 1) => indices.map((i) => [coefficient, x(i)]);
  const constraints = [];
  for (const node of nodes) {
    const out = outgoing.get(node.id) ?? [],
      inc = incoming.get(node.id) ?? [];
    if (!out.length) continue;
    constraints.push(`${sum([...terms(out), ...terms(inc, -1)])} = 0`);
    constraints.push(`${sum(terms(out))} <= 1`);
    const legs = incident.get(node.id);
    const ports = new Map();
    for (const i of legs) {
      const port = highwayTurnPort(edges[i], node.id);
      if (!port) continue;
      const group = ports.get(port.mainlineId) ?? { positive: [], negative: [] };
      group[port.direction === 1 ? 'positive' : 'negative'].push(i);
      ports.set(port.mainlineId, group);
    }
    for (const group of ports.values())
      for (const [departure, arrival] of [
        [group.positive, group.negative],
        [group.negative, group.positive],
      ]) {
        const leaving = departure.map(
          (i) => byEdge.get(i)[edges[i].fromId === node.id ? 0 : 1],
        );
        const entering = arrival.map(
          (i) => byEdge.get(i)[edges[i].toId === node.id ? 0 : 1],
        );
        constraints.push(`${sum([...terms(leaving), ...terms(entering, -1)])} = 0`);
      }
    for (let i = 0; i < legs.length; i++)
      for (let j = i + 1; j < legs.length; j++) {
        if (!highwayTurnAllowed(edges[legs[i]], edges[legs[j]], node.id))
          constraints.push(
            `${sum(terms([...byEdge.get(legs[i]), ...byEdge.get(legs[j])]))} <= 1`,
          );
      }
  }
  for (const indices of byEdge.values())
    constraints.push(`${sum(terms(indices))} <= 1`);
  const crossingPairs = highwayCrossingEdgePairs(edges, usable);
  for (const pair of crossingPairs) {
    constraints.push(
      `${sum(terms(pair.flatMap((i) => byEdge.get(i))))} <= ${pair.length - 1}`,
    );
  }
  const areaCoefficients = balancedHighwayAreaCoefficients(nodes, arcs);
  const blocks = biconnectedEdgeBlocks(
    nodes,
    usable.map((i) => edges[i]),
  ).map((block) => ({
    edges: block.map((i) => usable[i]),
    // At most one orientation of an edge is selected. Node potentials cancel
    // around a cycle, so this is a conservative area bound for the whole block.
    upperBound: block.reduce(
      (total, i) => total + Math.abs(areaCoefficients[byEdge.get(usable[i])[0]]),
      0,
    ),
  }));
  const cyclicEdges = new Set(blocks.flatMap((block) => block.edges));
  for (const i of usable)
    if (!cyclicEdges.has(i)) constraints.push(`${sum(terms(byEdge.get(i)))} = 0`);
  const prunedBlocks = new Set();
  const objective = sum(arcs.map((a) => [areaCoefficients[a.index], x(a.index)]));
  // A simple ring has winding number at most one at every point. These lazy
  // inequalities stop nested cycle covers from counting the same land twice.
  const rayBands = new Map();
  for (const i of usable) {
    const points = edges[i].coordinates;
    for (let j = 1; j < points.length; j++) {
      const a = points[j - 1],
        b = points[j];
      if (a[1] === b[1]) continue;
      const segment = { i, a, b };
      for (
        let k = Math.floor(Math.min(a[1], b[1]) * 50);
        k <= Math.floor(Math.max(a[1], b[1]) * 50);
        k++
      )
        add(rayBands, k, segment);
    }
  }
  const windingTerms = (point) => {
    const counts = new Map();
    for (const { i, a, b } of rayBands.get(Math.floor(point[1] * 50)) ?? []) {
      if (a[1] > point[1] === b[1] > point[1]) continue;
      const cross = a[0] + ((point[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
      if (cross <= point[0]) continue;
      counts.set(i, (counts.get(i) ?? 0) + (b[1] > a[1] ? 1 : -1));
    }
    return [...counts]
      .filter(([, v]) => v)
      .flatMap(([i, v]) => [
        [v, x(byEdge.get(i)[0])],
        [-v, x(byEdge.get(i)[1])],
      ]);
  };
  const cuts = new Set();
  const windingChecks = new Map();
  let incumbentColumns = null,
    incumbentArea = 0,
    incumbentCycle = null;
  const cut = (expression) => {
    if (cuts.has(expression)) throw new Error('Repeated area-cycle cut');
    cuts.add(expression);
    constraints.push(expression);
  };
  const cutExcessWinding = (point, solution) => {
    const ws = windingTerms(point);
    const value = ws.reduce(
      (n, [c, v]) => n + c * (solution.Columns[v]?.Primal ?? 0),
      0,
    );
    if (Math.abs(value) <= 1.5) return 0;
    const expression = `${sum(ws)} ${value > 0 ? '<= 1' : '>= -1'}`;
    windingChecks.set(expression, ws);
    if (cuts.has(expression)) return 0;
    cut(expression);
    return 1;
  };
  for (let iteration = 1; iteration <= 1000; iteration++) {
    const lp = `Maximize\n area: ${objective}\nSubject To\n${constraints.map((c, i) => ` c${i}: ${c}`).join('\n')}\nBinary\n${arcs.map((a) => x(a.index)).join(' ')}\nEnd`;
    const solution = await (solveModel ?? ((lp, options) => highs.solve(lp, options)))(
      lp,
      {
        mip_rel_gap: 0,
        mip_abs_gap: 1e-6,
        time_limit: timeLimitSeconds,
        presolve: 'on',
      },
      incumbentColumns,
    );
    const provenOptimal = solution.Status === 'Optimal';
    if (!provenOptimal && solution.Status !== 'Time limit reached')
      throw new Error(
        `Area-cycle optimization did not prove optimality: ${solution.Status}`,
      );
    if (
      !solution.Columns ||
      arcs.some((a) => {
        const value = solution.Columns[x(a.index)]?.Primal ?? 0;
        return Math.abs(value - Math.round(value)) > 1e-6;
      })
    )
      throw new Error('Area solver did not return an integer incumbent');
    const selected = arcs.filter((a) => solution.Columns[x(a.index)]?.Primal > 0.5);
    const next = new Map(selected.map((a) => [a.fromId, a]));
    const cycles = [];
    while (next.size) {
      const start = next.keys().next().value,
        steps = [];
      let node = start;
      do {
        const arc = next.get(node);
        if (!arc) throw new Error('Broken area-cycle solution');
        next.delete(node);
        steps.push(arc);
        node = arc.toId;
      } while (node !== start);
      cycles.push(steps);
    }
    cycles.sort(
      (a, b) => b.reduce((n, a) => n + a.area, 0) - a.reduce((n, a) => n + a.area, 0),
    );
    onIteration({
      iteration,
      cycles: cycles.length,
      objectiveSquareKilometers: solution.ObjectiveValue,
      cuts: cuts.size,
    });
    if (!cycles.length) throw new Error('No eligible highway cycle');
    let invalid = false,
      windingCutCount = 0;
    for (const cycle of cycles) {
      const arc = cycle.reduce(
        (best, a) =>
          edges[a.edgeIndex].coordinates.length >
          edges[best.edgeIndex].coordinates.length
            ? a
            : best,
        cycle[0],
      );
      const points = edges[arc.edgeIndex].coordinates,
        a = points[Math.floor((points.length - 1) / 2)],
        b = points[Math.floor((points.length - 1) / 2) + 1];
      const dx = b[0] - a[0],
        dy = b[1] - a[1],
        length = Math.hypot(dx, dy) || 1;
      for (const side of [-1, 1]) {
        const point = [
          (a[0] + b[0]) / 2 + ((side * dy) / length) * 1e-7,
          (a[1] + b[1]) / 2 - ((side * dx) / length) * 1e-7,
        ];
        windingCutCount += cutExcessWinding(point, solution);
      }
    }
    const validGeometryCycles = [];
    for (const cycle of cycles) {
      const coordinates = [],
        owners = [];
      for (const arc of cycle) {
        const points = arc.reverse
          ? [...edges[arc.edgeIndex].coordinates].reverse()
          : edges[arc.edgeIndex].coordinates;
        if (!coordinates.length) coordinates.push(points[0]);
        for (const p of points.slice(1)) {
          coordinates.push(p);
          owners.push(arc.edgeIndex);
        }
      }
      // Boundary-only probes can be evaded by tiny changes to a nested loop.
      // Probe its interior extent too. These are inequalities valid everywhere,
      // not route anchors: no selected road is required to visit these points.
      let west = Infinity,
        south = Infinity,
        east = -Infinity,
        north = -Infinity;
      for (const [longitude, latitude] of coordinates) {
        west = Math.min(west, longitude);
        east = Math.max(east, longitude);
        south = Math.min(south, latitude);
        north = Math.max(north, latitude);
      }
      for (let x = 1; x < 8; x++)
        for (let y = 1; y < 8; y++)
          windingCutCount += cutExcessWinding(
            [west + ((east - west) * x) / 8, south + ((north - south) * y) / 8],
            solution,
          );
      const crossing = properHighwayBoundaryIntersection(coordinates);
      if (crossing) {
        const edgeIndices = [...new Set(crossing.map((i) => owners[i]))];
        cut(
          `${sum(terms(edgeIndices.flatMap((i) => byEdge.get(i))))} <= ${edgeIndices.length - 1}`,
        );
        invalid = true;
      } else {
        const area = signedAreaContributionSquareMeters(coordinates);
        validGeometryCycles.push({ cycle, area });
      }
    }
    if (incumbentCycle)
      validGeometryCycles.push({ cycle: incumbentCycle, area: incumbentArea });
    incumbentArea = 0;
    incumbentCycle = null;
    incumbentColumns = null;
    for (const { cycle, area } of validGeometryCycles.sort((a, b) => b.area - a.area)) {
      if (area <= 0) continue;
      const selectedColumns = new Set(cycle.map((a) => x(a.index)));
      if (
        [...windingChecks.values()].some(
          (ws) =>
            Math.abs(
              ws.reduce((n, [c, v]) => n + (selectedColumns.has(v) ? c : 0), 0),
            ) > 1,
        )
      )
        continue;
      incumbentArea = area;
      incumbentCycle = cycle;
      incumbentColumns = Object.fromEntries(
        cycle.map((a) => [x(a.index), { Primal: 1 }]),
      );
      break;
    }
    // Zero-area cycles can remain in an optimal relaxation. A validated single
    // cycle attaining that same upper bound is already an optimal solution;
    // retaining or branching on those extra cycles would not improve its area.
    if (
      provenOptimal &&
      incumbentCycle &&
      Math.abs(incumbentArea - solution.ObjectiveValue * 1e6) <= 1
    ) {
      cycles.splice(0, cycles.length, incumbentCycle);
      invalid = false;
      windingCutCount = 0;
    }
    for (const block of blocks) {
      // Every simple cycle belongs to one biconnected block. Once a verified
      // cycle beats a block's entire upper bound, that block cannot win.
      if (!prunedBlocks.has(block) && block.upperBound * 1e6 + 1 < incumbentArea) {
        prunedBlocks.add(block);
        for (const i of block.edges)
          constraints.push(`${sum(terms(byEdge.get(i)))} = 0`);
      }
    }
    if (cycles.length > 1) {
      // Conditional connectivity cuts do not choose a geographic root or ban a
      // component from being the entire solution in a subsequent iteration.
      const representatives = [
        ...new Set(
          Array.from(
            { length: 4 },
            (_, i) => cycles[0][Math.floor((i * cycles[0].length) / 4)].fromId,
          ),
        ),
      ];
      for (const cycle of cycles.slice(1)) {
        const members = new Set(cycle.map((a) => a.fromId));
        const exits = arcs
          .filter((a) => members.has(a.fromId) && !members.has(a.toId))
          .map((a) => a.index);
        for (const representative of representatives) {
          const expression = `${sum([...terms(outgoing.get(cycle[0].fromId)), ...terms(outgoing.get(representative)), ...terms(exits, -1)])} <= 1`;
          if (!cuts.has(expression)) cut(expression);
        }
      }
      continue;
    }
    if (invalid || windingCutCount) continue;
    if (!provenOptimal)
      throw new Error(
        'A valid area cycle was found, but its maximum area is not yet proven',
      );
    const segments = cycles[0].map((a) => ({
      edgeIndex: a.edgeIndex,
      fromId: a.fromId,
      toId: a.toId,
      partIndices: edges[a.edgeIndex].partIndices,
      coordinates: a.reverse
        ? [...edges[a.edgeIndex].coordinates].reverse()
        : edges[a.edgeIndex].coordinates,
    }));
    const coordinates = segments.flatMap((s, i) =>
      i ? s.coordinates.slice(1) : s.coordinates,
    );
    return {
      segments,
      coordinates,
      areaSquareMeters: Math.abs(signedAreaContributionSquareMeters(coordinates)),
      lengthMeters: geodesicLineLengthMeters(coordinates),
      optimizationIterations: iteration,
      biconnectedBlockCount: blocks.length,
      optimizationStatus: 'optimal',
      objectiveUpperBoundSquareMeters: solution.ObjectiveValue * 1e6,
    };
  }
  throw new Error('Area-cycle cut limit reached without an optimal simple cycle');
}
