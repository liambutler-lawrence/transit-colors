import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clippedHighwayJunctionCoordinates,
  loopErasedHighwayCoordinates,
  northAmericanHighwayEnvelopeSupportNodeIds,
  refineHighwayCycleThroughWaypoints,
} from './highway-envelope-cycle.mjs';
import { hasProperSelfIntersection } from './highway-cycle.mjs';

function edge(coordinatesById, fromId, toId, edgeIndex) {
  return {
    coordinates: [coordinatesById[fromId], coordinatesById[toId]],
    fromId,
    partIndices: new Set([edgeIndex]),
    toId,
  };
}

test('outer-envelope ear expands a seed without inventing graph junctions', () => {
  const coordinatesById = {
    A: [0, 0],
    B: [4, 0],
    C: [4, 4],
    D: [0, 4],
    E: [6, 6],
    F: [6, -2],
  };
  const nodes = Object.entries(coordinatesById).map(([id, coordinate]) => ({
    coordinate,
    id,
  }));
  const endpointPairs = [
    ['A', 'B'],
    ['B', 'C'],
    ['C', 'D'],
    ['D', 'A'],
    ['C', 'E'],
    ['E', 'F'],
    ['F', 'B'],
  ];
  const edges = endpointPairs.map(([fromId, toId], edgeIndex) =>
    edge(coordinatesById, fromId, toId, edgeIndex),
  );
  const seedSegments = edges.slice(0, 4).map((sourceEdge, edgeIndex) => ({
    coordinates: sourceEdge.coordinates,
    edgeIndex,
    partIndices: sourceEdge.partIndices,
  }));

  const result = refineHighwayCycleThroughWaypoints(nodes, edges, seedSegments, [
    'E',
    'F',
  ]);

  assert.deepEqual(new Set(result.supportNodeIds), new Set(['E', 'F']));
  assert.ok(result.segments.some((segment) => segment.edgeIndex === 4));
  assert.ok(result.segments.some((segment) => segment.edgeIndex === 5));
  assert.ok(result.segments.some((segment) => segment.edgeIndex === 6));
  assert.ok(!result.segments.some((segment) => segment.edgeIndex === 1));
  assert.deepEqual(result.coordinates[0], result.coordinates.at(-1));
});

test('an expanded envelope remains a graph cycle for subsequent refinements', () => {
  const coordinatesById = {
    A: [0, 0],
    B: [4, 0],
    C: [4, 4],
    D: [0, 4],
    E: [6, 6],
    F: [6, -2],
    G: [-2, 6],
    H: [-2, -2],
  };
  const nodes = Object.entries(coordinatesById).map(([id, coordinate]) => ({
    coordinate,
    id,
  }));
  const endpointPairs = [
    ['A', 'B'],
    ['B', 'C'],
    ['C', 'D'],
    ['D', 'A'],
    ['C', 'E'],
    ['E', 'F'],
    ['F', 'B'],
    ['D', 'G'],
    ['G', 'H'],
    ['H', 'A'],
  ];
  const edges = endpointPairs.map(([fromId, toId], edgeIndex) =>
    edge(coordinatesById, fromId, toId, edgeIndex),
  );
  const seedSegments = edges.slice(0, 4).map((sourceEdge, edgeIndex) => ({
    coordinates: sourceEdge.coordinates,
    edgeIndex,
    partIndices: sourceEdge.partIndices,
  }));

  const east = refineHighwayCycleThroughWaypoints(nodes, edges, seedSegments, [
    'E',
    'F',
  ]);
  const bothSides = refineHighwayCycleThroughWaypoints(nodes, edges, east.segments, [
    'G',
    'H',
  ]);

  assert.ok(bothSides.areaSquareMeters > east.areaSquareMeters);
  assert.ok(bothSides.segments.some((segment) => segment.edgeIndex === 8));
  assert.equal(hasProperSelfIntersection(bothSides.coordinates), false);
});

test('support selection snaps regional envelope anchors into the cyclic block', () => {
  const coordinatesById = {
    A: [0, 0],
    B: [5, 0],
    C: [5, 3],
    D: [3, 6],
    E: [0, 3],
  };
  const nodes = Object.entries(coordinatesById).map(([id, coordinate]) => ({
    coordinate,
    id,
  }));
  const endpointPairs = [
    ['A', 'B'],
    ['B', 'C'],
    ['C', 'D'],
    ['D', 'E'],
    ['E', 'A'],
    ['A', 'C'],
  ];
  const edges = endpointPairs.map(([fromId, toId], edgeIndex) =>
    edge(coordinatesById, fromId, toId, edgeIndex),
  );

  assert.deepEqual(
    northAmericanHighwayEnvelopeSupportNodeIds(nodes, edges, {
      supportCoordinates: [
        [3, 6],
        [5, 3],
      ],
    }),
    ['D', 'C'],
  );
});

test('local averaged-corridor loops are erased without moving endpoints', () => {
  const source = [
    [0, 0],
    [2, 2],
    [0, 2],
    [2, 0],
    [3, 0],
  ];
  const erased = loopErasedHighwayCoordinates(source);

  assert.deepEqual(erased[0], source[0]);
  assert.deepEqual(erased.at(-1), source.at(-1));
  assert.equal(hasProperSelfIntersection(erased), false);
});

test('adjacent averaged edges trim only their shared-junction hooks', () => {
  const steps = [
    {
      coordinates: [
        [-80.2058263, 25.8062866],
        [-80.2058156, 25.8058527],
        [-80.2057904, 25.8056788],
      ],
      fromId: 'A',
      toId: 'B',
    },
    {
      coordinates: [
        [-80.2057904, 25.8056788],
        [-80.2058252, 25.8061459],
      ],
      fromId: 'B',
      toId: 'C',
    },
    {
      coordinates: [
        [-80.2058252, 25.8061459],
        [-80.2065, 25.807],
      ],
      fromId: 'C',
      toId: 'D',
    },
  ];
  const before = steps.flatMap((step, index) =>
    index === 0 ? step.coordinates : step.coordinates.slice(1),
  );
  assert.equal(hasProperSelfIntersection(before), true);

  const clipped = clippedHighwayJunctionCoordinates(steps);
  const after = clipped.flatMap((coordinates, index) =>
    index === 0 ? coordinates : coordinates.slice(1),
  );

  assert.deepEqual(clipped[0][0], steps[0].coordinates[0]);
  assert.deepEqual(clipped[1].at(-1), steps[1].coordinates.at(-1));
  assert.deepEqual(clipped[0].at(-1), clipped[1][0]);
  assert.equal(hasProperSelfIntersection(after), false);
});

test('junction clipping does not erase crossings between unrelated edges', () => {
  const steps = [
    {
      coordinates: [
        [0, 0],
        [0.02, 0.02],
      ],
      fromId: 'A',
      toId: 'B',
    },
    {
      coordinates: [
        [0.02, 0.02],
        [0, 0.02],
      ],
      fromId: 'B',
      toId: 'C',
    },
    {
      coordinates: [
        [0, 0.02],
        [0.02, 0],
      ],
      fromId: 'C',
      toId: 'D',
    },
    {
      coordinates: [
        [0.02, 0],
        [0.03, 0],
      ],
      fromId: 'D',
      toId: 'E',
    },
  ];
  const clipped = clippedHighwayJunctionCoordinates(steps);

  assert.deepEqual(
    clipped,
    steps.map((step) => step.coordinates),
  );
  assert.equal(
    hasProperSelfIntersection(
      clipped.flatMap((coordinates, index) =>
        index === 0 ? coordinates : coordinates.slice(1),
      ),
    ),
    true,
  );
});
