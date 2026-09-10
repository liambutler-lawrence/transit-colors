import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { geodesicDistanceMeters } from './wgs84-geodesy.mjs';
import { coveredMainlineMergePairs } from './highway-mainline-merges.mjs';
import {
  buildOsmHighwayCenterlines,
  buildAveragedMainlines,
  buildRampConnectors,
  connectMainlinePartsAtSourceNodes,
  prepareWays,
  traceMotorwayChains,
} from './osm-highway-network.mjs';

const metersCoordinate = ([x, y]) => [x / 111_320, y / 110_574];
const coordinateMeters = ([x, y]) => [x * 111_320, y * 110_574];

test('covered merge pairs require complete independent source support and no other attachments', () => {
  const range = (chainId, start, end) => ({ chainId, positions: [start, end] });
  const parts = [
    { id: 'branch', sourceRanges: [range('in', 0, 10), range('return', 10, 5)] },
    { id: 'through', sourceRanges: [range('out', 0, 10), range('trunk', 10, 0)] },
    { id: 'crossed', sourceRanges: [range('return', 1, 4), range('trunk', 3, 7)] },
  ];
  const chains = ['return', 'trunk'].map((id) => ({
    id,
    nodeIds: Array.from({ length: 11 }, (_, i) => `${id}-${i}`),
  }));
  const connector = {
    mixedMainline: true,
    startMainlinePartIndex: 0,
    endMainlinePartIndex: 1,
    sourceNodeIds: chains[0].nodeIds.slice(0, 6),
    sourceWayIds: ['actual-merge'],
  };
  const find = (roads = parts, ramps = [connector]) =>
    coveredMainlineMergePairs(roads, ramps, roads, chains);
  assert.deepEqual(
    find().map((entry) => entry.partId),
    ['crossed'],
  );
  const reversed = structuredClone(parts);
  for (const part of reversed)
    for (const range of part.sourceRanges) range.positions.reverse();
  assert.deepEqual(
    find(reversed).map((entry) => entry.partId),
    ['crossed'],
  );
  assert.deepEqual(
    find(parts, [
      {
        ...connector,
        sourceNodeIds: connector.sourceNodeIds.filter((id) => id !== 'return-2'),
      },
    ]),
    [],
    'a break in the reciprocal source path cannot justify removal',
  );
  const partial = structuredClone(parts);
  partial[2].sourceRanges[0].positions = [1, 5.1];
  assert.deepEqual(find(partial), [], 'do not erase an uncovered source interval');
  const truncated = structuredClone(parts);
  truncated[1].sourceRanges[1].positions = [6, 0];
  assert.deepEqual(
    find(truncated),
    [],
    'the continuing mainline must cover the other side',
  );
  assert.deepEqual(find(parts, [{ ...connector, mixedMainline: false }]), []);
  assert.deepEqual(
    find(parts, [connector, { ...connector, startMainlinePartIndex: 2 }]),
    [],
    'keep a mainline with an independent ramp attachment',
  );
  assert.deepEqual(
    find([
      ...parts.slice(0, 2),
      { ...parts[2], startTopologyKeys: ['independent-junction'] },
      { id: 'side-road', endTopologyKeys: ['independent-junction'] },
    ]),
    [],
    'keep a mainline with a separate source-proven branch connection',
  );
  assert.deepEqual(
    find([
      ...parts,
      {
        id: 'continuation',
        continuationEndpoints: { beforeId: 'crossed', afterId: 'through' },
      },
    ]),
    [],
    'keep the parent of a source-proven wide-median continuation',
  );
});

