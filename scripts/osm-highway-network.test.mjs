import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOsmHighwayCenterlines,
  buildRampConnectors,
  classifyOsmMotorwayWay,
  parseOplLine,
  prepareWays,
  traceMotorwayChains,
} from './osm-highway-network.mjs';

test('OPL parser preserves explicit node identities and motorway tags', () => {
  const node = parseOplLine('n42 v1 dV c0 t x-73.4 y41.1');
  const way = parseOplLine(
    'w9 v1 dV c0 t Thighway=motorway,lanes=3,oneway=yes,ref=I%2095 Nn1,n42,n3',
  );
  assert.deepEqual(node, {
    coordinate: [-73.4, 41.1],
    id: '42',
    tags: {},
    type: 'node',
  });
  assert.equal(way.tags.ref, 'I 95');
  assert.deepEqual(way.nodeIds, ['1', '42', '3']);
});

test('ramp connectors use explicit OSM nodes and ignore coordinate-only crossings', () => {
  const nodes = new Map([
    ['1', { coordinate: [0, 0], tags: {} }],
    ['2', { coordinate: [1, 0], tags: {} }],
    ['3', { coordinate: [0, 1], tags: {} }],
    ['4', { coordinate: [1, 1], tags: {} }],
    ['5', { coordinate: [0, 0.5], tags: {} }],
    ['6', { coordinate: [0, 0.5], tags: {} }],
  ]);
  const mainlineWays = [
    { id: '10', nodeIds: ['1', '2'] },
    { id: '11', nodeIds: ['3', '4'] },
  ];
  const parts = [
    {
      coordinates: [
        [0, 0],
        [1, 0],
      ],
      sourceWayIds: ['10'],
      tokens: ['A'],
    },
    {
      coordinates: [
        [0, 1],
        [1, 1],
      ],
      sourceWayIds: ['11'],
      tokens: ['B'],
    },
  ];
  const connectorWays = [
    { id: '20', nodeIds: ['1', '5', '3'] },
    // This node shares coordinates with node 5 but not its identity, so it
    // cannot jump onto the A-to-B connector.
    { id: '21', nodeIds: ['2', '6'] },
  ];
  const result = buildRampConnectors({ nodes }, mainlineWays, parts, connectorWays);
  assert.equal(result.connectors.length, 1);
  assert.deepEqual(result.connectors[0].sourceNodeIds, ['1', '5', '3']);
});

test('explicit one-lane motorway branches and links remain connectors', () => {
  assert.equal(
    classifyOsmMotorwayWay({
      tags: { highway: 'motorway', lanes: '2', oneway: 'yes' },
    }),
    'mainline',
  );
  assert.equal(
    classifyOsmMotorwayWay({
      tags: { highway: 'motorway', lanes: '1', oneway: 'yes' },
    }),
    'connector',
  );
  assert.equal(
    classifyOsmMotorwayWay({
      tags: { highway: 'motorway_link', lanes: '1', oneway: 'yes' },
    }),
    'connector',
  );
});

test('network-wide averaging stays between opposing carriageways', () => {
  const nodes = new Map([
    ['1', { coordinate: [0, 0], tags: {} }],
    ['2', { coordinate: [0.01, 0], tags: {} }],
    ['3', { coordinate: [0.01, 0.001], tags: {} }],
    ['4', { coordinate: [0, 0.001], tags: {} }],
  ]);
  const ways = [
    {
      id: '10',
      nodeIds: ['1', '2'],
      tags: { highway: 'motorway', lanes: '2', oneway: 'yes', ref: 'A 1' },
    },
    {
      id: '11',
      nodeIds: ['3', '4'],
      tags: { highway: 'motorway', lanes: '2', oneway: 'yes', ref: 'A 1' },
    },
  ];
  const result = buildOsmHighwayCenterlines({ nodes, ways });
  assert.equal(result.parts.length, 1);
  assert.ok(
    result.parts[0].coordinates.every(
      ([, latitude]) => Math.abs(latitude - 0.0005) < 1e-9,
    ),
  );
});

test('shared freeway termini do not merge opposing carriageways into one chain', () => {
  const nodes = new Map([
    ['1', { coordinate: [0, 0], tags: {} }],
    ['2', { coordinate: [0.005, 0], tags: {} }],
    ['3', { coordinate: [0.01, 0.0005], tags: {} }],
    ['4', { coordinate: [0.005, 0.001], tags: {} }],
  ]);
  const ways = [
    {
      id: '10',
      nodeIds: ['1', '2', '3'],
      tags: { highway: 'motorway', lanes: '2', oneway: 'yes', ref: 'A 1' },
    },
    {
      id: '11',
      nodeIds: ['3', '4', '1'],
      tags: { highway: 'motorway', lanes: '2', oneway: 'yes', ref: 'A 1' },
    },
  ];
  const chains = traceMotorwayChains(prepareWays({ nodes, ways }).mainlines);
  assert.equal(chains.length, 2);

  const result = buildOsmHighwayCenterlines({ nodes, ways });
  assert.equal(result.parts.length, 1);
  assert.ok(
    result.parts[0].coordinates.some(
      ([, latitude]) => Math.abs(latitude - 0.0005) < 1e-9,
    ),
  );
});
