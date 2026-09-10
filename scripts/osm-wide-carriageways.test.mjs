import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { hasProperSelfIntersection } from './highway-cycle.mjs';
import {
  buildAveragedMainlines,
  buildOsmHighwayCenterlines,
  connectMainlinePartsAtSourceNodes,
} from './osm-highway-network.mjs';
import { geodesicDistanceMeters } from './wgs84-geodesy.mjs';

const coordinate = ([x, y]) => [x / 111_320, y / 110_574];
const chain = (id, points) => ({
  id,
  coordinates: points.map(coordinate),
  sourceWayIds: [id],
  tokens: new Set(['A']),
});
const widening = (height = 600) =>
  Array.from({ length: 61 }, (_, i) => [
    i * 100,
    30 + (height - 30) * Math.sin((Math.PI * i) / 60) ** 2,
  ]);
const through = [
  [0, 0],
  [6000, 0],
];

function continuousCoordinates(parts) {
  const pointKey = (point) => point.join(',');
  const endKeys = new Set(parts.map((part) => pointKey(part.coordinates.at(-1))));
  const starts = parts.filter((part) => !endKeys.has(pointKey(part.coordinates[0])));
  assert.equal(starts.length, 1, 'one continuous path must have one start');
  const remaining = new Set(parts);
  const coordinates = [];
  let current = starts[0];
  while (current) {
    assert.ok(remaining.delete(current), 'centerline must not cycle');
    coordinates.push(...current.coordinates.slice(coordinates.length ? 1 : 0));
    current = [...remaining].find(
      (part) => pointKey(part.coordinates[0]) === pointKey(coordinates.at(-1)),
    );
  }
  assert.equal(remaining.size, 0, 'every section must share an exact endpoint');
  return coordinates;
}

test('established carriageway pairs continue through a wide median in either ordering', () => {
  for (const reverseIds of [false, true]) {
    const result = buildAveragedMainlines([
      chain(reverseIds ? 'chain-2' : 'chain-1', through),
      chain(reverseIds ? 'chain-1' : 'chain-2', widening().toReversed()),
    ]);
    assert.equal(result.parts.length, 3);
    assert.equal(result.statistics.widePairContinuationCount, 1);
    const line = continuousCoordinates(result.parts);
    assert.ok(Math.min(...line.map(([x]) => x)) < coordinate([60, 0])[0]);
    assert.ok(Math.max(...line.map(([x]) => x)) > coordinate([5940, 0])[0]);
    assert.ok(
      line.some(
        ([x, y]) =>
          x > coordinate([2500, 0])[0] &&
          x < coordinate([3500, 0])[0] &&
          Math.abs(y - coordinate([0, 300])[1]) < 0.00015,
      ),
      'the centerline must use the actual carriageway midpoint inside the wide section',
    );
    for (let i = 1; i < line.length; i += 1) {
      assert.ok(geodesicDistanceMeters(line[i - 1], line[i]) < 120);
    }
  }
});

test('wide pairing needs narrow confirmation at both ends of the same opposing chain', () => {
  const unbounded = buildAveragedMainlines([
    chain('chain-1', through),
    chain('chain-2', [
      [6000, 600],
      [2000, 600],
      [500, 30],
      [0, 30],
    ]),
  ]);
  assert.equal(unbounded.statistics.widePairContinuationCount, 0);
  assert.ok(
    unbounded.parts.every((p) =>
      p.coordinates.every(([x]) => x < coordinate([1000, 0])[0]),
    ),
  );

  const differentChains = buildAveragedMainlines([
    chain('chain-1', through),
    chain(
      'chain-2',
      [
        [0, 30],
        [500, 30],
        [2000, 600],
      ].toReversed(),
    ),
    chain(
      'chain-3',
      [
        [4000, 600],
        [5500, 30],
        [6000, 30],
      ].toReversed(),
    ),
  ]);
  assert.equal(differentChains.statistics.widePairContinuationCount, 0);
  assert.ok(
    differentChains.parts.every((p) =>
      p.coordinates.every(
        ([x]) => x < coordinate([1000, 0])[0] || x > coordinate([5000, 0])[0],
      ),
    ),
  );

  const neverPaired = buildAveragedMainlines([
    chain('chain-1', through),
    chain('chain-2', [
      [6000, 600],
      [0, 600],
    ]),
  ]);
  assert.equal(neverPaired.parts.length, 0);
});

test('wide continuation needs the same closest partner from both carriageways', () => {
  for (const competitor of [
    [
      [3500, 200],
      [2500, 200],
    ],
    [
      [2500, 400],
      [3500, 400],
    ],
  ]) {
    const result = buildAveragedMainlines([
      chain('chain-1', through),
      chain('chain-2', widening().toReversed()),
      chain('chain-3', competitor),
    ]);
    assert.equal(result.statistics.widePairContinuationCount, 0);
    assert.equal(result.parts.length, 2);
    assert.ok(
      result.parts.every((p) =>
        p.coordinates.every(
          ([x]) => x < coordinate([2500, 0])[0] || x > coordinate([3500, 0])[0],
        ),
      ),
    );
  }
});