test('Kansas City keeps both reciprocal movements without a crossed mainline or jagged junctions', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('./fixtures/kansas-city-mainline-merge.json', import.meta.url),
      'utf8',
    ),
  );
  const built = buildOsmHighwayCenterlines({
    nodes: new Map(fixture.nodes),
    ways: fixture.ways,
  });
  assert.equal(built.statistics.coveredMainlineMergeCount, 1);
  const north = built.parts.find(
    (part) => part.role === 'connector' && part.sourceWayIds.includes('26140794'),
  );
  const merge = built.parts.find(
    (part) => part.mixedMainline && part.sourceWayIds.includes('526019670'),
  );
  assert.ok(north, 'preserve the northern reciprocal ramp');
  const osm = { nodes: new Map(fixture.nodes), ways: fixture.ways };
  const prepared = prepareWays(osm);
  const original = buildAveragedMainlines(traceMotorwayChains(prepared.mainlines));
  const originalThrough = structuredClone(
    original.parts.find(
      (part) =>
        part.sourceWayIds.includes('527405565') &&
        part.sourceWayIds.includes('527423798'),
    ),
  );
  connectMainlinePartsAtSourceNodes(osm, prepared.mainlines, original.parts);
  const originalRamps = buildRampConnectors(
    osm,
    prepared.mainlines,
    original.parts,
    prepared.connectors,
  );
  assert.deepEqual(
    north.coordinates,
    originalRamps.connectors.find((part) => part.sourceWayIds.includes('26140794'))
      .coordinates,
    'the valid northern ramp is unchanged by merge cleanup',
  );
  assert.ok(merge, 'preserve the real reciprocal merge through the one-lane section');
  assert.equal(built.parts.filter((part) => part.role === 'connector').length, 2);
  for (const connector of [north, merge]) {
    for (const [index, endpoint] of [
      [connector.startMainlinePartIndex, connector.coordinates[0]],
      [connector.endMainlinePartIndex, connector.coordinates.at(-1)],
    ]) {
      assert.ok(
        built.parts[index].coordinates.some(
          (point) => geodesicDistanceMeters(point, endpoint) < 0.01,
        ),
      );
    }
  }
  const through = built.parts[merge.endMainlinePartIndex];
  const section = through.coordinates.filter(
    (point) =>
      point[0] > -94.56 && point[0] < -94.55 && point[1] > 39.166 && point[1] < 39.173,
  );
  assert.ok(section.length > 10);
  for (const point of section) {
    assert.ok(
      originalThrough.coordinates.slice(1).some((end, index) => {
        const start = originalThrough.coordinates[index];
        return (
          geodesicDistanceMeters(start, point) +
            geodesicDistanceMeters(point, end) -
            geodesicDistanceMeters(start, end) <
          0.005
        );
      }),
      'the through road stays on the original paired-carriageway midpoint',
    );
  }
  const direction = Math.sign(section.at(-1)[1] - section[0][1]);
  for (let i = 1; i < section.length; i += 1) {
    assert.ok(
      (section[i][1] - section[i - 1][1]) * direction > 0,
      'the continuing mainline advances smoothly through the merge',
    );
  }
  assert.ok(
    built.parts.every(
      (part) =>
        !(part.topologyCoordinates ?? []).some(
          (entry) => entry.key === 'osm-mainline-junction:189855418',
        ),
    ),
    'an ordinary way split on the other roadway must not pull this mainline into a junction',
  );
});

test('junction projections at a segment endpoint retain their order before the terminal', () => {
  const nodes = new Map(
    Object.entries({
      west: [0, 20],
      first: [999, 20],
      second: [1050, 20],
      east: [2000, 20],
    }).map(([id, point]) => [id, { coordinate: metersCoordinate(point), tags: {} }]),
  );
  const ways = [
    { id: 'west', nodeIds: ['west', 'first'] },
    { id: 'middle', nodeIds: ['first', 'second'] },
    { id: 'east', nodeIds: ['second', 'east'] },
  ];
  const parts = [
    {
      id: 'west',
      sourceWayIds: ['west', 'middle'],
      coordinates: [
        [0, 0],
        [1000, 0],
      ],
    },
    {
      id: 'east',
      sourceWayIds: ['middle', 'east'],
      coordinates: [
        [1100, 0],
        [2000, 0],
      ],
    },
  ].map((part) => ({ ...part, coordinates: part.coordinates.map(metersCoordinate) }));
  const terminal = parts[0].coordinates.at(-1);
  connectMainlinePartsAtSourceNodes({ nodes }, ways, parts);
  assert.deepEqual(parts[0].coordinates.at(-1), terminal);
  const positions = parts[0].topologyCoordinates.map((entry) =>
    parts[0].coordinates.findIndex((point) => point.join() === entry.coordinate.join()),
  );
  assert.ok(positions[0] < positions[1]);
  assert.ok(positions[1] < parts[0].coordinates.length - 1);
});

test('staggered mainline merges share one ordered junction and preserve the through line', () => {
  for (const splitThrough of [false, true]) {
    for (const reverse of [false, true]) {
      const nodes = new Map(
        Object.entries({
          west: [0, 0],
          split: [350, 30],
          merge: [450, -30],
          east: [1000, 0],
          branchWest: [0, 200],
        }).map(([id, coordinate]) => [
          id,
          { coordinate: metersCoordinate(coordinate), tags: {} },
        ]),
      );
      const ways = [
        { id: 'through', nodeIds: ['west', 'split', 'merge', 'east'] },
        { id: 'branch-out', nodeIds: ['split', 'branchWest'] },
        { id: 'branch-in', nodeIds: ['branchWest', 'merge'] },
      ];
      const parts = (
        splitThrough
          ? [
              {
                coordinates: [
                  [0, 0],
                  [380, 0],
                ],
                sourceWayIds: ['through'],
                endTopologyKeys: ['through-seam'],
              },
              {
                coordinates: [
                  [380, 0],
                  [500, 0],
                  [1000, 0],
                ],
                sourceWayIds: ['through'],
                startTopologyKeys: ['through-seam'],
              },
            ]
          : [
              {
                coordinates: [
                  [0, 0],
                  [500, 0],
                  [1000, 0],
                ],
                sourceWayIds: ['through'],
              },
            ]
      )
        .concat([
          {
            coordinates: [
              [0, 200],
              [200, 100],
              [320, 30],
            ],
            sourceWayIds: ['branch-out', 'branch-in'],
          },
        ])
        .map((part, index) => ({
          ...part,
          id: `part-${index}`,
          coordinates: part.coordinates.map(metersCoordinate),
        }));
      if (reverse) {
        ways.reverse();
        for (const part of parts) {
          part.coordinates.reverse();
          [part.startTopologyKeys, part.endTopologyKeys] = [
            part.endTopologyKeys,
            part.startTopologyKeys,
          ];
        }
      }
      connectMainlinePartsAtSourceNodes({ nodes }, ways, parts);
      const junctions = new Set(
        parts.flatMap((part) =>
          part.topologyCoordinates.map((entry) => entry.coordinate.join()),
        ),
      );
      assert.equal(
        junctions.size,
        1,
        'opposing source merges become one centerline junction',
      );
      const junction =
        parts.at(-1).coordinates[reverse ? 0 : parts.at(-1).coordinates.length - 1];
      assert.ok(
        geodesicDistanceMeters(junction, metersCoordinate([400, 0])) < 0.02,
        JSON.stringify({ splitThrough, reverse, junction: coordinateMeters(junction) }),
      );
      for (const [index, part] of parts.entries()) {
        const points = part.coordinates.map(coordinateMeters);
        for (let i = 1; i < points.length; i += 1) {
          assert.ok(
            (points[i][0] - points[i - 1][0]) * (reverse ? -1 : 1) > 0,
            'no longitudinal backtracking',
          );
        }
        if (index < parts.length - 1) {
          assert.ok(
            points.every((point) => Math.abs(point[1]) < 0.02),
            'through geometry stays on its midpoint line',
          );
        }
      }
    }
  }
});

