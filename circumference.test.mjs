import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import polygonClipping from 'polygon-clipping';
import {
  buildCircumferenceCandidates,
  lineLengthMeters,
  polygonAreaSquareMeters,
  selectCircumferenceCandidate,
} from './circumference.js';
import { calculateLandmassCoverage } from './circumference-landmass.js';
import { hasOfficialLineColor, lineColor } from './line-colors.js';

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
assert.equal(lineColor('cdmx', '1'), '#F05097');
assert.equal(lineColor('cdmx', 'L12'), '#BFA042');
assert.equal(lineColor('nyc', 'A'), '#0062CF');
assert.equal(lineColor('nyc', '6X'), '#009952');
assert.equal(lineColor('nyc', 'SIR'), '#008EB7');

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
assert.equal(squareResult.network.stations.length, 5);
assert.equal(squareResult.network.segments.length, 5);
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

const splitPlatformCoordinates = new Map([
  ['a', [0, 0]],
  ['transfer-a', [0.01, 0]],
  ['transfer-b', [0.0102, 0.0001]],
  ['c', [0.01, 0.01]],
  ['d', [0, 0.01]],
]);
const splitPlatformStations = [...splitPlatformCoordinates].map(
  ([id, coordinates]) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates },
    properties: {
      id,
      name: id.startsWith('transfer') ? 'Transfer' : id,
      mode: 'subway',
      status: 'open',
    },
  }),
);
const splitPlatformResult = buildCircumferenceCandidates(
  splitPlatformStations,
  {
    routes: {
      lineA: { mode: 'subway', name: 'A' },
      lineB: { mode: 'subway', name: 'B' },
    },
    graph: {
      e: {
        a: [
          ['transfer-a', 1, 'lineA/0'],
          ['d', 1, 'lineA/1'],
        ],
        'transfer-b': [['c', 1, 'lineB/0']],
        c: [['d', 1, 'lineB/0']],
      },
      t: {
        'transfer-a': [['transfer-b', 2]],
      },
    },
  },
  { minimumAreaSquareMeters: 1 },
);
const splitPlatformWinner = splitPlatformResult.candidates[0];
assert.ok(splitPlatformWinner);
assert.equal(splitPlatformWinner.stations.length, 5);
assert.equal(splitPlatformWinner.transferCount, 1);
assert.equal(
  splitPlatformWinner.segments.filter(({ type }) => type === 'transfer')
    .length,
  1,
);
assert.ok(splitPlatformWinner.walkingLengthMeters > 20);
assert.deepEqual(splitPlatformWinner.lines, ['A', 'B']);
for (const station of splitPlatformWinner.stations) {
  assert.deepEqual(
    station.coordinate,
    splitPlatformCoordinates.get(station.id),
  );
}
const splitTransfer = splitPlatformWinner.segments.find(
  ({ type }) => type === 'transfer',
);
assert.equal(splitTransfer.transferSource, 'published');
assert.equal(splitTransfer.transferMinutes, 2);
assert.notDeepEqual(splitTransfer.from.coordinate, splitTransfer.to.coordinate);
assert.equal(splitPlatformResult.network.stations.length, 5);
assert.equal(splitPlatformResult.network.segments.length, 4);

const adjacentCellStations = [
  ['a', [0, 0]],
  ['b', [0.01, 0]],
  ['c', [0.02, 0]],
  ['d', [0.02, 0.01]],
  ['e', [0.01, 0.01]],
  ['f', [0, 0.01]],
].map(([id, coordinates]) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates },
  properties: { id, name: id, mode: 'subway', status: 'open' },
}));
const adjacentCellResult = buildCircumferenceCandidates(
  adjacentCellStations,
  {
    routes: { line: { mode: 'subway', name: 'A' } },
    graph: {
      e: {
        a: [
          ['b', 1, 'line/0'],
          ['f', 1, 'line/0'],
        ],
        b: [
          ['c', 1, 'line/0'],
          ['e', 1, 'line/0'],
        ],
        c: [['d', 1, 'line/0']],
        d: [['e', 1, 'line/0']],
        e: [['f', 1, 'line/0']],
      },
      t: {},
    },
  },
  { minimumAreaSquareMeters: 1 },
);
assert.equal(adjacentCellResult.candidates[0].stations.length, 6);
assert.ok(adjacentCellResult.candidates[0].areaSquareMeters > 2_400_000);

