import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { geodesicDistanceMeters } from './wgs84-geodesy.mjs';
import { hasProperSelfIntersection } from './highway-cycle.mjs';

import {
  averageReciprocalPathCoordinates,
  buildAveragedMainlines,
  buildOsmHighwayCenterlines,
  buildPairedOsmSourceTopologyGraph,
  buildRampConnectors,
  classifyOsmMotorwayWay,
  parseOplLine,
  prepareWays,
  selectShortestReciprocalMovements,
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

test('source-mapped ramps remain paired after carriageways diverge early', () => {
  const nodes = new Map(
    Object.entries({
      aForward: [0, -0.006],
      aReverse: [0.01, -0.006],
      bForward: [0, 0.026],
      bReverse: [0.01, 0.026],
      forwardMiddle: [0.004, 0.01],
      reverseMiddle: [0.006, 0.01],
    }).map(([id, coordinate]) => [id, { coordinate, tags: {} }]),
  );
  const mainlineWays = [
    { id: 'a-forward', nodeIds: ['aForward', 'aReverse'] },
    { id: 'a-reverse', nodeIds: ['aReverse', 'aForward'] },
    { id: 'b-forward', nodeIds: ['bForward', 'bReverse'] },
    { id: 'b-reverse', nodeIds: ['bReverse', 'bForward'] },
  ];
  const parts = [
    {
      coordinates: [
        [0, 0],
        [0.01, 0],
      ],
      id: 'a',
      role: 'mainline',
      sourceWayIds: ['a-forward', 'a-reverse'],
      tokens: ['A'],
    },
    {
      coordinates: [
        [0, 0.02],
        [0.01, 0.02],
      ],
      id: 'b',
      role: 'mainline',
      sourceWayIds: ['b-forward', 'b-reverse'],
      tokens: ['B'],
    },
  ];
  const connectorWays = [
    {
      id: 'forward',
      nodeIds: ['aForward', 'forwardMiddle', 'bForward'],
    },
    {
      id: 'reverse',
      nodeIds: ['bReverse', 'reverseMiddle', 'aReverse'],
    },
  ];

  const result = buildRampConnectors({ nodes }, mainlineWays, parts, connectorWays);

  assert.equal(result.connectors.length, 1);
  assert.equal(result.statistics.unpairedConnectorPathCount, 0);
  assert.deepEqual(result.connectors[0].coordinates[0], [0, 0]);
  assert.deepEqual(result.connectors[0].coordinates.at(-1), [0.01, 0.02]);
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

const metersCoordinate = ([x, y]) => [x / 111_320, y / 110_574];
const coordinateMeters = ([x, y]) => [x * 111_320, y * 110_574];

test('mainline midpoints stop at both ends of the shared carriageway extent', () => {
  for (const reverseIds of [false, true]) {
    const chains = [
      [
        [0, 0],
        [1000, 0],
      ],
      Array.from({ length: 13 }, (_, index) => [800 - index * 50, 20]),
    ].map((coordinates, index) => ({
      id: `chain-${reverseIds ? 2 - index : index + 1}`,
      coordinates: coordinates.map(metersCoordinate),
      sourceWayIds: [`way-${index}`],
      tokens: new Set(['A']),
    }));
    const result = buildAveragedMainlines(chains);
    assert.equal(result.parts.length, 1);
    const coordinates = result.parts[0].coordinates.map(coordinateMeters);
    assert.ok(coordinates.length > 10);
    for (const [x, y] of coordinates) {
      assert.ok(
        x >= 200 - 0.02 && x <= 800 + 0.02,
        `unpaired longitudinal tail at ${x}`,
      );
      assert.ok(Math.abs(y - 10) < 0.02);
    }
  }
});

test('interior corner vertices remain eligible for mainline midpoint matching', () => {
  const chains = [
    [
      [0, -20],
      [520, -20],
      [520, 500],
    ],
    [
      [500, 500],
      [500, 0],
      [0, 0],
    ],
  ].map((coordinates, index) => ({
    id: `chain-${index + 1}`,
    coordinates: coordinates.map(metersCoordinate),
    sourceWayIds: [`way-${index}`],
    tokens: new Set(['A']),
  }));
  const result = buildAveragedMainlines(chains);
  assert.equal(result.parts.length, 1);
  const coordinates = result.parts[0].coordinates.map(coordinateMeters);
  assert.ok(coordinates.some(([x, y]) => x > 495 && y < 0));
  assert.ok(coordinates.some(([x, y]) => x > 500 && y > 480));
});

test('a closed carriageway has no terminal gap at its source seam', () => {
  const chains = [500, 450].map((radius, index) => {
    const coordinates = Array.from({ length: 72 }, (_, sampleIndex) => {
      const angle = (sampleIndex / 72) * Math.PI * 2 * (index === 0 ? 1 : -1);
      return metersCoordinate([Math.cos(angle) * radius, Math.sin(angle) * radius]);
    });
    coordinates.push(coordinates[0]);
    return {
      id: `chain-${index + 1}`,
      coordinates,
      startNodeId: `seam-${index}`,
      endNodeId: `seam-${index}`,
      sourceWayIds: [`way-${index}`],
      tokens: new Set(['A']),
    };
  });
  const result = buildAveragedMainlines(chains);
  assert.equal(result.parts.length, 1);
  assert.deepEqual(result.parts[0].coordinates[0], result.parts[0].coordinates.at(-1));
  assert.ok(
    geodesicDistanceMeters(result.parts[0].coordinates[0], metersCoordinate([475, 0])) <
      0.02,
  );
});

test('Stone Mountain mainline has no unsupported terminal spur and keeps both ramp pairs', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('./fixtures/stone-mountain-interchange.json', import.meta.url),
      'utf8',
    ),
  );
  const osm = { nodes: new Map(fixture.nodes), ways: fixture.ways };
  const built = buildOsmHighwayCenterlines(osm);
  const mainline = built.parts.find(
    (part) => part.role === 'mainline' && part.sourceWayIds.includes('9178261'),
  );
  const oldSpurTip = [-84.1702383, 33.8189497];
  assert.ok(
    mainline.coordinates.every(
      (point) => geodesicDistanceMeters(point, oldSpurTip) > 90,
    ),
  );
  assert.ok(
    mainline.coordinates.some(
      (point) => geodesicDistanceMeters(point, [-84.1717399, 33.8181365]) < 1,
    ),
  );
  const connectors = built.parts.filter((part) => part.role === 'connector');
  assert.equal(connectors.length, 2);
  for (const connector of connectors) {
    for (const [partIndex, coordinate] of [
      [connector.startMainlinePartIndex, connector.coordinates[0]],
      [connector.endMainlinePartIndex, connector.coordinates.at(-1)],
    ]) {
      assert.ok(
        built.parts[partIndex].coordinates.some(
          (point) => point.join() === coordinate.join(),
        ),
      );
    }
  }
  const graph = buildPairedOsmSourceTopologyGraph(osm, built.parts);
  assert.equal(graph.statistics.sourceConnectorPartCount, 2);
  assert.equal(graph.statistics.explicitTopologyKeyCount, 4);
});

