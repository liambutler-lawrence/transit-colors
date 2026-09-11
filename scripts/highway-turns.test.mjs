import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { highwayTurnAllowed, highwayCycleTurnViolation } from './highway-turns.mjs';
import { compressHighwayCore, highwayTwoCore } from './highway-graph.mjs';
import {
  highwayAdjacency,
  shortestHighwayPath,
  refineHighwayCycleThroughWaypoints,
  solveHighwayEnvelopeCycleThroughWaypoints,
} from './highway-envelope-cycle.mjs';
import {
  buildOsmHighwayCenterlines,
  buildPairedOsmSourceTopologyGraph,
  rampAttachmentTravelDirection,
} from './osm-highway-network.mjs';

const port = (direction) => ({ mainlineId: 'highway', direction });
const road = (fromId, toId, coordinates, fromTurnPort, toTurnPort) => ({
  fromId,
  toId,
  coordinates,
  fromTurnPort,
  toTurnPort,
  partIndices: new Set(),
});

function route(nodes, edges, start, end, forbidden = new Set()) {
  return shortestHighwayPath(
    start,
    (id) => id === end,
    highwayAdjacency(nodes, edges),
    edges,
    forbidden,
    new Set(),
  );
}

test('a reciprocal ramp permits only its source carriageway side, in either traversal direction', () => {
  const north = road(
    'N',
    'J',
    [
      [0, 1],
      [0, 0],
    ],
    undefined,
    port(-1),
  );
  const south = road(
    'J',
    'S',
    [
      [0, 0],
      [0, -1],
    ],
    port(1),
  );
  // Deliberately points north first: the shape of a loop/averaged ramp does
  // not determine which source carriageway may enter it.
  const loop = road(
    'J',
    'E',
    [
      [0, 0],
      [0, 0.1],
      [1, 0],
    ],
    port(1),
  );
  assert.equal(highwayTurnAllowed(north, loop, 'J'), true);
  assert.equal(highwayTurnAllowed(loop, north, 'J'), true);
  assert.equal(highwayTurnAllowed(south, loop, 'J'), false);
  assert.equal(highwayTurnAllowed(loop, south, 'J'), false);
  assert.equal(highwayTurnAllowed(north, south, 'J'), true);
  assert.equal(highwayTurnAllowed(north, north, 'J'), false);
  assert.equal(
    highwayTurnAllowed(
      north,
      { ...loop, fromTurnPort: { mainlineId: 'unrelated', direction: 1 } },
      'J',
    ),
    false,
  );
  assert.equal(
    highwayTurnAllowed(north, { ...loop, fromTurnPort: undefined }, 'J'),
    false,
    'missing direction at a restricted junction fails closed',
  );
  assert.equal(
    highwayTurnAllowed(loop, { ...loop, fromTurnPort: port(0) }, 'J'),
    false,
  );
});

test('path search retains a longer legal arrival at the same junction', () => {
  const coordinates = { S: [0, 0], J: [0.01, 0], K: [0.005, 0.01], T: [0.02, 0] };
  const nodes = Object.entries(coordinates).map(([id, coordinate]) => ({
    id,
    coordinate,
  }));
  const edges = [
    ['S', 'J'],
    ['S', 'K'],
    ['K', 'J'],
    ['J', 'T'],
  ].map(([a, b]) => road(a, b, [coordinates[a], coordinates[b]]));
  edges[0].toTurnPort = port(1);
  edges[2].toTurnPort = port(-1);
  edges[3].fromTurnPort = port(1);
  assert.deepEqual(
    route(nodes, edges, 'S', 'T').steps.map((s) => s.edgeIndex),
    [1, 2, 3],
  );
  assert.equal(route(nodes, edges, 'S', 'T', new Set([1])), null);
});

test('cycle selection checks the closing turn as well as the turns within each path', () => {
  const nodes = [
    { id: 'A', coordinate: [0, 0] },
    { id: 'B', coordinate: [0.01, 0] },
    { id: 'C', coordinate: [0, 0.01] },
  ];
  const edges = [
    road(
      'A',
      'B',
      [
        [0, 0],
        [0.01, 0],
      ],
      port(1),
    ),
    road('B', 'C', [
      [0.01, 0],
      [0, 0.01],
    ]),
    road(
      'C',
      'A',
      [
        [0, 0.01],
        [0, 0],
      ],
      undefined,
      port(1),
    ),
  ];
  const steps = edges.map((e, edgeIndex) => ({ ...e, edgeIndex }));
  assert.deepEqual(highwayCycleTurnViolation(steps, edges), [2, 0]);
  assert.throws(
    () => solveHighwayEnvelopeCycleThroughWaypoints(nodes, edges, ['A', 'B', 'C']),
    /No simple detailed highway cycle/,
  );
  edges[2].toTurnPort = port(-1);
  const result = solveHighwayEnvelopeCycleThroughWaypoints(nodes, edges, [
    'A',
    'B',
    'C',
  ]);
  assert.equal(highwayCycleTurnViolation(result.segments, edges), null);
});

