import assert from 'node:assert/strict';
import test from 'node:test';

import {
  averageCarriageways,
  eligibleOsmMainlineWay,
  findDirectRampPair,
} from './highway-osm-interchange.mjs';

test('averages separated carriageways instead of offsetting from one side', () => {
  const centerline = averageCarriageways(
    [
      [
        [0, 0],
        [0, 0.01],
      ],
      [
        [0.002, 0],
        [0.002, 0.01],
      ],
    ],
    [0.001, 0],
    [0.001, 0.01],
  );
  assert.ok(centerline.length > 10);
  assert.ok(centerline.every(([longitude]) => Math.abs(longitude - 0.001) < 1e-9));
});

test('mainlines require separated one-way motorway carriageways with 2+ lanes', () => {
  const way = {
    type: 'way',
    tags: { highway: 'motorway', lanes: '2', oneway: 'yes', ref: 'US 7' },
  };
  assert.equal(eligibleOsmMainlineWay(way, 'US 7'), true);
  assert.equal(
    eligibleOsmMainlineWay({ ...way, tags: { ...way.tags, lanes: '1' } }, 'US 7'),
    false,
  );
  assert.equal(
    eligibleOsmMainlineWay(
      { ...way, tags: { ...way.tags, highway: 'motorway_link' } },
      'US 7',
    ),
    false,
  );
});

test('ramps connect only through explicit shared OSM nodes, not bridge crossings', () => {
  const node = (id, lon, lat, tags) => ({ id, lat, lon, tags, type: 'node' });
  const way = (id, nodes, tags) => ({ id, nodes, tags, type: 'way' });
  const overpass = {
    elements: [
      node(1, 0, 0),
      node(2, 1, 0),
      node(3, 0, 1),
      node(4, 1, 1),
      node(5, 0.2, 0),
      node(6, 0.5, 0.5),
      node(7, 0.8, 1),
      node(8, 0.8, 0),
      node(9, 0.5, 0.5),
      node(10, 0.2, 1),
      way(10, [1, 5, 8, 2], {
        highway: 'motorway',
        lanes: '2',
        oneway: 'yes',
        ref: 'A',
      }),
      way(11, [3, 10, 7, 4], {
        highway: 'motorway',
        lanes: '2',
        oneway: 'yes',
        ref: 'B',
      }),
      way(20, [5, 6, 7], { highway: 'motorway_link', oneway: 'yes' }),
      // This geometrically crosses the first ramp at the same coordinate but
      // uses node 9, so it is not a topological intersection.
      way(21, [8, 9, 10], { highway: 'motorway_link', oneway: 'yes' }),
    ],
  };
  const paths = findDirectRampPair(overpass, 'A', 'B');
  assert.equal(paths.length, 2);
  assert.deepEqual(
    paths.map((path) => path.wayIds),
    [[20], [21]],
  );
});

test('traffic signals invalidate a ramp-only connector', () => {
  const overpass = {
    elements: [
      { id: 1, lat: 0, lon: 0, type: 'node' },
      {
        id: 2,
        lat: 0.5,
        lon: 0.5,
        tags: { highway: 'traffic_signals' },
        type: 'node',
      },
      { id: 3, lat: 1, lon: 1, type: 'node' },
      {
        id: 10,
        nodes: [1],
        tags: { highway: 'motorway', lanes: '2', oneway: 'yes', ref: 'A' },
        type: 'way',
      },
      {
        id: 11,
        nodes: [3],
        tags: { highway: 'motorway', lanes: '2', oneway: 'yes', ref: 'B' },
        type: 'way',
      },
      {
        id: 20,
        nodes: [1, 2, 3],
        tags: { highway: 'motorway_link', oneway: 'yes' },
        type: 'way',
      },
    ],
  };
  assert.deepEqual(findDirectRampPair(overpass, 'A', 'B'), []);
});
