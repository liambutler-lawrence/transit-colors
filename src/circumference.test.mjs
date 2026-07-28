import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import polygonClipping from 'polygon-clipping';
import {
  activeCircumferenceLines,
  activeCircumferenceService,
  junctionContinuationLineLanes,
  buildCircumferenceCandidates,
  filterCircumferenceNetwork,
  lineLengthMeters,
  polygonAreaSquareMeters,
  scheduleCircumferenceMode,
  serviceDaysActiveAt,
  selectCircumferenceCandidate,
  selectIndependentCircumferenceCandidates,
  tracksShareFromNode,
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
  Math.abs(polygonAreaSquareMeters(oneDegreeSquare) / 1_000_000 - 12_308.778_361) <
    0.001,
);
assert.ok(Math.abs(lineLengthMeters(oneDegreeSquare) / 1000 - 443.770_917) < 0.001);
const syntheticLandmassCoverage = calculateLandmassCoverage(
  oneDegreeSquare,
  {
    label: 'Synthetic',
    area_m2: 1_000_000_000_000,
    mask: null,
    landmasses: [
      {
        id: 'synthetic',
        label: 'Synthetic',
        area_m2: 1_000_000_000_000,
        mask: [
          [
            [
              [-1, -1],
              [2, -1],
              [2, 2],
              [-1, 2],
              [-1, -1],
            ],
          ],
        ],
      },
    ],
  },
  polygonClipping,
);
assert.ok(
  Math.abs(
    syntheticLandmassCoverage[0].insideAreaSquareMeters -
      polygonAreaSquareMeters(oneDegreeSquare),
  ) < 0.01,
);
assert.equal(lineColor('cdmx', '1'), '#F05097');
assert.equal(lineColor('cdmx', 'L12'), '#BFA042');
assert.equal(lineColor('nyc', 'A'), '#0062CF');
assert.equal(lineColor('nyc', '6X'), '#009952');
assert.equal(lineColor('nyc', 'SIR'), '#008EB7');
assert.equal(lineColor('singapore', 'CC'), '#FA9E0D');
assert.equal(lineColor('atlanta', 'RED'), '#CE242B');
assert.equal(lineColor('athens', 'M3'), '#0057A8');

const independentCandidate = (id, areaSquareMeters, rideSegmentIds) => ({
  id,
  areaSquareMeters,
  segments: rideSegmentIds.map((segmentId) => ({
    id: segmentId,
    type: 'ride',
  })),
});
assert.deepEqual(
  selectIndependentCircumferenceCandidates([
    independentCandidate('overlapping-alternative', 90, ['trunk', 'west']),
    independentCandidate('eastern-circle', 70, ['east-a', 'east-b']),
    independentCandidate('largest-circle', 100, ['trunk', 'north']),
    independentCandidate('southern-circle', 60, ['south-a', 'south-b']),
  ]).map(({ id }) => id),
  ['largest-circle', 'eastern-circle', 'southern-circle'],
);

const closedServiceDays = Array.from({ length: 7 }, () => []);
const overnightServiceDays = Array.from({ length: 7 }, () => []);
overnightServiceDays[6] = [[23 * 60, 25 * 60, 10]];
assert.equal(serviceDaysActiveAt(closedServiceDays, 0, 30), false);
assert.equal(serviceDaysActiveAt(overnightServiceDays, 0, 30), true);
assert.equal(serviceDaysActiveAt(overnightServiceDays, 0, 60), false);

