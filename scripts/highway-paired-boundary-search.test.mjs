import assert from 'node:assert/strict';
import test from 'node:test';
import { planarizeHighways } from './highway-boundary-search.mjs';
import { searchPairedHighwayBoundary } from './highway-paired-boundary-search.mjs';
import { geodesicSegment, refineGeodesicCrossing } from './highway-geodesic-splits.mjs';
import {
  signedAreaContributionSquareMeters as area,
  geodesicDistanceMeters as distance,
} from './wgs84-geodesy.mjs';

test('geodesic subdivision preserves original area and distance', () => {
  const a = [-100, 40],
    b = [-90, 45],
    line = geodesicSegment(a, b);
  const points = [0, 0.13, 0.5, 0.88, 1].map((t) => line.point(t));
  assert.ok(Math.abs(area(points) - area([a, b])) < 0.1);
  assert.ok(
    Math.abs(
      points.slice(1).reduce((n, p, i) => n + distance(points[i], p), 0) -
        distance(a, b),
    ) < 1e-6,
  );
});

test('refined intersection lies on both original geodesics', () => {
  const a = [-100, 40],
    b = [-90, 45],
    c = [-100, 45],
    d = [-90, 40];
  const hit = refineGeodesicCrossing(a, b, c, d, 0.5, 0.5);
  assert.ok(hit);
  assert.ok(distance(hit.point, geodesicSegment(c, d).point(hit.u)) < 1e-5);
  const roads = [
    { fromId: 'a', toId: 'b', coordinates: [a, b] },
    { fromId: 'c', toId: 'd', coordinates: [c, d] },
  ];
  const g = planarizeHighways(roads, () => {}, { geodesic: true });
  for (let i = 0; i < 2; i++)
    assert.ok(
      Math.abs(
        g.edges.filter((e) => e.road === i).reduce((n, e) => n + e.area, 0) -
          area(roads[i].coordinates),
      ) < 0.1,
    );
});

test('curved geodesic crossing missed by straight lon-lat chords is found', () => {
  const roads = [
    {
      fromId: 'a',
      toId: 'b',
      coordinates: [
        [-10, 40],
        [10, 40],
      ],
    },
    {
      fromId: 'c',
      toId: 'd',
      coordinates: [
        [0, 40.1],
        [0, 40.8],
      ],
    },
  ];
  const g = planarizeHighways(roads, () => {}, { geodesic: true });
  assert.equal(g.edges.length, 4);
});

for (const shape of ['plain', 'retrace', 'secondary-loop'])
  test(`largest region only: ${shape}`, () => {
    const a = [0, 0],
      b = [0.01, 0],
      c = [0.01, 0.01],
      d = [0, 0.01];
    const first =
      shape === 'plain'
        ? [a, b]
        : shape === 'retrace'
          ? [a, [0.002, 0], [0.003, -0.001], [0.002, 0], b]
          : [a, [0.002, 0], [0.002, -0.001], [0.003, -0.001], [0.002, 0], b];
    const roads = [first, [b, c], [c, d], [d, a]].map((coordinates, i) => ({
      fromId: i,
      toId: (i + 1) % 4,
      coordinates,
    }));
    const g = planarizeHighways(roads, () => {}, { geodesic: true });
    const result = searchPairedHighwayBoundary(g, {
      maxMilliseconds: 1000,
      maxStates: 1000,
    });
    assert.equal(result.status, 'complete', result.error);
    assert.ok(Math.abs(result.best.area - Math.abs(area([a, b, c, d, a]))) < 0.01);
  });

test('initial-only pruning agrees with secondary pruning on a branching overpass', () => {
  const points = [
    [0, 0],
    [0.04, 0],
    [0.02, 0.04],
    [0, 0.025],
    [0.05, 0.025],
    [0.025, -0.02],
  ];
  const roads = [
    [0, 1],
    [1, 2],
    [2, 0],
    [3, 4],
    [4, 5],
    [5, 3],
  ].map(([fromId, toId]) => ({
    fromId,
    toId,
    coordinates: [points[fromId], points[toId]],
  }));
  const g = planarizeHighways(roads, () => {}, { geodesic: true });
  const results = [false, true].map((secondaryPruning) =>
    searchPairedHighwayBoundary(g, {
      maxMilliseconds: 1000,
      maxStates: 1000,
      secondaryPruning,
    }),
  );
  for (const r of results) assert.equal(r.status, 'complete', r.error);
  assert.ok(Math.abs(results[0].best.area - results[1].best.area) < 0.01);
  assert.ok(results[0].states > 1);
});

test('branch selection prioritizes the largest outer boundary over earlier small faces', () => {
  const base = [
    [0, 0],
    [0.04, 0],
    [0.02, 0.04],
    [0, 0.025],
    [0.05, 0.025],
    [0.025, -0.02],
  ];
  const pairs = [
    [0, 1],
    [1, 2],
    [2, 0],
    [3, 4],
    [4, 5],
    [5, 3],
  ];
  const roads = [1, 4].flatMap((scale, group) => {
    const points = base.map(([x, y]) => [x * scale + group, y * scale]);
    return pairs.map(([a, b]) => ({
      fromId: `${group}-${a}`,
      toId: `${group}-${b}`,
      coordinates: [points[a], points[b]],
    }));
  });
  for (const ordered of [roads, [...roads].reverse()]) {
    const graph = planarizeHighways(ordered, () => {}, { geodesic: true }),
      branches = [];
    const result = searchPairedHighwayBoundary(graph, {
      maxStates: 1,
      maxMilliseconds: 1000,
      onBranch: (b) => branches.push(b),
    });
    assert.equal(branches.length, 1, result.error);
    const node = graph.nodes.find((n) => n.id === branches[0].vertex);
    assert.ok(
      node.coordinate[0] >= 1,
      'first split must be on the larger boundary regardless of road order',
    );
  }
});

test('a bounded search checkpoint resumes pending alternatives without restarting its root', () => {
  const points = [
    [0, 0],
    [0.04, 0],
    [0.02, 0.04],
    [0, 0.025],
    [0.05, 0.025],
    [0.025, -0.02],
  ];
  const roads = [
    [0, 1],
    [1, 2],
    [2, 0],
    [3, 4],
    [4, 5],
    [5, 3],
  ].map(([fromId, toId]) => ({
    fromId,
    toId,
    coordinates: [points[fromId], points[toId]],
  }));
  const graph = planarizeHighways(roads, () => {}, { geodesic: true });
  let saved;
  const initial = searchPairedHighwayBoundary(graph, {
    maxStates: 1,
    maxMilliseconds: 1000,
    onCheckpoint: (s) => {
      saved = structuredClone(s);
    },
  });
  assert.equal(initial.status, 'incomplete');
  assert.equal(initial.states, 1);
  assert.ok(saved.queue.length > 0);
  const resumed = searchPairedHighwayBoundary(graph, {
    maxMilliseconds: 1000,
    resume: saved,
  });
  const fresh = searchPairedHighwayBoundary(graph, { maxMilliseconds: 1000 });
  assert.equal(resumed.status, 'complete', resumed.error);
  assert.equal(resumed.best.area, fresh.best.area);
  assert.equal(resumed.states, fresh.states);
});
