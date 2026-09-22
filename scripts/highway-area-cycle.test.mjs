import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { solveHighwayAreaCycle } from './highway-area-cycle.mjs';
import {
  highwayCrossingEdgePairs,
  properHighwayBoundaryIntersection,
} from './highway-area-crossings.mjs';
import { signedAreaContributionSquareMeters } from './wgs84-geodesy.mjs';
import { serialize, deserialize } from 'node:v8';
import { highwayAreaGraphDigest } from './highway-area-cache.mjs';

function network(points, pairs) {
  const nodes = Object.entries(points).map(([id, coordinate]) => ({ id, coordinate }));
  const edges = pairs.map(([fromId, toId], i) => ({
    fromId,
    toId,
    coordinates: [points[fromId], points[toId]],
    partIndices: new Set([i]),
  }));
  return { nodes, edges };
}

test('area cache hashes graph values consistently across disk serialization', () => {
  const graph = network({ A: [1.25, 2.5], B: [2, 3] }, [['A', 'B']]);
  assert.equal(
    highwayAreaGraphDigest(graph),
    highwayAreaGraphDigest(deserialize(serialize(graph))),
  );
  const changed = deserialize(serialize(graph));
  changed.edges[0].coordinates[1][0] += 0.01;
  assert.notEqual(highwayAreaGraphDigest(graph), highwayAreaGraphDigest(changed));
});

test('area objective chooses the larger loop regardless of extra connectors and length', async () => {
  const { nodes, edges } = network(
    { A: [0, 0], B: [1, 0], C: [1, 1], D: [0, 1], E: [3, 0], F: [3, 1] },
    [
      ['A', 'B'],
      ['B', 'C'],
      ['C', 'D'],
      ['D', 'A'],
      ['B', 'E'],
      ['E', 'F'],
      ['F', 'C'],
    ],
  );
  for (const edge of edges.slice(4)) {
    edge.role = 'connector';
    edge.routingPenaltyMeters = 1e12;
  }
  edges[4].coordinates.splice(1, 0, [1.4, -0.15], [2.1, -0.22], [2.7, -0.1]);
  const result = await solveHighwayAreaCycle(nodes, edges);
  assert.deepEqual(
    new Set(result.segments.map((s) => s.edgeIndex)),
    new Set([0, 2, 3, 4, 5, 6]),
  );
  for (const s of result.segments)
    assert.deepEqual(
      s.coordinates,
      s.fromId === edges[s.edgeIndex].fromId
        ? edges[s.edgeIndex].coordinates
        : [...edges[s.edgeIndex].coordinates].reverse(),
    );
});

test('disconnected cycles cannot be summed and no fixed geographic root is imposed', async () => {
  const { nodes, edges } = network(
    {
      A: [0, 0],
      B: [1, 0],
      C: [1, 1],
      D: [0, 1],
      E: [10, 0],
      F: [13, 0],
      G: [13, 3],
      H: [10, 3],
    },
    [
      ['A', 'B'],
      ['B', 'C'],
      ['C', 'D'],
      ['D', 'A'],
      ['E', 'F'],
      ['F', 'G'],
      ['G', 'H'],
      ['H', 'E'],
    ],
  );
  const result = await solveHighwayAreaCycle(nodes, edges);
  assert.deepEqual(
    new Set(result.segments.map((s) => s.edgeIndex)),
    new Set([4, 5, 6, 7]),
  );
});

test('larger geometrical cycle cannot use an illegal merge turn', async () => {
  const { nodes, edges } = network(
    { A: [0, 0], B: [1, 0], C: [1, 1], D: [0, 1], E: [3, 0], F: [3, 1] },
    [
      ['A', 'B'],
      ['B', 'C'],
      ['C', 'D'],
      ['D', 'A'],
      ['B', 'E'],
      ['E', 'F'],
      ['F', 'C'],
    ],
  );
  edges[0].toTurnPort = { mainlineId: 'road', direction: 1 };
  edges[1].fromTurnPort = { mainlineId: 'road', direction: -1 };
  edges[4].fromTurnPort = { mainlineId: 'road', direction: 1 };
  const result = await solveHighwayAreaCycle(nodes, edges);
  assert.ok(
    !result.segments.some((s) => s.edgeIndex === 0) ||
      !result.segments.some((s) => s.edgeIndex === 4),
  );
});

