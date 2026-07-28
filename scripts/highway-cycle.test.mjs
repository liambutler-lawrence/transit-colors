import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasProperSelfIntersection,
  solveLargestPlanarHighwayCycle,
} from './highway-cycle.mjs';

const node = (id, coordinate) => ({ coordinate, id });
const edge = (fromId, toId, coordinates) => ({
  coordinates,
  fromId,
  toId,
});

test('planar highway solver chooses the outer boundary of the largest block', () => {
  const nodes = [
    node('a', [0, 0]),
    node('b', [2, 0]),
    node('c', [2, 2]),
    node('d', [0, 2]),
    node('e', [1, 0]),
    node('f', [1, 2]),
    node('g', [3, 0]),
    node('h', [3.4, 0]),
    node('i', [3.4, 0.4]),
    node('j', [3, 0.4]),
  ];
  const edges = [
    edge('a', 'e', [
      [0, 0],
      [1, 0],
    ]),
    edge('e', 'b', [
      [1, 0],
      [2, 0],
    ]),
    edge('b', 'c', [
      [2, 0],
      [2, 2],
    ]),
    edge('c', 'f', [
      [2, 2],
      [1, 2],
    ]),
    edge('f', 'd', [
      [1, 2],
      [0, 2],
    ]),
    edge('d', 'a', [
      [0, 2],
      [0, 0],
    ]),
    edge('e', 'f', [
      [1, 0],
      [1, 2],
    ]),
    edge('b', 'g', [
      [2, 0],
      [3, 0],
    ]),
    edge('g', 'h', [
      [3, 0],
      [3.4, 0],
    ]),
    edge('h', 'i', [
      [3.4, 0],
      [3.4, 0.4],
    ]),
    edge('i', 'j', [
      [3.4, 0.4],
      [3, 0.4],
    ]),
    edge('j', 'g', [
      [3, 0.4],
      [3, 0],
    ]),
  ];

  const result = solveLargestPlanarHighwayCycle(nodes, edges);
  assert.deepEqual(new Set(result.nodeIds), new Set(['a', 'b', 'c', 'd', 'e', 'f']));
  assert.ok(result.areaSquareMeters > 49_000_000_000);
  assert.equal(result.biconnectedBlockCount, 2);
});

test('highway boundary validation rejects proper geometric crossings', () => {
  assert.equal(
    hasProperSelfIntersection([
      [0, 0],
      [1, 1],
      [0, 1],
      [1, 0],
      [0, 0],
    ]),
    true,
  );
  assert.equal(
    hasProperSelfIntersection([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ]),
    false,
  );
});
