import assert from 'node:assert/strict';
import test from 'node:test';
import { planarizeHighways } from './highway-boundary-search.mjs';
import {
  boundaryFaceWalks,
  largestBoundaryRegion,
  splitBoundaryLoops,
} from './highway-boundary-regions.mjs';
import { searchPairedHighwayBoundary } from './highway-paired-boundary-search.mjs';
import { signedAreaContributionSquareMeters as area } from './wgs84-geodesy.mjs';

function graphWithExcursions() {
  const p = {
    a: [0, 0],
    b: [0.02, 0],
    c: [0.02, 0.02],
    d: [0, 0.02],
    x: [0.025, 0],
    y: [0.025, -0.005],
    z: [0.02, -0.005],
    u: [-0.01, 0],
    v: [-0.01, -0.003],
    w: [-0.013, -0.003],
    t: [-0.013, 0],
  };
  const links = [
    ['a', 'b'],
    ['b', 'c'],
    ['c', 'd'],
    ['d', 'a'],
    ['b', 'x'],
    ['x', 'y'],
    ['y', 'z'],
    ['z', 'b'],
    ['a', 'u'],
    ['u', 'v'],
    ['v', 'w'],
    ['w', 't'],
    ['t', 'u'],
  ];
  return planarizeHighways(
    links.map(([fromId, toId]) => ({
      fromId,
      toId,
      coordinates: [p[fromId], p[toId]],
    })),
    () => {},
    { geodesic: true },
  );
}
function visits(graph, cycle) {
  return cycle.map((h) =>
    h % 2 ? graph.edges[h >> 1].toId : graph.edges[h >> 1].fromId,
  );
}

test('splitting a face walk preserves its signed area and removes vertex repeats', () => {
  const g = graphWithExcursions();
  const faces = boundaryFaceWalks(
    g,
    g.edges.map((_, i) => i),
  );
  assert.ok(faces.some((f) => new Set(visits(g, f.cycle)).size < f.cycle.length));
  for (const face of faces) {
    const loops = splitBoundaryLoops(g, face.cycle);
    assert.ok(Math.abs(loops.reduce((n, l) => n + l.area, 0) - face.area) < 0.01);
    for (const loop of loops)
      assert.equal(new Set(visits(g, loop.cycle)).size, loop.cycle.length);
  }
  const primary = largestBoundaryRegion(
    g,
    g.edges.map((_, i) => 2 * i),
  );
  assert.ok(
    Math.abs(
      primary.area -
        Math.abs(
          area([
            [0, 0],
            [0.02, 0],
            [0.02, 0.02],
            [0, 0.02],
            [0, 0],
          ]),
        ),
    ) < 0.01,
  );
  assert.equal(new Set(visits(g, primary.boundary)).size, primary.boundary.length);
});

test('the unrestricted preview expands just the largest simple loop, excluding branches and secondary area', () => {
  const g = graphWithExcursions();
  let expanded;
  g.expand = (walk) => {
    expanded = walk;
    return { coordinates: [] };
  };
  const result = searchPairedHighwayBoundary(g, {
    previewUnrestricted: true,
    maxMilliseconds: 1000,
  });
  assert.equal(result.status, 'unrestricted-preview', result.error);
  assert.equal(result.diagnostics.repeatedVertices, 0);
  assert.equal(new Set(visits(g, expanded)).size, expanded.length);
  assert.ok(
    Math.abs(
      result.best.area -
        Math.abs(
          area([
            [0, 0],
            [0.02, 0],
            [0.02, 0.02],
            [0, 0.02],
            [0, 0],
          ]),
        ),
    ) < 0.01,
  );
});

test('malformed open or disconnected walks are rejected', () => {
  const g = graphWithExcursions();
  assert.throws(() => splitBoundaryLoops(g, [0]), /Open boundary/);
  assert.throws(() => splitBoundaryLoops(g, [0, 4]), /Disconnected boundary/);
  assert.deepEqual(splitBoundaryLoops(g, []), []);
});