test('ramp midpoints use closest tangent projections despite unequal path lengths', () => {
  const averaged = averageReciprocalPathCoordinates(
    [
      [0, 0],
      [1000, 0],
    ].map(metersCoordinate),
    [
      [-200, 100],
      [2000, 100],
    ].map(metersCoordinate),
    metersCoordinate([0, 50]),
    metersCoordinate([1000, 50]),
  ).map(coordinateMeters);
  for (const [index, [x, y]] of averaged.entries()) {
    assert.ok(Math.abs(x - (1000 * index) / (averaged.length - 1)) < 0.02);
    assert.ok(Math.abs(y - 50) < 0.02);
  }
});

test('ramp tangent pairing rejects a nearer segment running back the other way', () => {
  const averaged = averageReciprocalPathCoordinates(
    [
      [0, 0],
      [1000, 0],
    ].map(metersCoordinate),
    [
      [0, 100],
      [1200, 100],
      [1200, 10],
      [-200, 10],
    ].map(metersCoordinate),
    metersCoordinate([0, 50]),
    metersCoordinate([1000, 50]),
  ).map(coordinateMeters);
  assert.ok(averaged.length > 20);
  assert.ok(averaged.every(([, y]) => Math.abs(y - 50) < 0.02));
});

test('curved ramps retain closest normal midpoints without endpoint warping', () => {
  const arc = (radius, from, to) =>
    Array.from({ length: 301 }, (_, i) => {
      const angle = ((from + ((to - from) * i) / 300) * Math.PI) / 180;
      return metersCoordinate([Math.cos(angle) * radius, Math.sin(angle) * radius]);
    });
  const averaged = averageReciprocalPathCoordinates(
    arc(300, 0, 90),
    arc(360, -30, 120),
    metersCoordinate([330, 0]),
    metersCoordinate([0, 330]),
  ).map(coordinateMeters);
  assert.ok(averaged.length > 15);
  for (const [x, y] of averaged) {
    assert.ok(x >= -0.1 && y >= -0.1);
    assert.ok(Math.abs(Math.hypot(x, y) - 330) < 0.1);
  }
});

