import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { geodesicDistanceMeters } from './wgs84-geodesy.mjs';
import {
  buildOsmHighwayCenterlines,
  connectMainlinePartsAtSourceNodes,
} from './osm-highway-network.mjs';

const metersCoordinate = ([x, y]) => [x / 111_320, y / 110_574];
const coordinateMeters = ([x, y]) => [x * 111_320, y * 110_574];

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