const scheduleLineFixture = {
  routes: {
    subwayA: { mode: 'subway', name: 'A' },
    busA: { mode: 'brt', name: 'A' },
  },
  graph: { e: {}, t: {} },
  stations: {
    platform: {
      r: ['subwayA', 'busA'],
      d: closedServiceDays,
      p: {
        'subwayA/0': overnightServiceDays,
        'busA/0': overnightServiceDays,
      },
    },
  },
};
assert.deepEqual([...activeCircumferenceLines(scheduleLineFixture, 0, 30)], ['A']);
assert.deepEqual([...activeCircumferenceLines(scheduleLineFixture, 0, 60)], []);

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
const squareResult = buildCircumferenceCandidates(squareStations, squareSchedules, {
  minimumAreaSquareMeters: 1,
});
assert.equal(squareResult.candidates.length, 1);
assert.equal(squareResult.candidates[0].stations.length, 4);
assert.deepEqual(squareResult.candidates[0].lines, ['A']);
assert.equal(squareResult.network.stations.length, 5);
assert.equal(squareResult.network.segments.length, 5);
assert.equal(
  filterCircumferenceNetwork(squareResult.network, {
    lineNames: new Set(),
    serviceKeysByStation: new Map(),
  }).segments.length,
  0,
);
const activeSquareService = {
  lineNames: new Set(['A']),
  serviceKeysByStation: new Map(
    ['a', 'b', 'c', 'd', 'spur'].map((stationId) => [
      stationId,
      new Set(['line/0', 'line/1']),
    ]),
  ),
};
const scheduledSquareResult = scheduleCircumferenceMode(
  squareResult.geometryVariants.track,
  activeSquareService,
  'track',
);
assert.equal(scheduledSquareResult.candidates.length, 1);
assert.deepEqual(scheduledSquareResult.candidates[0].lines, ['A']);
assert.equal(
  selectCircumferenceCandidate(squareResult.candidates, squareResult.candidates[0].id),
  squareResult.candidates[0],
);
assert.equal(
  selectCircumferenceCandidate(squareResult.candidates, '', {
    avoidedSegmentIds: [squareResult.candidates[0].segments[0].id],
  }),
  null,
);

const parallelServiceResult = buildCircumferenceCandidates(
  squareStations,
  {
    routes: {
      localL: {
        mode: 'subway',
        name: 'L',
        description: 'Synthetic Local',
      },
      localM: {
        mode: 'subway',
        name: 'M',
        description: 'Synthetic Local',
      },
      express: {
        mode: 'subway',
        name: 'X',
        description: 'Synthetic Express',
      },
    },
    graph: {
      e: {
        a: [
          ['b', 1, 'localL/0'],
          ['b', 1, 'express/0'],
          ['d', 1, 'localM/0'],
          ['d', 1, 'express/0'],
        ],
        b: [
          ['c', 1, 'localL/0'],
          ['c', 1, 'express/0'],
        ],
        c: [
          ['d', 1, 'localM/0'],
          ['d', 1, 'express/0'],
        ],
      },
      t: {},
    },
  },
  { minimumAreaSquareMeters: 1 },
);
const parallelServiceWinner = parallelServiceResult.candidates[0];
assert.ok(parallelServiceWinner);
assert.deepEqual(parallelServiceWinner.lines, ['L', 'M']);
assert.ok(
  parallelServiceWinner.segments.every(
    (segment) =>
      segment.type === 'transfer' ||
      (segment.primaryLine !== 'X' &&
        segment.primaryLine !== null &&
        segment.lines.includes(segment.primaryLine)),
  ),
);
const primaryLineByEdge = new Map(
  parallelServiceWinner.segments.map((segment) => [
    [segment.from.id, segment.to.id].sort().join('::'),
    segment.primaryLine,
  ]),
);
assert.equal(primaryLineByEdge.get('a::b'), 'L');
assert.equal(primaryLineByEdge.get('b::c'), 'L');
assert.equal(primaryLineByEdge.get('c::d'), 'M');
assert.equal(primaryLineByEdge.get('a::d'), 'M');

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
  splitPlatformWinner.segments.filter(({ type }) => type === 'transfer').length,
  1,
);
assert.ok(splitPlatformWinner.walkingLengthMeters > 20);
assert.deepEqual(splitPlatformWinner.lines, ['A', 'B']);
for (const station of splitPlatformWinner.stations) {
  assert.deepEqual(station.coordinate, splitPlatformCoordinates.get(station.id));
}
const splitTransfer = splitPlatformWinner.segments.find(
  ({ type }) => type === 'transfer',
);
assert.equal(splitTransfer.transferSource, 'published');
assert.equal(splitTransfer.transferMinutes, 2);
assert.notDeepEqual(splitTransfer.from.coordinate, splitTransfer.to.coordinate);
assert.equal(splitPlatformResult.network.stations.length, 5);
assert.equal(splitPlatformResult.network.segments.length, 5);
assert.equal(
  splitPlatformResult.network.segments.filter(({ type }) => type === 'transfer').length,
  1,
);