test('staggered ramp joins continue along the source mainline on both ends', () => {
  const points = {
    aBefore: [-300, 0],
    aSplit: [0, 0],
    aAfter: [1400, 0],
    aWestStart: [1400, 20],
    aMerge: [400, 20],
    aMiddle: [200, 20],
    aWestEnd: [-300, 20],
    bBefore: [-300, 1000],
    bMerge: [900, 1000],
    bAfter: [1400, 1000],
    bWestStart: [1400, 1020],
    bSplit: [1200, 1020],
    bWestEnd: [-300, 1020],
    f1: [300, 60],
    f2: [600, 500],
    f3: [800, 980],
    r1: [600, 80],
    r2: [750, 500],
    r3: [950, 960],
  };
  const nodes = new Map(
    Object.entries(points).map(([id, point]) => [
      id,
      {
        coordinate: metersCoordinate(point),
        tags: {},
      },
    ]),
  );
  // Split the westbound carriageway into OSM ways to exercise node continuity.
  const mainlines = [
    { id: 'ae', nodeIds: ['aBefore', 'aSplit', 'aAfter'] },
    { id: 'aw1', nodeIds: ['aWestStart', 'aMerge'] },
    { id: 'aw2', nodeIds: ['aMerge', 'aMiddle'] },
    { id: 'aw3', nodeIds: ['aMiddle', 'aWestEnd'] },
    { id: 'be', nodeIds: ['bBefore', 'bMerge', 'bAfter'] },
    { id: 'bw', nodeIds: ['bWestStart', 'bSplit', 'bWestEnd'] },
  ];
  const parts = [
    {
      id: 'a',
      role: 'mainline',
      tokens: ['A'],
      sourceWayIds: ['ae', 'aw1', 'aw2', 'aw3'],
      coordinates: [
        [-300, 10],
        [1400, 10],
      ].map(metersCoordinate),
    },
    {
      id: 'b',
      role: 'mainline',
      tokens: ['B'],
      sourceWayIds: ['be', 'bw'],
      coordinates: [
        [-300, 1010],
        [1400, 1010],
      ].map(metersCoordinate),
    },
  ];
  const ramps = [
    { id: 'f', nodeIds: ['aSplit', 'f1', 'f2', 'f3', 'bMerge'] },
    { id: 'r', nodeIds: ['bSplit', 'r3', 'r2', 'r1', 'aMerge'] },
  ];
  const result = buildRampConnectors({ nodes }, mainlines, parts, ramps);
  assert.equal(result.connectors.length, 1);
  const connector = result.connectors[0];
  const coordinates = connector.coordinates.map(coordinateMeters);
  assert.ok(Math.abs(coordinates[0][0]) < 0.02);
  assert.ok(Math.abs(coordinates.at(-1)[0] - 1200) < 0.02);
  const early = coordinates.filter(([x]) => x > 100 && x < 250);
  assert.ok(early.length > 3);
  for (const [x, y] of early) assert.ok(Math.abs(y - (x * 0.2 + 20) / 2) < 0.1);
  const late = coordinates.filter(([x]) => x > 1000 && x < 1150);
  assert.ok(late.length > 3);
  for (const [x, y] of late) {
    const projectedX = (2 * x + 0.24 * (1000 - 732)) / (2 + 0.24 ** 2);
    const rampY = 732 + projectedX * 0.24;
    assert.ok(Math.abs(y - (rampY + 1000) / 2) < 0.1);
  }
  assert.ok(
    parts[0].coordinates.some((p) => p.join() === connector.coordinates[0].join()),
  );
  assert.ok(
    parts[1].coordinates.some((p) => p.join() === connector.coordinates.at(-1).join()),
  );
});

test('Florence interchange keeps four continuous reciprocal connectors at source junctions', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('./fixtures/florence-interchange.json', import.meta.url),
      'utf8',
    ),
  );
  const osm = { nodes: new Map(fixture.nodes), ways: fixture.ways };
  const built = buildOsmHighwayCenterlines(osm);
  const connectors = built.parts.filter((part) => part.role === 'connector');
  assert.equal(connectors.length, 4);
  for (const connector of connectors) {
    assert.equal(hasProperSelfIntersection(connector.coordinates), false);
    assert.ok(connector.coordinates.length > 30);
    // Endpoints must meet the mainline without the old diagonal terminal hooks.
    assert.ok(
      geodesicDistanceMeters(connector.coordinates[0], connector.coordinates[1]) < 40,
    );
    assert.ok(
      geodesicDistanceMeters(
        connector.coordinates.at(-2),
        connector.coordinates.at(-1),
      ) < 40,
    );
    for (const [partIndex, coordinate] of [
      [connector.startMainlinePartIndex, connector.coordinates[0]],
      [connector.endMainlinePartIndex, connector.coordinates.at(-1)],
    ]) {
      assert.ok(
        built.parts[partIndex].coordinates.some(
          (point) => point.join() === coordinate.join(),
        ),
      );
    }
  }
  const graph = buildPairedOsmSourceTopologyGraph(osm, built.parts);
  assert.equal(graph.statistics.sourceConnectorPartCount, 4);
  assert.equal(graph.statistics.explicitTopologyKeyCount, 8);
});

