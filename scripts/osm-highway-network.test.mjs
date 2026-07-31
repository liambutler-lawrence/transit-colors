import assert from 'node:assert/strict';
import test from 'node:test';

import {
  averageReciprocalPathCoordinates,
  buildOsmHighwayCenterlines,
  buildPairedOsmSourceTopologyGraph,
  buildRampConnectors,
  classifyOsmMotorwayWay,
  parseOplLine,
  prepareWays,
  removeRampTerminalHooks,
  traceMotorwayChains,
} from './osm-highway-network.mjs';

function coordinateBounds(coordinates) {
  return coordinates.reduce(
    (bounds, [longitude, latitude]) => [
      Math.min(bounds[0], longitude),
      Math.min(bounds[1], latitude),
      Math.max(bounds[2], longitude),
      Math.max(bounds[3], latitude),
    ],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
}

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
    ['2', { coordinate: [0.01, 0], tags: {} }],
    ['3', { coordinate: [0, 0.01], tags: {} }],
    ['4', { coordinate: [0.01, 0.01], tags: {} }],
    ['5', { coordinate: [0, 0.005], tags: {} }],
    ['6', { coordinate: [0, 0.005], tags: {} }],
    ['7', { coordinate: [0.0001, 0.005], tags: {} }],
  ]);
  const mainlineWays = [
    { id: '10', nodeIds: ['1', '2'] },
    { id: '11', nodeIds: ['3', '4'] },
  ];
  const parts = [
    {
      coordinates: [
        [0, 0],
        [0.01, 0],
      ],
      sourceWayIds: ['10'],
      tokens: ['A'],
    },
    {
      coordinates: [
        [0, 0.01],
        [0.01, 0.01],
      ],
      sourceWayIds: ['11'],
      tokens: ['B'],
    },
  ];
  const connectorWays = [
    { id: '20', nodeIds: ['1', '5', '3'] },
    { id: '22', nodeIds: ['3', '7', '1'] },
    // This node shares coordinates with node 5 but not its identity, so it
    // cannot jump onto the A-to-B connector.
    { id: '21', nodeIds: ['2', '6'] },
  ];
  const result = buildRampConnectors({ nodes }, mainlineWays, parts, connectorWays);
  assert.equal(result.connectors.length, 1);
  assert.equal(result.connectors[0].pairedDirectionCount, 2);
  assert.deepEqual(new Set(result.connectors[0].sourceWayIds), new Set(['20', '22']));
  assert.ok(!result.connectors[0].sourceNodeIds.includes('6'));
});

test('classic T interchange produces two paired centerlines and a triangle', () => {
  const nodes = new Map(
    Object.entries({
      stemWestOut: [-0.0003, -0.006],
      stemWestIn: [0.0003, -0.0055],
      stemEastOut: [0.0003, -0.006],
      stemEastIn: [-0.0003, -0.0055],
      westIn: [-0.006, 0.0003],
      westOut: [-0.006, -0.0003],
      eastIn: [0.006, -0.0003],
      eastOut: [0.006, 0.0003],
      westForward: [-0.003, -0.003],
      westReverse: [-0.003, -0.0025],
      eastForward: [0.003, -0.003],
      eastReverse: [0.003, -0.0025],
    }).map(([id, coordinate]) => [id, { coordinate, tags: {} }]),
  );
  const mainlineWays = [
    {
      id: 'stem-a',
      nodeIds: ['stemWestOut', 'stemEastOut'],
    },
    {
      id: 'stem-b',
      nodeIds: ['stemEastIn', 'stemWestIn'],
    },
    {
      id: 'through-a',
      nodeIds: ['westOut', 'eastIn'],
    },
    {
      id: 'through-b',
      nodeIds: ['eastOut', 'westIn'],
    },
  ];
  const parts = [
    {
      coordinates: [
        [0, -0.02],
        [0, -0.004],
      ],
      id: 'stem',
      role: 'mainline',
      sourceWayIds: ['stem-a', 'stem-b'],
      tokens: ['MA3'],
    },
    {
      coordinates: [
        [-0.02, 0],
        [0.02, 0],
      ],
      id: 'through',
      role: 'mainline',
      sourceWayIds: ['through-a', 'through-b'],
      tokens: ['I95'],
    },
  ];
  const connectorWays = [
    {
      id: 'stem-to-west',
      nodeIds: ['stemWestOut', 'westForward', 'westIn'],
    },
    {
      id: 'west-to-stem',
      nodeIds: ['westOut', 'westReverse', 'stemWestIn'],
    },
    {
      id: 'stem-to-east',
      nodeIds: ['stemEastOut', 'eastForward', 'eastIn'],
    },
    {
      id: 'east-to-stem',
      nodeIds: ['eastOut', 'eastReverse', 'stemEastIn'],
    },
  ];
  const result = buildRampConnectors({ nodes }, mainlineWays, parts, connectorWays);
  assert.equal(result.connectors.length, 2);
  assert.equal(result.statistics.directedConnectorPathCount, 4);
  assert.equal(result.statistics.unpairedConnectorPathCount, 0);
  assert.ok(
    result.connectors.every(
      (connector) =>
        connector.coordinates[0][1] < -0.004 &&
        Math.abs(connector.coordinates.at(-1)[1]) < 1e-9,
    ),
  );
  assert.ok(result.connectors.some((connector) => connector.coordinates.at(-1)[0] < 0));
  assert.ok(result.connectors.some((connector) => connector.coordinates.at(-1)[0] > 0));
});