test('wide continuation rejects incompatible intermediate tangents', () => {
  for (const points of [
    [
      [0, 30],
      [500, 30],
      [2000, 30],
      [2000, 600],
      [4000, 600],
      [4000, 30],
      [5500, 30],
      [6000, 30],
    ],
  ]) {
    const result = buildAveragedMainlines([
      chain('chain-1', points),
      chain('chain-2', through.toReversed()),
    ]);
    assert.equal(result.statistics.widePairContinuationCount, 0);
    assert.ok(result.parts.length >= 2);
  }
});

test('confirmed carriageways can separate beyond two kilometers and remain continuous', () => {
  const result = buildAveragedMainlines([
    chain('chain-1', through),
    chain('chain-2', widening(2400).toReversed()),
  ]);
  assert.equal(result.parts.length, 3);
  assert.equal(result.parts.filter((part) => part.orderedContinuation).length, 1);
  const line = continuousCoordinates(result.parts);
  assert.ok(line.some((point) => point[1] > coordinate([0, 1100])[1]));
  for (let index = 1; index < line.length; index += 1) {
    assert.ok(geodesicDistanceMeters(line[index - 1], line[index]) < 120);
  }
});

test('Monteagle remains continuous through its widely separated winding carriageways in either ordering', () => {
  const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/monteagle-carriageways.json', import.meta.url)),
  );
  for (const ways of [fixture.ways, fixture.ways.toReversed()]) {
    const result = buildOsmHighwayCenterlines({ nodes: new Map(fixture.nodes), ways });
    assert.equal(result.parts.length, 3, 'only the missing mainline is added');
    assert.equal(result.statistics.orderedPairContinuationCount, 1);
    const line = continuousCoordinates(result.parts);
    const gap = line.filter(([, latitude]) => latitude > 35.174 && latitude < 35.23);
    assert.ok(gap.length > 250);
    assert.ok(
      gap.some(([longitude, latitude]) => longitude > -85.81 && latitude < 35.21),
    );
    for (let index = 1; index < line.length; index += 1) {
      assert.ok(geodesicDistanceMeters(line[index - 1], line[index]) < 140);
    }
    for (const source of result.chains) {
      const side =
        geodesicDistanceMeters(source.coordinates[0], line[0]) <
        geodesicDistanceMeters(source.coordinates.at(-1), line[0])
          ? source.coordinates
          : source.coordinates.toReversed();
      assert.equal(
        hasProperSelfIntersection([...side, ...line.toReversed(), side[0]]),
        false,
        'the continuous midpoint must stay between the two source carriageways',
      );
    }
  }
});

test('Coachochitlán retains one continuous midpoint line across the separated carriageways', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('./fixtures/coachochitlan-carriageways.json', import.meta.url),
    ),
  );
  for (const ways of [fixture.ways, fixture.ways.toReversed()]) {
    const result = buildOsmHighwayCenterlines({ nodes: new Map(fixture.nodes), ways });
    assert.equal(result.parts.length, 3);
    assert.equal(result.parts[0].role, 'mainline');
    assert.equal(result.statistics.widePairContinuationCount, 1);
    const line = continuousCoordinates(result.parts).filter(
      ([x]) => x > -100.04 && x < -99.995,
    );
    assert.ok(line.some(([x]) => x < -100.034));
    assert.ok(line.some(([x]) => x > -100.002));
    const direction = Math.sign(line.at(-1)[0] - line[0][0]);
    for (let i = 1; i < line.length; i += 1) {
      assert.ok((line[i][0] - line[i - 1][0]) * direction > 0);
      assert.ok(geodesicDistanceMeters(line[i - 1], line[i]) < 120);
    }
  }
});

test('adding a continuity segment preserves existing mainline junction geometry', () => {
  const nodes = new Map(
    Object.entries({
      west: [0, 20],
      first: [999, 20],
      second: [1050, 20],
      east: [2000, 20],
    }).map(([id, point]) => [id, { coordinate: coordinate(point), tags: {} }]),
  );
  const ways = [
    { id: 'west', nodeIds: ['west', 'first'] },
    { id: 'middle', nodeIds: ['first', 'second'] },
    { id: 'east', nodeIds: ['second', 'east'] },
  ];
  const base = [
    {
      id: 'west',
      sourceWayIds: ['west', 'middle'],
      coordinates: [
        [0, 0],
        [1000, 0],
      ].map(coordinate),
      startTopologyKeys: [],
      endTopologyKeys: ['gap-west'],
    },
    {
      id: 'east',
      sourceWayIds: ['middle', 'east'],
      coordinates: [
        [1100, 0],
        [2000, 0],
      ].map(coordinate),
      startTopologyKeys: ['gap-east'],
      endTopologyKeys: [],
    },
  ];
  const expected = structuredClone(base);
  connectMainlinePartsAtSourceNodes({ nodes }, ways, expected);
  const withContinuation = [
    ...structuredClone(base),
    {
      id: 'continuity',
      role: 'mainline',
      coordinates: [
        [1000, 0],
        [1050, 0],
        [1100, 0],
      ].map(coordinate),
      sourceWayIds: ['west', 'middle', 'east'],
      startTopologyKeys: ['gap-west'],
      endTopologyKeys: ['gap-east'],
      continuationEndpoints: { beforeId: 'west', afterId: 'east' },
    },
  ];
  connectMainlinePartsAtSourceNodes({ nodes }, ways, withContinuation);
  for (const original of expected) {
    assert.deepEqual(
      withContinuation.find((part) => part.id === original.id).coordinates,
      original.coordinates,
      'a missing section must not move an existing junction',
    );
  }
});