test('compression retains junction ports and rejects a reversal hidden inside a degree-two corridor', () => {
  const coordinates = new Map([
    ['A', [0, 0]],
    ['B', [0.01, 0]],
    ['C', [0.01, 0.01]],
  ]);
  const edges = [
    road('A', 'B', [], port(-1), port(1)),
    road('B', 'C', [], port(1)),
    road('C', 'A', [], undefined, port(1)),
  ];
  const compressed = compressHighwayCore(
    coordinates,
    edges,
    highwayTwoCore(new Set(coordinates.keys()), edges),
  );
  assert.equal(compressed.edges.length, 1);
  assert.deepEqual(compressed.edges[0].fromTurnPort, port(-1));
  assert.deepEqual(compressed.edges[0].toTurnPort, port(1));
  assert.equal(compressed.edges[0].invalidTurn, true);
  assert.equal(highwayAdjacency(compressed.nodes, compressed.edges).get('A').length, 0);
});

test('attachment direction uses the local parent ordering and survives reversed geometry', () => {
  const coordinates = [
    [0, 0],
    [0.01, 0],
    [0.01, 0.01],
  ];
  const attachment = { coordinate: [0.01, 0], travelDirections: [[0, 1]] };
  assert.equal(rampAttachmentTravelDirection({ coordinates }, attachment), 1);
  assert.equal(
    rampAttachmentTravelDirection(
      { coordinates: [...coordinates].reverse() },
      attachment,
    ),
    -1,
  );
});

test('Miami I-95 / I-395 uses the NW pair and cannot substitute a NE U-turn when NW is absent', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('./fixtures/miami-i95-i395-turns.json', import.meta.url),
      'utf8',
    ),
  );
  const osm = { nodes: new Map(fixture.nodes), ways: fixture.ways };
  const built = buildOsmHighwayCenterlines(osm);
  const nw = built.parts.find(
    (p) =>
      p.role === 'connector' &&
      p.startMainlineDirection === 1 &&
      p.endMainlineDirection === 1,
  );
  const ne = built.parts.find(
    (p) =>
      p.role === 'connector' &&
      p.startMainlineDirection === 1 &&
      p.endMainlineDirection === -1,
  );
  assert.ok(nw && ne, 'both northern reciprocal ramp pairs exist');
  assert.ok(nw.coordinates.at(-1)[0] < -80.21);
  assert.ok(ne.coordinates.at(-1)[0] > -80.201);
  const graph = buildPairedOsmSourceTopologyGraph(osm, built.parts);
  const nodes = [...graph.coordinateByNodeId].map(([id, coordinate]) => ({
    id,
    coordinate,
  }));
  const edges = graph.edges.map((e) => ({
    ...e,
    coordinates: [
      graph.coordinateByNodeId.get(e.fromId),
      graph.coordinateByNodeId.get(e.toId),
    ],
  }));
  const nearest = ([x, y]) =>
    nodes.toSorted(
      (a, b) =>
        Math.hypot(a.coordinate[0] - x, a.coordinate[1] - y) -
        Math.hypot(b.coordinate[0] - x, b.coordinate[1] - y),
    )[0].id;
  const north = nearest([-80.2057, 25.799]);
  const west = nearest([-80.22, 25.785]);
  const nwPart = graph.parts.findIndex((p) => p.id === nw.id);
  const nwEdges = new Set(
    edges.flatMap((e, i) => (e.partIndices.has(nwPart) ? [i] : [])),
  );
  for (const [start, end] of [
    [north, west],
    [west, north],
  ]) {
    const result = route(nodes, edges, start, end);
    assert.ok(result);
    const ramps = new Set(
      result.steps.flatMap((s) =>
        [...s.partIndices].filter((i) => graph.parts[i].role === 'connector'),
      ),
    );
    assert.deepEqual(ramps, new Set([nwPart]));
    assert.equal(
      route(nodes, edges, start, end, nwEdges),
      null,
      'missing NW must produce no route, never a reversal through NE',
    );
    const unrestricted = edges.map((edge) => ({
      ...edge,
      fromTurnPort: undefined,
      toTurnPort: undefined,
    }));
    assert.ok(
      route(nodes, unrestricted, start, end, nwEdges),
      'the old unrestricted graph incorrectly found a route',
    );
  }
});

