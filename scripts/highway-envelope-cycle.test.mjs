import assert from 'node:assert/strict';
import test from 'node:test';

import {
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
