import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOsmRouteCenterlines,
  osmRouteObservation,
} from './osm-route-centerlines.mjs';
import { stationEdgeKey } from './gtfs-shape-centerlines.mjs';

function relationData(relationId, latitudeOffset, reverse = false) {
  const nodes = [
    { id: 1, lat: latitudeOffset, lon: 0, tags: { name: 'Alpha' }, type: 'node' },
    { id: 2, lat: latitudeOffset, lon: 0.01, type: 'node' },
    { id: 3, lat: latitudeOffset, lon: 0.02, tags: { name: 'Bravo' }, type: 'node' },
  ];
  const orderedNodes = reverse ? [3, 2, 1] : [1, 2, 3];
  const orderedStops = reverse ? [3, 1] : [1, 3];
  return {
    elements: [
      ...nodes,
      {
        id: 10,
        nodes: orderedNodes,
        tags: { railway: 'subway' },
        type: 'way',
      },
      {
        id: relationId,
        members: [
          ...orderedStops.map((ref) => ({ ref, role: 'stop', type: 'node' })),
          { ref: 10, role: '', type: 'way' },
        ],
        type: 'relation',
      },
    ],
  };
}

function multiWayRelation(wayIds) {
  return {
    elements: [
      ...[
        [0, 0],
        [0.01, 0],
        [0.015, -0.005],
        [0.02, 0],
        [0.03, 0],
      ].map(([lon, lat], index) => ({ type: 'node', id: index + 1, lon, lat })),
      ...[
        [10, [1, 2]],
        [11, [2, 3, 4]],
        [12, [4, 5]],
      ].map(([id, nodes]) => ({
        type: 'way',
        id,
        nodes,
        tags: { railway: 'subway' },
      })),
      {
        type: 'relation',
        id: 100,
        members: wayIds.map((ref) => ({ type: 'way', ref, role: '' })),
      },
    ],
  };
}

test('consecutive duplicate OSM track members do not retrace a section', () => {
  const expected = [
    [0, 0],
    [0.01, 0],
    [0.015, -0.005],
    [0.02, 0],
    [0.03, 0],
  ];
  for (const wayIds of [
    [10, 11, 11, 12],
    [10, 10, 11, 12, 12],
  ]) {
    assert.deepEqual(
      osmRouteObservation(multiWayRelation(wayIds), 100).coordinates,
      expected,
    );
  }
});

test('OSM routes retain nonconsecutive revisits to a track member', () => {
  const observation = osmRouteObservation(multiWayRelation([10, 11, 12, 11, 10]), 100);
  assert.deepEqual(observation.coordinates.at(-1), [0, 0]);
  assert.equal(
    observation.coordinates.filter(([lon, lat]) => lon === 0.015 && lat === -0.005)
      .length,
    2,
  );
});

test('OpenStreetMap directional route relations average between track sides', () => {
  const stationCoordinateById = new Map([
    ['alpha', [0, 0]],
    ['bravo', [0.02, 0]],
  ]);
  const result = buildOsmRouteCenterlines({
    allowedEdgeKeys: new Set([stationEdgeKey('alpha', 'bravo')]),
    namesMatch: (first, second) => first === second,
    relations: [
      {
        data: relationData(100, 0.001),
        lineName: 'M1',
        relationId: 100,
      },
      {
        data: relationData(101, -0.001, true),
        lineName: 'M1',
        relationId: 101,
      },
    ],
    stationCandidatesByLine: new Map([
      [
        'M1',
        [
          { coordinate: [0, 0], id: 'alpha', name: 'Alpha' },
          { coordinate: [0.02, 0], id: 'bravo', name: 'Bravo' },
        ],
      ],
    ]),
    stationCoordinateById,
  });

  assert.equal(result.edgeCount, 1);
  assert.equal(result.routeObservationCount, 2);
  assert.equal(result.shapeObservationCount, 2);
  assert.deepEqual(result.platformCoordinateById.get('alpha'), [0, 0]);
  assert.deepEqual(result.platformCoordinateById.get('bravo'), [0.02, 0]);
  const centerline = result.geometries.alpha[0][1];
  assert.deepEqual(centerline[0], [0, 0]);
  assert.deepEqual(centerline.at(-1), [0.02, 0]);
  assert.ok(Math.abs(centerline[Math.floor(centerline.length / 2)][1]) < 1e-9);
});

test('OpenStreetMap stop positions replace off-track station centroids', () => {
  const stationCoordinateById = new Map([
    ['alpha', [0, 0.004]],
    ['bravo', [0.02, 0.004]],
  ]);
  const result = buildOsmRouteCenterlines({
    allowedEdgeKeys: new Set([stationEdgeKey('alpha', 'bravo')]),
    namesMatch: (first, second) => first === second,
    relations: [
      {
        data: relationData(102, 0.001),
        lineName: 'M1',
        relationId: 102,
      },
    ],
    stationCandidatesByLine: new Map([
      [
        'M1',
        [
          { coordinate: [0, 0.004], id: 'alpha', name: 'Alpha' },
          { coordinate: [0.02, 0.004], id: 'bravo', name: 'Bravo' },
        ],
      ],
    ]),
    stationCoordinateById,
  });

  assert.deepEqual(result.platformCoordinateById.get('alpha'), [0, 0.001]);
  assert.deepEqual(result.platformCoordinateById.get('bravo'), [0.02, 0.001]);
  assert.deepEqual(result.geometries.alpha[0][1][0], [0, 0.001]);
  assert.deepEqual(result.geometries.alpha[0][1].at(-1), [0.02, 0.001]);
});