const shortcutStations = [
  ['start', [0, 0]],
  ['local-1', [0.01, 0.002]],
  ['local-2', [0.02, 0.002]],
  ['end', [0.03, 0]],
].map(([id, coordinates]) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates },
  properties: { id, name: id, mode: 'subway', status: 'open' },
}));
const shortcutResult = buildCircumferenceCandidates(
  shortcutStations,
  {
    routes: { line: { mode: 'subway', name: 'A' } },
    graph: {
      e: {
        start: [
          ['local-1', 1, 'line/0'],
          ['end', 1, 'line/0'],
        ],
        'local-1': [['local-2', 1, 'line/0']],
        'local-2': [['end', 1, 'line/0']],
      },
      t: {},
    },
  },
  { minimumAreaSquareMeters: 1 },
);
assert.equal(shortcutResult.methodology.removedShortcutCount, 1);
assert.deepEqual(
  [
    shortcutResult.methodology.removedShortcuts[0].from,
    shortcutResult.methodology.removedShortcuts[0].to,
  ].sort(),
  ['end', 'start'],
);
assert.deepEqual(shortcutResult.methodology.removedShortcuts[0].lines, ['A']);
assert.equal(shortcutResult.candidates.length, 0);
assert.equal(shortcutResult.network.segments.length, 3);
assert.ok(
  shortcutResult.network.segments.every(
    (segment) =>
      segment.lines.includes('A') &&
      new Set([segment.from.id, segment.to.id]).size === 2,
  ),
);
assert.ok(
  shortcutResult.network.segments.every(
    (segment) =>
      !(
        new Set([segment.from.id, segment.to.id]).has('start') &&
        new Set([segment.from.id, segment.to.id]).has('end')
      ),
  ),
);

for (const [areaKey, expectedMinimumAreaKm2] of [
  ['cdmx', 120],
  ['nyc', 147],
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
  const activeLineNames = new Set(winner.lines);
  const fullLineStations = result.network.stations.filter((station) =>
    station.lineNames.some((lineName) => activeLineNames.has(lineName)),
  );
  assert.ok(fullLineStations.length > winner.stations.length);
  assert.ok(
    result.network.segments.some((segment) =>
      segment.lines.some((lineName) => activeLineNames.has(lineName)),
    ),
  );
  assert.ok(
    winner.lines.every((lineName) =>
      hasOfficialLineColor(areaKey, lineName),
    ),
  );
  assert.ok(winner.transferCount > 0);
  assert.ok(winner.walkingLengthMeters > 0);
  assert.equal(
    winner.transferCount,
    winner.segments.filter(({ type }) => type === 'transfer').length,
  );
  const stationFeaturesById = new Map(
    stations.features.map((feature) => [feature.properties.id, feature]),
  );
  for (const station of winner.stations) {
    assert.deepEqual(
      station.coordinate,
      stationFeaturesById.get(station.id).geometry.coordinates,
    );
  }
  for (const transfer of winner.segments.filter(
    ({ type }) => type === 'transfer',
  )) {
    assert.notEqual(transfer.from.id, transfer.to.id);
    assert.notDeepEqual(transfer.from.coordinate, transfer.to.coordinate);
    assert.ok(transfer.distanceMeters > 0);
  }

  if (areaKey === 'nyc') {
    const winnerStationNames = new Set(
      winner.stations.map((station) => station.name),
    );
    for (const stationName of [
      '138 St-Grand Concourse',
      '149 St-Grand Concourse',
      'Jamaica-Van Wyck',
      'Sutphin Blvd-Archer Av-JFK Airport',
      'Coney Island-Stillwell Av',
    ]) {
      assert.ok(winnerStationNames.has(stationName));
    }

    const landmassData = JSON.parse(
      await readFile(
        new URL('./data/circumference-landmasses.json', import.meta.url),
        'utf8',
      ),
    );
    const coverage = calculateLandmassCoverage(
      winner.coordinates,
      landmassData.areas.nyc,
      polygonClipping,
    );
    assert.deepEqual(
      coverage.map((landmass) => landmass.label),
      [
        'American mainland',
        'Manhattan',
        'Long Island',
        'Roosevelt Island',
      ],
    );
    assert.ok(
      coverage.every(
        (landmass) =>
          landmass.insideAreaSquareMeters > 0 &&
          landmass.outsideAreaSquareMeters > 0,
      ),
    );

    const removedPairs = new Set(
      result.methodology.removedShortcuts.map(({ from, to }) =>
        [from, to].sort().join(' :: '),
      ),
    );
    for (const pair of [
      ['3 Av-138 St', 'Hunts Point Av'],
      ['62 St', 'Bay Pkwy'],
      ['New Dorp', 'St George'],
      ['Great Kills', 'St George'],
    ]) {
      assert.ok(removedPairs.has(pair.sort().join(' :: ')));
    }
    assert.ok(
      result.methodology.removedShortcuts.every(
        ({ lines }) => !lines.includes('PATH'),
      ),
    );
  }
}

console.log('Circumference route checks passed.');
