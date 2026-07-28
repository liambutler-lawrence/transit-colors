import assert from 'node:assert/strict';
import test from 'node:test';

import { buildOsmRouteCenterlines } from './osm-route-centerlines.mjs';
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
  const centerline = result.geometries.alpha[0][1];
  assert.deepEqual(centerline[0], [0, 0]);
  assert.deepEqual(centerline.at(-1), [0.02, 0]);
  assert.ok(Math.abs(centerline[Math.floor(centerline.length / 2)][1]) < 1e-9);
});