test('perimeter expansion reroutes an illegal attachment to the retained seed arc', () => {
  const coordinates = {
    A: [0, 0],
    B: [4, 0],
    C: [4, 4],
    D: [0, 4],
    E: [6, 6],
    F: [6, -2],
  };
  const nodes = Object.entries(coordinates).map(([id, coordinate]) => ({
    id,
    coordinate,
  }));
  const edges = [
    ['A', 'B'],
    ['B', 'C'],
    ['C', 'D'],
    ['D', 'A'],
    ['C', 'E'],
    ['E', 'F'],
    ['F', 'B'],
    ['F', 'A'],
  ].map(([a, b]) => road(a, b, [coordinates[a], coordinates[b]]));
  edges[0].toTurnPort = port(-1);
  edges[1].fromTurnPort = port(1);
  edges[6].toTurnPort = port(-1);
  const seed = edges.slice(0, 4).map((e, edgeIndex) => ({ ...e, edgeIndex }));
  const attempts = [];
  const result = refineHighwayCycleThroughWaypoints(nodes, edges, seed, ['E', 'F'], {
    onAttempt: (attempt) => attempts.push(attempt),
  });
  assert.ok(
    attempts.some((attempt) => attempt.turnViolations?.some(Boolean)),
    'the first geometrically valid ear fails its source turn',
  );
  assert.ok(result.segments.some((s) => s.edgeIndex === 7));
  assert.equal(
    result.segments.some((s) => s.edgeIndex === 6),
    false,
  );
  assert.equal(highwayCycleTurnViolation(result.segments, edges), null);
});

test('a blocked next waypoint retries the whole perimeter with a longer legal approach', () => {
  const coordinates = { S: [0, 0], J: [0.01, 0], K: [0.005, 0.01], T: [0.02, -0.01] };
  const nodes = Object.entries(coordinates).map(([id, coordinate]) => ({
    id,
    coordinate,
  }));
  const edges = [
    ['S', 'J'],
    ['S', 'K'],
    ['K', 'J'],
    ['J', 'T'],
    ['T', 'S'],
  ].map(([a, b]) => road(a, b, [coordinates[a], coordinates[b]]));
  edges[0].toTurnPort = port(1);
  edges[2].toTurnPort = port(-1);
  edges[3].fromTurnPort = port(1);
  const result = solveHighwayEnvelopeCycleThroughWaypoints(
    nodes,
    edges,
    ['S', 'J', 'T'],
    { tryReverse: false },
  );
  assert.deepEqual(
    result.segments.map((s) => s.edgeIndex),
    [1, 2, 3, 4],
  );
  assert.equal(highwayCycleTurnViolation(result.segments, edges), null);
});

test('a collapsed parent records an unusable direction instead of an unrestricted turn', () => {
  const coordinates = [
    [0, 0],
    [0, 0],
    [0, 0],
  ];
  const direction = rampAttachmentTravelDirection(
    { coordinates },
    { coordinate: [0, 0], travelDirections: [[1, 0]] },
  );
  assert.equal(direction, 0);
  const edge = road(
    'A',
    'B',
    [
      [0, 0],
      [0.01, 0],
    ],
    port(direction),
  );
  const nodes = [
    { id: 'A', coordinate: [0, 0] },
    { id: 'B', coordinate: [0.01, 0] },
  ];
  assert.equal(route(nodes, [edge], 'A', 'B'), null);
});

test('the published Miami circumference uses NW and never reverses through NE', () => {
  const data = JSON.parse(
    readFileSync(
      new URL('../data/north-america-highway-circumference.json', import.meta.url),
      'utf8',
    ),
  );
  const ramps = data.route.segments.filter(
    (s) =>
      s.role === 'connector' &&
      s.coordinates.some(
        ([x, y]) => x > -80.215 && x < -80.195 && y > 25.782 && y < 25.797,
      ),
  );
  assert.equal(ramps.length, 1);
  const west = ramps[0].coordinates.some(
    ([x, y]) => x < -80.209 && y > 25.786 && y < 25.789,
  );
  const north = ramps[0].coordinates.some(([x, y]) => x < -80.204 && y > 25.793);
  assert.ok(
    west && north,
    'the boundary connects the northern I-95 leg to western SR 836',
  );
  assert.ok(
    ramps[0].coordinates.every(([x]) => x < -80.204),
    'no NE ramp or east-side reversal',
  );
});