const transferChainStations = [
  ['a', [0, 0], 'A'],
  ['pantitlan-5', [0.01, 0], 'Pantitlán L5'],
  ['pantitlan-1', [0.0102, 0.0002], 'Pantitlán L1'],
  ['pantitlan-a', [0.0104, 0.0001], 'Pantitlán LA'],
  ['pantitlan-9', [0.0106, 0], 'Pantitlán L9'],
  ['c', [0.01, 0.01], 'C'],
  ['d', [0, 0.01], 'D'],
  ['spur-1', [0.012, 0.002], 'Spur 1'],
  ['spur-a', [0.012, 0.001], 'Spur A'],
].map(([id, coordinates, name]) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates },
  properties: { id, name, mode: 'subway', status: 'open' },
}));
const transferChainResult = buildCircumferenceCandidates(
  transferChainStations,
  {
    routes: {
      line5: { mode: 'subway', name: '5' },
      line1: { mode: 'subway', name: '1' },
      lineA: { mode: 'subway', name: 'A' },
      line9: { mode: 'subway', name: '9' },
    },
    graph: {
      e: {
        a: [
          ['pantitlan-5', 1, 'line5/0'],
          ['d', 1, 'line5/1'],
        ],
        'pantitlan-1': [['spur-1', 1, 'line1/0']],
        'pantitlan-a': [['spur-a', 1, 'lineA/0']],
        'pantitlan-9': [['c', 1, 'line9/0']],
        c: [['d', 1, 'line9/0']],
      },
      t: {},
    },
  },
  { minimumAreaSquareMeters: 1 },
);
assert.ok(transferChainResult.candidates.length > 0);
const directPantitlanTransfer = transferChainResult.candidates[0].segments.filter(
  (segment) =>
    segment.type === 'transfer' &&
    segment.from.name.startsWith('Pantitlán') &&
    segment.to.name.startsWith('Pantitlán'),
);
assert.equal(directPantitlanTransfer.length, 1);
assert.deepEqual(
  new Set([
    ...directPantitlanTransfer[0].from.lineNames,
    ...directPantitlanTransfer[0].to.lineNames,
  ]),
  new Set(['5', '9']),
);

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
const curvedSquareSchedules = structuredClone(squareSchedules);
curvedSquareSchedules.graph.g = {
  a: [
    [
      'b',
      [
        [0, 0],
        [0.005, -0.003],
        [0.01, 0],
      ],
    ],
  ],
};
curvedSquareSchedules.track_geometry = {
  method: 'Synthetic averaged track centerline',
};
const curvedSquareResult = buildCircumferenceCandidates(
  squareStations,
  curvedSquareSchedules,
  { minimumAreaSquareMeters: 1 },
);
const straightSquareResult = buildCircumferenceCandidates(
  squareStations,
  curvedSquareSchedules,
  { minimumAreaSquareMeters: 1, useTrackGeometry: false },
);
assert.equal(curvedSquareResult.methodology.trackGeometryEnabled, true);
assert.equal(straightSquareResult.methodology.trackGeometryEnabled, false);
assert.equal(
  curvedSquareResult.geometryVariants.straight.methodology.trackGeometryEnabled,
  false,
);
assert.ok(
  curvedSquareResult.candidates[0].coordinates.length >
    straightSquareResult.candidates[0].coordinates.length,
);
assert.ok(
  curvedSquareResult.candidates[0].areaSquareMeters >
    straightSquareResult.candidates[0].areaSquareMeters,
);
assert.equal(
  curvedSquareResult.network.segments.find(
    (segment) =>
      new Set([segment.from.id, segment.to.id]).has('a') &&
      new Set([segment.from.id, segment.to.id]).has('b'),
  ).coordinates.length,
  3,
);