test('reciprocal matcher uses directional legs instead of nearest ramp endpoints', () => {
  const nodeCoordinates = {
    aAfter: [0.012, -0.0001],
    aBefore: [-0.002, -0.0001],
    aCorrect: [0.008, 0.0001],
    aSource: [0, -0.0001],
    aWestEnd: [-0.002, 0.0001],
    aWrong: [0.0001, -0.0001],
    bAfter: [0.012, 0.0099],
    bBefore: [-0.002, 0.0099],
    bCorrect: [0.008, 0.0101],
    bTarget: [0, 0.0099],
    bWestEnd: [-0.002, 0.0101],
    bWrong: [0.0001, 0.0099],
    correctMiddle: [0.004, 0.0051],
    forwardMiddle: [0.002, 0.005],
    wrongMiddle: [0.0002, 0.005],
  };
  const nodes = new Map(
    Object.entries(nodeCoordinates).map(([id, coordinate]) => [
      id,
      { coordinate, tags: {} },
    ]),
  );
  const mainlineWays = [
    {
      id: 'a-east',
      nodeIds: ['aBefore', 'aSource', 'aWrong', 'aAfter'],
    },
    {
      id: 'a-west',
      nodeIds: ['aAfter', 'aCorrect', 'aWestEnd'],
    },
    {
      id: 'b-east',
      nodeIds: ['bBefore', 'bTarget', 'bWrong', 'bAfter'],
    },
    {
      id: 'b-west',
      nodeIds: ['bAfter', 'bCorrect', 'bWestEnd'],
    },
  ];
  const parts = [
    {
      coordinates: [
        [-0.02, 0],
        [0.02, 0],
      ],
      id: 'a',
      role: 'mainline',
      sourceWayIds: ['a-east', 'a-west'],
      tokens: ['A'],
    },
    {
      coordinates: [
        [-0.02, 0.01],
        [0.02, 0.01],
      ],
      id: 'b',
      role: 'mainline',
      sourceWayIds: ['b-east', 'b-west'],
      tokens: ['B'],
    },
  ];
  const connectorWays = [
    {
      id: 'forward',
      nodeIds: ['aSource', 'forwardMiddle', 'bTarget'],
    },
    {
      id: 'correct-reciprocal',
      nodeIds: ['bCorrect', 'correctMiddle', 'aCorrect'],
    },
    {
      id: 'wrong-same-direction',
      nodeIds: ['bWrong', 'wrongMiddle', 'aWrong'],
    },
  ];
  const result = buildRampConnectors({ nodes }, mainlineWays, parts, connectorWays);
  assert.equal(result.connectors.length, 1);
  assert.deepEqual(
    new Set(result.connectors[0].sourceWayIds),
    new Set(['forward', 'correct-reciprocal']),
  );
  assert.equal(result.statistics.unpairedConnectorPathCount, 1);
});

test('shape-aware ramp average retains a smaller loop between unlike paths', () => {
  const directPath = [
    [0, -0.012],
    [0.002, -0.008],
    [0.007, -0.003],
    [0.012, 0],
  ];
  const loopPath = [
    [0, 0.012],
    [-0.006, 0.011],
    [-0.01, 0.006],
    [-0.009, 0],
    [-0.006, -0.005],
    [0, -0.007],
    [0.006, -0.005],
    [0.01, -0.001],
    [0.012, 0.001],
  ];
  const averaged = averageReciprocalPathCoordinates(
    directPath,
    loopPath,
    [0, 0],
    [0.012, 0.0005],
  );
  const bounds = coordinateBounds(averaged);
  assert.deepEqual(averaged[0], [0, 0]);
  assert.deepEqual(averaged.at(-1), [0.012, 0.0005]);
  assert.ok(bounds[0] < -0.004 && bounds[0] > -0.006);
  assert.ok(bounds[1] < -0.009 && bounds[1] > -0.01);
  assert.ok(averaged.length > 100);
});

