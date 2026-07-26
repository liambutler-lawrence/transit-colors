import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildCircumferenceCandidates,
  lineLengthMeters,
  polygonAreaSquareMeters,
  selectCircumferenceCandidate,
} from './circumference.js';

const oneDegreeSquare = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
  [0, 0],
];
assert.ok(
  Math.abs(polygonAreaSquareMeters(oneDegreeSquare) / 1_000_000 - 12_364) < 20,
);
assert.ok(lineLengthMeters(oneDegreeSquare) / 1000 > 440);

const squareStations = [
  ['a', [0, 0]],
  ['b', [0.01, 0]],
  ['c', [0.01, 0.01]],
  ['d', [0, 0.01]],
  ['spur', [0.02, 0]],
].map(([id, coordinates]) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates },
  properties: { id, name: id, mode: 'subway', status: 'open' },
}));
const squareSchedules = {
  routes: {
    line: { mode: 'subway', name: 'A' },
  },
  graph: {
    e: {
      a: [
        ['b', 1, 'line/0'],
        ['d', 1, 'line/1'],
      ],
      b: [
        ['a', 1, 'line/1'],
        ['c', 1, 'line/0'],
        ['spur', 1, 'line/0'],
      ],
      c: [
        ['b', 1, 'line/1'],
        ['d', 1, 'line/0'],
      ],
      d: [
        ['c', 1, 'line/1'],
        ['a', 1, 'line/0'],
      ],
      spur: [['b', 1, 'line/1']],
    },
    t: {},
  },
};
const squareResult = buildCircumferenceCandidates(
  squareStations,
  squareSchedules,
  { minimumAreaSquareMeters: 1 },
);
assert.equal(squareResult.candidates.length, 1);
assert.equal(squareResult.candidates[0].stations.length, 4);
assert.deepEqual(squareResult.candidates[0].lines, ['A']);
assert.equal(
  selectCircumferenceCandidate(
    squareResult.candidates,
    squareResult.candidates[0].id,
  ),
  squareResult.candidates[0],
);
assert.equal(
  selectCircumferenceCandidate(squareResult.candidates, '', {
    avoidedSegmentIds: [squareResult.candidates[0].segments[0].id],
  }),
  null,
);

for (const [areaKey, expectedMinimumAreaKm2] of [
  ['cdmx', 26],
  ['nyc', 10],
]) {
  const stations = JSON.parse(
    await readFile(
      new URL(`./data/${areaKey}-stations.geojson`, import.meta.url),
      'utf8',
    ),
  );
  const schedules = JSON.parse(
    await readFile(
      new URL(`./data/${areaKey}-schedules.json`, import.meta.url),
      'utf8',
    ),
  );
  const result = buildCircumferenceCandidates(stations.features, schedules);
  const winner = result.candidates[0];

  assert.ok(winner);
  assert.ok(winner.areaSquareMeters / 1_000_000 > expectedMinimumAreaKm2);
  assert.equal(new Set(winner.nodeIds).size, winner.nodeIds.length);
  assert.equal(winner.coordinates.length, winner.nodeIds.length + 1);
  assert.ok(winner.lines.length > 1);
  assert.ok(result.candidates.length > 2);
}

console.log('Circumference route checks passed.');