test('collector alternatives minimize mean ramp distance while retaining distinct source routes', () => {
  const attachment = (nodeId, partIndex, coordinate, direction) => ({
    nodeId,
    partIndex,
    coordinate,
    travelDirections: [direction],
  });
  const forwardStart = attachment('a', 0, [0, 0], [1, 0]);
  const forwardEnd = attachment('b', 1, [0.01, 0.01], [1, 0]);
  const reverseStart = attachment('c', 1, [0.01, 0.011], [-1, 0]);
  const reverseEnd = attachment('d', 0, [0, 0.001], [-1, 0]);
  const pair = (forwardDistance, reverseDistance, forwardEdges, reverseEdges) => [
    {
      firstAttachment: forwardStart,
      secondAttachment: forwardEnd,
      distanceMeters: forwardDistance,
      edgeIndices: forwardEdges,
    },
    {
      firstAttachment: reverseStart,
      secondAttachment: reverseEnd,
      distanceMeters: reverseDistance,
      edgeIndices: reverseEdges,
    },
  ];
  // The first option is shorter in one direction, but longer on average.
  const uneven = pair(800, 2400, [1, 2], [3, 4]);
  const shorterMean = pair(1200, 1500, [1, 5], [3, 6]);
  // Identical-looking endpoints alone must not collapse independent ramps.
  const independent = pair(700, 700, [7, 8], [9, 10]);
  const groups = new Map([
    [0, 0],
    [1, 1],
  ]);
  assert.deepEqual(
    selectShortestReciprocalMovements([uneven, shorterMean, independent], groups),
    [shorterMean, independent],
  );
  assert.deepEqual(
    selectShortestReciprocalMovements([independent, shorterMean, uneven], groups),
    [independent, shorterMean],
  );
});

test('Atlanta collector alternatives produce one reciprocal centerline per interchange side', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('./fixtures/atlanta-interchange.json', import.meta.url),
      'utf8',
    ),
  );
  for (const ways of [fixture.ways, [...fixture.ways].reverse()]) {
    const osm = { nodes: new Map(fixture.nodes), ways };
    const built = buildOsmHighwayCenterlines(osm);
    const connectors = built.parts.filter((part) => part.role === 'connector');
    assert.equal(built.statistics.directedConnectorPathCount, 10);
    assert.equal(built.statistics.alternativeConnectorPathCount, 2);
    assert.equal(built.statistics.unpairedConnectorPathCount, 0);
    assert.equal(connectors.length, 4);
    const leg = ([longitude, latitude]) =>
      `${latitude > 33.893 ? 'N' : 'S'}${longitude < -84.26 ? 'W' : 'E'}`;
    assert.deepEqual(
      new Set(
        connectors.map((connector) =>
          [leg(connector.coordinates[0]), leg(connector.coordinates.at(-1))]
            .sort()
            .join(':'),
        ),
      ),
      new Set(['NE:NW', 'NE:SE', 'SE:SW', 'NW:SW']),
    );
    const north = connectors.find((connector) =>
      [connector.coordinates[0], connector.coordinates.at(-1)].every(
        ([, latitude]) => latitude > 33.893,
      ),
    );
    // Keep the direct pair rather than the longer Buford Highway collector
    // alternative. Shared collector stems for OTHER turns must remain usable.
    assert.ok(north.sourceWayIds.includes('9165657'));
    assert.ok(north.sourceWayIds.includes('9164185'));
    assert.ok(!north.sourceWayIds.includes('9164970'));
    assert.equal(hasProperSelfIntersection(north.coordinates), false);
    for (const connector of connectors) {
      for (const [partIndex, coordinate] of [
        [connector.startMainlinePartIndex, connector.coordinates[0]],
        [connector.endMainlinePartIndex, connector.coordinates.at(-1)],
      ]) {
        assert.ok(
          built.parts[partIndex].coordinates.some(
            (point) => point.join() === coordinate.join(),
          ),
        );
      }
    }
    const graph = buildPairedOsmSourceTopologyGraph(osm, built.parts);
    assert.equal(graph.statistics.sourceConnectorPartCount, 4);
    assert.equal(graph.statistics.explicitTopologyKeyCount, 8);
  }
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