test('terminal correspondence hooks are removed from Chattanooga ramp averages', () => {
  const eastConnector = [
    [-85.4537644, 34.9652314],
    [-85.4536329, 34.9654011],
    [-85.4535015, 34.9655709],
    [-85.45337, 34.9657406],
    [-85.4531764, 34.9658891],
    [-85.4529741, 34.9660346],
    [-85.4527772, 34.9661854],
    [-85.4526008, 34.9663566],
    [-85.4524239, 34.9665273],
    [-85.4522485, 34.9666992],
    [-85.4457247, 34.9712172],
    [-85.4454567, 34.9712576],
    [-85.4451879, 34.9712928],
    [-85.4449174, 34.9713163],
    [-85.4446481, 34.971342],
    [-85.4443871, 34.9713982],
    [-85.4441256, 34.971449],
    [-85.4438784, 34.9714714],
    [-85.4436682, 34.9714276],
    [-85.4435813, 34.9713509],
  ];
  const northConnector = [
    [-85.4537644, 34.9652314],
    [-85.4537913, 34.9653383],
    [-85.4537075, 34.9655095],
    [-85.4535817, 34.965673],
    [-85.4533934, 34.9658258],
    [-85.4532085, 34.9659804],
    [-85.4530255, 34.9661362],
    [-85.4528639, 34.9663082],
    [-85.4527268, 34.9664974],
    [-85.4525981, 34.9666907],
    [-85.4547389, 34.9749091],
    [-85.4548749, 34.9750992],
    [-85.4550077, 34.9752909],
    [-85.4550533, 34.9753916],
    [-85.4551406, 34.9755966],
    [-85.4552265, 34.9758024],
    [-85.4553137, 34.9760076],
    [-85.4554044, 34.9762075],
    [-85.4555594, 34.9762972],
    [-85.4557131, 34.9763876],
  ];
  const eastSmoothed = removeRampTerminalHooks(eastConnector);
  const northSmoothed = removeRampTerminalHooks(northConnector);

  assert.deepEqual(eastSmoothed[0], eastConnector[0]);
  assert.deepEqual(eastSmoothed.at(-1), eastConnector.at(-1));
  assert.deepEqual(northSmoothed[0], northConnector[0]);
  assert.deepEqual(northSmoothed.at(-1), northConnector.at(-1));
  assert.equal(eastConnector.length - eastSmoothed.length, 2);
  assert.equal(northConnector.length - northSmoothed.length, 2);
});

test('unpaired one-way ramps are excluded from display and topology', () => {
  const nodes = new Map([
    ['1', { coordinate: [0, 0], tags: {} }],
    ['2', { coordinate: [0.01, 0], tags: {} }],
    ['3', { coordinate: [0, 0.01], tags: {} }],
    ['4', { coordinate: [0.01, 0.01], tags: {} }],
    ['5', { coordinate: [0.005, 0.005], tags: {} }],
  ]);
  const parts = [
    {
      coordinates: [
        [0, 0],
        [0.01, 0],
      ],
      id: 'a',
      role: 'mainline',
      sourceWayIds: ['10'],
      tokens: ['A'],
    },
    {
      coordinates: [
        [0, 0.01],
        [0.01, 0.01],
      ],
      id: 'b',
      role: 'mainline',
      sourceWayIds: ['11'],
      tokens: ['B'],
    },
  ];
  const result = buildRampConnectors(
    { nodes },
    [
      { id: '10', nodeIds: ['1', '2'] },
      { id: '11', nodeIds: ['3', '4'] },
    ],
    parts,
    [{ id: '20', nodeIds: ['1', '5', '3'] }],
  );
  assert.equal(result.connectors.length, 0);
  assert.equal(result.statistics.directedConnectorPathCount, 1);
  assert.equal(result.statistics.unpairedConnectorPathCount, 1);
});

test('explicit topology does not connect coordinate-only centerline crossings', () => {
  const parts = [
    {
      coordinates: [
        [-0.01, 0],
        [0, 0],
        [0.01, 0],
      ],
      id: 'horizontal',
      role: 'mainline',
      sourceWayIds: ['1'],
      tokens: ['A'],
    },
    {
      coordinates: [
        [0, -0.01],
        [0, 0],
        [0, 0.01],
      ],
      id: 'vertical',
      role: 'mainline',
      sourceWayIds: ['2'],
      tokens: ['B'],
    },
  ];
  const graph = buildPairedOsmSourceTopologyGraph(
    {
      nodes: new Map([
        ['h1', { coordinate: [-0.01, 0], tags: {} }],
        ['hx', { coordinate: [0, 0], tags: {} }],
        ['h2', { coordinate: [0.01, 0], tags: {} }],
        ['v1', { coordinate: [0, -0.01], tags: {} }],
        ['vx', { coordinate: [0, 0], tags: {} }],
        ['v2', { coordinate: [0, 0.01], tags: {} }],
      ]),
      ways: [
        {
          id: '1',
          nodeIds: ['h1', 'hx', 'h2'],
          tags: { highway: 'motorway', lanes: '2', oneway: 'yes' },
        },
        {
          id: '2',
          nodeIds: ['v1', 'vx', 'v2'],
          tags: { highway: 'motorway', lanes: '2', oneway: 'yes' },
        },
      ],
    },
    parts,
  );
  assert.equal(graph.coordinateByNodeId.size, 6);
  assert.equal(graph.edges.length, 4);
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