test('nested cycles cannot count the same enclosed area twice', async () => {
  const { nodes, edges } = network(
    {
      A: [0, 0],
      B: [4, 0],
      C: [4, 4],
      D: [0, 4],
      E: [1, 1],
      F: [2, 1],
      G: [2, 2],
      H: [1, 2],
    },
    [
      ['A', 'B'],
      ['B', 'C'],
      ['C', 'D'],
      ['D', 'A'],
      ['E', 'F'],
      ['F', 'G'],
      ['G', 'H'],
      ['H', 'E'],
    ],
  );
  const result = await solveHighwayAreaCycle(nodes, edges);
  assert.deepEqual(
    new Set(result.segments.map((s) => s.edgeIndex)),
    new Set([0, 1, 2, 3]),
  );
  assert.ok(result.optimizationIterations > 1);
  assert.ok(
    Math.abs(result.areaSquareMeters - result.objectiveUpperBoundSquareMeters) < 1,
  );
});

test('an optimal single loop need not retain zero-area extra cycles', async () => {
  const { nodes, edges } = network(
    { A: [0, 0], B: [1, 0], C: [1, 1], D: [0, 1], E: [5, 0], F: [6, 0] },
    [
      ['A', 'B'],
      ['B', 'C'],
      ['C', 'D'],
      ['D', 'A'],
      ['E', 'F'],
      ['E', 'F'],
    ],
  );
  const ring = edges.slice(0, 4).map((e) => e.coordinates[0]);
  ring.push(ring[0]);
  const area = signedAreaContributionSquareMeters(ring);
  const selected = [0, 1, 2, 3].map((i) => 2 * i + (area < 0 ? 1 : 0));
  let calls = 0;
  const result = await solveHighwayAreaCycle(nodes, edges, {
    solveModel: async () => {
      assert.equal(++calls, 1);
      return {
        Status: 'Optimal',
        ObjectiveValue: Math.abs(area) / 1e6,
        Columns: Object.fromEntries(
          [...selected, 8, 11].map((i) => [`x${i}`, { Primal: 1 }]),
        ),
      };
    },
  });
  assert.equal(result.segments.length, 4);
  assert.equal(result.optimizationStatus, 'optimal');
});

test('grade-separated geometric crossings constrain selection without creating junctions', () => {
  const { edges } = network({ A: [0, 0], B: [2, 2], C: [0, 2], D: [2, 0], E: [3, 0] }, [
    ['A', 'B'],
    ['C', 'D'],
    ['D', 'E'],
  ]);
  assert.deepEqual(highwayCrossingEdgePairs(edges, [0, 1, 2]), [[1, 0]]);
  assert.equal(edges.length, 3);
  assert.deepEqual(edges[0].coordinates, [
    [0, 0],
    [2, 2],
  ]);
});

test('short crossing segments cannot slip through a length-dependent tolerance', () => {
  const a = [-73.8375663, 40.8289701];
  const b = [-73.8379503, 40.8289674];
  const c = [-73.8379143, 40.8289696];
  const d = [-73.8377557, 40.8289648];
  assert.deepEqual(
    highwayCrossingEdgePairs(
      [{ coordinates: [a, b] }, { coordinates: [c, d] }],
      [0, 1],
    ),
    [[1, 0]],
  );
  assert.deepEqual(properHighwayBoundaryIntersection([a, b, c, d, a]), [0, 2]);
});

test('a self-crossing edge is excluded without smoothing or clipping it', async () => {
  const { nodes, edges } = network({ A: [0, 0], B: [4, 0], C: [4, 4], D: [0, 4] }, [
    ['A', 'B'],
    ['B', 'C'],
    ['C', 'D'],
    ['D', 'A'],
    ['B', 'C'],
  ]);
  edges[4].coordinates = [
    [4, 0],
    [8, 4],
    [4, 2],
    [8, 0],
    [4, 4],
  ];
  const original = structuredClone(edges[4].coordinates);
  const result = await solveHighwayAreaCycle(nodes, edges);
  assert.deepEqual(
    new Set(result.segments.map((s) => s.edgeIndex)),
    new Set([0, 1, 2, 3]),
  );
  assert.deepEqual(edges[4].coordinates, original);
});

test('a timed-out feasible loop is not reported as a proven maximum', async () => {
  const { nodes, edges } = network({ A: [0, 0], B: [1, 0], C: [1, 1], D: [0, 1] }, [
    ['A', 'B'],
    ['B', 'C'],
    ['C', 'D'],
    ['D', 'A'],
  ]);
  const highs = await createRequire(import.meta.url)('highs')();
  await assert.rejects(
    solveHighwayAreaCycle(nodes, edges, {
      solveModel: (lp, options) => ({
        ...highs.solve(lp, options),
        Status: 'Time limit reached',
      }),
    }),
    /maximum area is not yet proven/,
  );
});