for (const [areaKey, expectedMinimumAreaKm2] of [
  ['cdmx', 125],
  ['nyc', 163],
]) {
  const stations = JSON.parse(
    await readFile(
      new URL(`../data/${areaKey}-stations.geojson`, import.meta.url),
      'utf8',
    ),
  );
  const schedules = JSON.parse(
    await readFile(
      new URL(`../data/${areaKey}-schedules.json`, import.meta.url),
      'utf8',
    ),
  );
  const result = buildCircumferenceCandidates(stations.features, schedules);
  const winner = result.candidates[0];

  assert.ok(winner);
  assert.ok(winner.areaSquareMeters / 1_000_000 > expectedMinimumAreaKm2);
  assert.equal(new Set(winner.nodeIds).size, winner.nodeIds.length);
  assert.ok(winner.coordinates.length > winner.nodeIds.length + 1);
  assert.ok(winner.lines.length > 1);
  assert.ok(result.candidates.length > 2);
  assert.equal(result.methodology.trackGeometryEnabled, true);
  assert.ok(result.methodology.trackGeometryEdgeCount > 100);
  const straightWinner = result.geometryVariants.straight.candidates[0];
  assert.ok(straightWinner);
  assert.equal(straightWinner.coordinates.length, straightWinner.nodeIds.length + 1);
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
  const eligibleLineNames = new Set(
    result.network.segments.flatMap((segment) => segment.lines),
  );
  assert.ok(eligibleLineNames.size >= (areaKey === 'nyc' ? 34 : 12));
  assert.ok(
    [...eligibleLineNames].every((lineName) => hasOfficialLineColor(areaKey, lineName)),
  );
  assert.ok(
    result.network.segments.some(
      (segment) => segment.type === 'transfer' && segment.coordinates.length === 2,
    ),
  );
  assert.ok(winner.lines.every((lineName) => hasOfficialLineColor(areaKey, lineName)));
  const rideNetworkSegments = result.network.segments.filter(
    (segment) => segment.type === 'ride',
  );
  const shapedSegmentCount = rideNetworkSegments.filter(
    (segment) => segment.coordinates.length > 2,
  ).length;
  assert.ok(shapedSegmentCount / rideNetworkSegments.length > 0.98);
  assert.ok(winner.lines.every((lineName) => hasOfficialLineColor(areaKey, lineName)));
  assert.ok(winner.transferCount > 0);
  assert.ok(winner.walkingLengthMeters > 0);
  assert.equal(
    winner.transferCount,
    winner.segments.filter(({ type }) => type === 'transfer').length,
  );
  assert.ok(
    winner.segments.every(
      (segment) =>
        segment.type === 'transfer' ||
        (segment.primaryLine !== null && segment.lines.includes(segment.primaryLine)),
    ),
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
  for (const transfer of winner.segments.filter(({ type }) => type === 'transfer')) {
    assert.notEqual(transfer.from.id, transfer.to.id);
    // Distinct platform records can be stacked vertically at the same
    // published plan coordinate (for example A/C and B/D at 145 St).
    assert.ok(transfer.distanceMeters >= 0);
    assert.equal(transfer.coordinates.length, 2);
  }
  assert.ok(
    winner.segments
      .filter(({ type }) => type === 'ride')
      .some(({ coordinates }) => coordinates.length > 2),
  );

  if (areaKey === 'nyc') {
    const networkRideSegment = (firstId, secondId) =>
      result.network.segments.find(
        (segment) =>
          segment.type === 'ride' &&
          new Set([segment.from.id, segment.to.id]).has(firstId) &&
          new Set([segment.from.id, segment.to.id]).has(secondId),
      );
    const hasNetworkTransfer = (firstId, secondId) =>
      result.network.segments.some(
        (segment) =>
          segment.type === 'transfer' &&
          new Set([segment.from.id, segment.to.id]).has(firstId) &&
          new Set([segment.from.id, segment.to.id]).has(secondId),
      );
    const hasWinnerRide = (firstId, secondId, lineName) =>
      winner.segments.some(
        (segment) =>
          segment.type === 'ride' &&
          segment.lines.includes(lineName) &&
          new Set([segment.from.id, segment.to.id]).has(firstId) &&
          new Set([segment.from.id, segment.to.id]).has(secondId),
      );
    const hasWinnerTransfer = (firstId, secondId) =>
      winner.segments.some(
        (segment) =>
          segment.type === 'transfer' &&
          new Set([segment.from.id, segment.to.id]).has(firstId) &&
          new Set([segment.from.id, segment.to.id]).has(secondId),
      );
    const mondayNoonService = activeCircumferenceService(schedules, 0, 12 * 60);
    const mondayNoonNetwork = filterCircumferenceNetwork(
      result.network,
      mondayNoonService,
    );
    const mondayNoonRideLines = (firstId, secondId) =>
      mondayNoonNetwork.segments.find(
        (segment) =>
          segment.type === 'ride' &&
          new Set([segment.from.id, segment.to.id]).has(firstId) &&
          new Set([segment.from.id, segment.to.id]).has(secondId),
      )?.lines;
    assert.deepEqual(
      mondayNoonRideLines('gtfs/mta-subway/249', 'gtfs/mta-subway/250'),
      ['3', '4'],
    );
    assert.deepEqual(
      mondayNoonRideLines('gtfs/mta-subway/250', 'gtfs/mta-subway/251'),
      ['3'],
    );
    assert.deepEqual(
      mondayNoonRideLines('gtfs/mta-subway/256', 'gtfs/mta-subway/257'),
      ['3'],
    );
    assert.deepEqual(
      mondayNoonRideLines('gtfs/mta-subway/246', 'gtfs/mta-subway/247'),
      ['2', '5'],
    );
    assert.equal(
      mondayNoonNetwork.stations.find((station) => station.id === 'gtfs/mta-subway/250')
        ?.label,
      'Crown Hts-Utica Av · 3/4',
    );
    assert.equal(
      mondayNoonNetwork.stations.find((station) => station.id === 'gtfs/mta-subway/251')
        ?.label,
      'Sutter Av-Rutland Rd · 3',
    );
    assert.ok(hasWinnerRide('gtfs/mta-subway/B16', 'gtfs/mta-subway/B17', 'D'));
    assert.ok(hasWinnerRide('gtfs/mta-subway/B23', 'gtfs/mta-subway/D43', 'D'));
    assert.ok(hasWinnerRide('gtfs/mta-subway/D12', 'gtfs/mta-subway/D13', 'B'));
    assert.ok(hasWinnerTransfer('gtfs/mta-subway/A12', 'gtfs/mta-subway/D13'));
    const primaryLineBetween = (fromName, toName, concurrentLine) =>
      winner.segments.find(
        (segment) =>
          segment.type === 'ride' &&
          segment.lines.includes(concurrentLine) &&
          new Set([segment.from.name, segment.to.name]).has(fromName) &&
          new Set([segment.from.name, segment.to.name]).has(toName),
      )?.primaryLine;
    assert.equal(primaryLineBetween('125 St', '116 St', '4'), '6');
    assert.equal(primaryLineBetween('168 St', '163 St-Amsterdam Av', 'A'), 'C');
    assert.equal(primaryLineBetween('Sheepshead Bay', 'Brighton Beach', 'B'), 'Q');
    assert.equal(
      primaryLineBetween('Sutphin Blvd-Archer Av-JFK Airport', '121 St', 'Z'),
      'J',
    );
    assert.equal(result.methodology.inferredTransferCount, 0);
    assert.ok(
      result.network.segments
        .filter((segment) => segment.type === 'transfer')
        .every((segment) => segment.transferSource === 'published'),
    );
    assert.ok(
      winner.nodeIds.includes('gtfs/mta-subway/112') &&
        winner.nodeIds.includes('gtfs/mta-subway/A09'),
    );
    assert.ok(hasNetworkTransfer('gtfs/mta-subway/112', 'gtfs/mta-subway/A09'));
    assert.equal(
      winner.segments.find(
        (segment) =>
          segment.type === 'transfer' &&
          new Set([segment.from.id, segment.to.id]).has('gtfs/mta-subway/112') &&
          new Set([segment.from.id, segment.to.id]).has('gtfs/mta-subway/A09'),
      )?.transferSource,
      'published',
    );
    assert.ok(
      winner.nodeIds.includes('gtfs/mta-subway/A11') &&
        winner.nodeIds.includes('gtfs/mta-subway/D12'),
    );
    assert.equal(
      hasNetworkTransfer('gtfs/mta-subway/A11', 'gtfs/mta-subway/D12'),
      false,
    );
    const groveToJournal = networkRideSegment('gtfs/path/26728', 'gtfs/path/26731');
    assert.ok(groveToJournal);
    assert.ok(groveToJournal.coordinates.length > 2);
    assert.ok(groveToJournal.lines.includes('PATH · Newark - World Trade Center'));
    assert.equal(networkRideSegment('gtfs/path/26727', 'gtfs/path/26731'), undefined);
    assert.equal(networkRideSegment('gtfs/path/26731', 'gtfs/path/26732'), undefined);
    assert.equal(
      networkRideSegment('gtfs/path/26728', 'gtfs/path/26732')?.lines.includes(
        'PATH · Newark - World Trade Center',
      ),
      false,
    );
    const lineLayoutSegment = (firstId, secondId) => {
      const candidateSegment = winner.segments.find(
        (segment) =>
          segment.type === 'ride' &&
          new Set([segment.from.id, segment.to.id]).has(firstId) &&
          new Set([segment.from.id, segment.to.id]).has(secondId),
      );
      const networkSegment = networkRideSegment(firstId, secondId);
      assert.ok(candidateSegment);
      assert.ok(networkSegment);
      return {
        coordinates: candidateSegment.coordinates,
        displayedLines: [
          ...new Set([...candidateSegment.lines, ...networkSegment.lines]),
        ].sort(),
        fromId: candidateSegment.from.id,
        primaryLine: candidateSegment.primaryLine,
        toId: candidateSegment.to.id,
      };
    };
    const broadwayNorth = lineLayoutSegment(
      'gtfs/mta-subway/120',
      'gtfs/mta-subway/119',
    );
    const broadwaySouth = lineLayoutSegment(
      'gtfs/mta-subway/120',
      'gtfs/mta-subway/121',
    );
    const lenoxBranch = networkRideSegment(
      'gtfs/mta-subway/120',
      'gtfs/mta-subway/227',
    );
    const westSide96St =
      stationFeaturesById.get('gtfs/mta-subway/120').geometry.coordinates;
    assert.equal(
      tracksShareFromNode(
        broadwayNorth.coordinates,
        lenoxBranch.coordinates,
        westSide96St,
      ),
      true,
    );
    assert.equal(
      tracksShareFromNode(
        broadwaySouth.coordinates,
        lenoxBranch.coordinates,
        westSide96St,
      ),
      false,
    );
    const continuationLanes = junctionContinuationLineLanes(
      {
        coordinates: lenoxBranch.coordinates,
        fromId: lenoxBranch.from.id,
        lines: lenoxBranch.lines,
        toId: lenoxBranch.to.id,
      },
      [broadwayNorth, broadwaySouth],
      new Map([['gtfs/mta-subway/120', westSide96St]]),
    );
    assert.deepEqual(
      [...continuationLanes].map(([lineName, lane]) => [
        lineName,
        { index: lane.index },
      ]),
      [
        ['2', { index: 0 }],
        ['3', { index: 1 }],
      ],
    );
    assert.equal(continuationLanes.get('2').side, continuationLanes.get('3').side);
    assert.equal(Math.abs(continuationLanes.get('2').side), 1);
    for (const [fromId, toId] of [
      ['gtfs/mta-subway/F24', 'gtfs/mta-subway/F25'],
      ['gtfs/mta-subway/F25', 'gtfs/mta-subway/F26'],
      ['gtfs/mta-subway/F26', 'gtfs/mta-subway/F27'],
    ]) {
      const culverSegment = networkRideSegment(fromId, toId);
      assert.ok(culverSegment);
      assert.deepEqual(culverSegment.lines, ['F', 'FX', 'G']);
    }
    assert.equal(
      networkRideSegment('gtfs/mta-subway/F24', 'gtfs/mta-subway/F27'),
      undefined,
    );
    for (const [fromId, toId] of [
      ['gtfs/mta-subway/710', 'gtfs/mta-subway/711'],
      ['gtfs/mta-subway/711', 'gtfs/mta-subway/712'],
      ['gtfs/mta-subway/712', 'gtfs/mta-subway/713'],
      ['gtfs/mta-subway/713', 'gtfs/mta-subway/714'],
    ]) {
      assert.ok(networkRideSegment(fromId, toId)?.lines.includes('7X'));
    }
    assert.equal(
      networkRideSegment('gtfs/mta-subway/710', 'gtfs/mta-subway/712')?.display,
      false,
    );
    assert.equal(
      networkRideSegment('gtfs/mta-subway/712', 'gtfs/mta-subway/714')?.display,
      false,
    );
    const displayOnlySegments = result.network.segments.filter(
      (segment) => segment.type === 'ride' && segment.display === false,
    );
    assert.equal(displayOnlySegments.length, 14);
    assert.equal(
      result.methodology.displayOnlyShortcutCount,
      displayOnlySegments.length,
    );
    const displayedRideSegments = result.network.segments.filter(
      (segment) => segment.type === 'ride' && segment.display !== false,
    );
    for (const shortcut of displayOnlySegments) {
      for (const lineName of shortcut.lines) {
        const reachableNodeIds = new Set([shortcut.from.id]);
        const pendingNodeIds = [shortcut.from.id];
        while (pendingNodeIds.length > 0) {
          const nodeId = pendingNodeIds.shift();
          for (const segment of displayedRideSegments) {
            if (!segment.lines.includes(lineName)) continue;
            const nextNodeId =
              segment.from.id === nodeId
                ? segment.to.id
                : segment.to.id === nodeId
                  ? segment.from.id
                  : null;
            if (nextNodeId === null || reachableNodeIds.has(nextNodeId)) continue;
            reachableNodeIds.add(nextNodeId);
            pendingNodeIds.push(nextNodeId);
          }
        }
        assert.ok(
          reachableNodeIds.has(shortcut.to.id),
          `${lineName} lacks a displayed station-by-station replacement for ${shortcut.from.name} → ${shortcut.to.name}`,
        );
      }
    }
    assert.equal(
      stationFeaturesById.get('gtfs/mta-subway/D13').properties.route_ref,
      'B;D',
    );
    assert.ok(
      schedules.graph.t['gtfs/mta-subway/D13'].some(
        ([toStationId]) => toStationId === 'gtfs/mta-subway/A12',
      ),
    );
    const winnerStationNames = new Set(winner.stations.map((station) => station.name));
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
        new URL('../data/circumference-landmasses.json', import.meta.url),
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
      ['American mainland', 'Manhattan', 'Long Island', 'Roosevelt Island'],
    );
    assert.ok(
      coverage.every(
        (landmass) =>
          landmass.insideAreaSquareMeters > 0 && landmass.outsideAreaSquareMeters > 0,
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
      ['Exchange Place', 'Journal Square'],
      ['Journal Square', 'Newport'],
    ]) {
      assert.ok(removedPairs.has(pair.sort().join(' :: ')));
    }
  } else {
    assert.ok(
      winner.segments.some(
        (segment) =>
          segment.type === 'ride' &&
          segment.lines.includes('4') &&
          new Set([segment.from.name, segment.to.name]).size === 2 &&
          new Set([segment.from.name, segment.to.name]).has('Jamaica') &&
          new Set([segment.from.name, segment.to.name]).has('Santa Anita'),
      ),
    );
  }
}

console.log('Circumference route checks passed.');
