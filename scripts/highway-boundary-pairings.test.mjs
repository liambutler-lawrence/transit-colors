import assert from 'node:assert/strict';
import test from 'node:test';
import {
  boundaryPairingChoices,
  pairedBoundaryWalks,
} from './highway-boundary-pairings.mjs';
import {
  planarizeHighways,
  searchHighwayBoundary,
} from './highway-boundary-search.mjs';
import { signedAreaContributionSquareMeters } from './wgs84-geodesy.mjs';

test('overpass alternatives include both independent roads without switching', () => {
  assert.deepEqual(
    boundaryPairingChoices(
      [0, 1, 2, 3],
      (a, b) => (a === 0 && b === 2) || (a === 1 && b === 3),
    ),
    [
      [],
      [[1, 3]],
      [[0, 2]],
      [
        [0, 2],
        [1, 3],
      ],
    ],
  );
});

for (const shape of ['plain', 'retrace', 'touching-loop']) {
  test(`independent pairings preserve the known ${shape} source cycle`, () => {
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
      partIndices: new Set(),
    }));
    const g = planarizeHighways(roads),
      pairings = new Map();
    for (const v of g.nodes) {
      const incident = g.edges.flatMap((e, i) =>
        e.fromId === v.id || e.toId === v.id ? [i] : [],
      );
      const complete = boundaryPairingChoices(incident, (i, j) =>
        g.legal(i, j, v.id),
      ).filter((pairs) => pairs.length * 2 === incident.length);
      assert.equal(
        complete.length,
        1,
        'source-only fixture has exactly one full continuation',
      );
      pairings.set(v.id, complete[0]);
    }
    const walks = pairedBoundaryWalks(g, pairings);
    assert.equal(walks.length, 2, 'same source cycle in opposite directions');
    assert.equal(walks[0].length, g.edges.length, 'no source segment lost');
    const area = Math.abs(
      walks[0].reduce((sum, h) => sum + (h % 2 ? -1 : 1) * g.edges[h >> 1].area, 0),
    );
    const expected = Math.abs(signedAreaContributionSquareMeters([...first, c, d, a]));
    assert.ok(Math.abs(area - expected) < 0.01);
  });
}

// Documents why additive scoring was rejected; the new search scores one region.
test('regression: additive secondary-loop area exceeds the largest-region objective', () => {
  const a = [0, 0],
    b = [0.01, 0],
    c = [0.01, 0.01],
    d = [0, 0.01];
  const first = [a, [0.002, 0], [0.002, -0.001], [0.003, -0.001], [0.002, 0], b];
  const roads = [first, [b, c], [c, d], [d, a]].map((coordinates, i) => ({
    fromId: i,
    toId: (i + 1) % 4,
    coordinates,
    partIndices: new Set(),
  }));
  const g = planarizeHighways(roads);
  const relaxed = searchHighwayBoundary(
    { ...g, legal: (i, j) => i !== j },
    { maxMilliseconds: 1000 },
  );
  assert.equal(relaxed.status, 'optimal');
  const sourceArea = Math.abs(signedAreaContributionSquareMeters([...first, c, d, a]));
  assert.ok(
    sourceArea > relaxed.best.area + 6000,
    `legal source area ${sourceArea} exceeds largest-block bound ${relaxed.best.area}`,
  );
});