test('terminal adjustments preserve nearby independent mainline junctions', () => {
  const nodes = new Map(
    Object.entries({
      south: [950, -500],
      north: [950, 500],
      west: [0, 0],
      terminalJoin: [1050, 0],
      sideJoin: [980, 10],
      sideNorth: [980, 300],
    }).map(([id, point]) => [id, { coordinate: metersCoordinate(point), tags: {} }]),
  );
  const ways = [
    { id: 'through', nodeIds: ['south', 'terminalJoin', 'north'] },
    { id: 'branch', nodeIds: ['west', 'sideJoin', 'terminalJoin'] },
    { id: 'side', nodeIds: ['sideJoin', 'sideNorth'] },
  ];
  const parts = [
    [
      [950, -500],
      [950, 500],
    ],
    [
      [0, 0],
      [1000, 0],
    ],
    [
      [980, 10],
      [980, 300],
    ],
  ].map((coordinates, index) => ({
    coordinates: coordinates.map(metersCoordinate),
    id: ways[index].id,
    sourceWayIds: [ways[index].id],
  }));
  connectMainlinePartsAtSourceNodes({ nodes }, ways, parts);
  const branch = parts[1];
  assert.ok(
    geodesicDistanceMeters(branch.coordinates.at(-1), metersCoordinate([1000, 0])) <
      0.02,
  );
  assert.ok(
    branch.coordinates.some(
      (point) => geodesicDistanceMeters(point, metersCoordinate([980, 0])) < 0.02,
    ),
  );
  assert.equal(
    new Set(branch.topologyCoordinates.map((entry) => entry.coordinate.join())).size,
    2,
  );
  for (const part of parts) {
    assert.ok(part.coordinates.length >= 2);
    for (const topology of part.topologyCoordinates) {
      assert.ok(
        part.coordinates.some((point) => point.join() === topology.coordinate.join()),
      );
    }
  }
});

test('Viaducto mainlines form one clean three-arm merge without ramp connectors', () => {
  const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/viaducto-merge.json', import.meta.url), 'utf8'),
  );
  for (const ways of [fixture.ways, [...fixture.ways].reverse()]) {
    const osm = { nodes: new Map(fixture.nodes), ways };
    const built = buildOsmHighwayCenterlines(osm);
    assert.ok(built.parts.length >= 2);
    assert.ok(built.parts.every((part) => part.role === 'mainline'));
    const mergeKeys = new Set([
      'osm-mainline-junction:268456993',
      'osm-mainline-junction:1395878681',
    ]);
    const junctions = built.parts.flatMap((part) =>
      (part.topologyCoordinates ?? []).filter((entry) => mergeKeys.has(entry.key)),
    );
    assert.equal(new Set(junctions.map((entry) => entry.coordinate.join())).size, 1);
    const shared = junctions[0].coordinate;
    assert.ok(geodesicDistanceMeters(shared, [-99.1744359, 19.398513]) < 5);
    let incidentEdges = 0;
    for (const part of built.parts) {
      const direction = Math.sign(part.coordinates.at(-1)[0] - part.coordinates[0][0]);
      for (let index = 1; index < part.coordinates.length; index += 1) {
        const before = part.coordinates[index - 1];
        const after = part.coordinates[index];
        assert.ok(
          (after[0] - before[0]) * direction > 0,
          'mainline must advance through the merge',
        );
        if (before.join() === shared.join() || after.join() === shared.join())
          incidentEdges += 1;
      }
    }
    assert.equal(
      incidentEdges,
      3,
      'exactly three mainline arms meet at the shared vertex',
    );
  }
});
