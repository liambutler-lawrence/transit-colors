import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { geodesicDistanceMeters } from './wgs84-geodesy.mjs';
import { hasProperSelfIntersection } from './highway-cycle.mjs';
import {
  buildOsmHighwayCenterlines,
  buildPairedOsmSourceTopologyGraph,
  averageReciprocalPathCoordinates,
  classifyOsmMotorwayWay,
  shortenReciprocalMatches,
  selectShortestReciprocalMovements,
} from './osm-highway-network.mjs';

test('short collector alternatives keep source correspondence moving forward around loops', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('./fixtures/short-collector-midpoints.json', import.meta.url),
      'utf8',
    ),
  );
  for (const { id, first, second, start, end } of fixture.curves) {
    const coordinates = averageReciprocalPathCoordinates(first, second, start, end);
    assert.deepEqual(coordinates[0], start);
    assert.deepEqual(coordinates.at(-1), end);
    assert.equal(hasProperSelfIntersection(coordinates), false, id);
    assert.deepEqual(
      averageReciprocalPathCoordinates(second, first, start, end),
      coordinates,
    );
    for (let i = 1; i < coordinates.length - 1; i += 1) {
      const [a, b, c] = coordinates.slice(i - 1, i + 2);
      if (geodesicDistanceMeters(a, b) < 1 || geodesicDistanceMeters(b, c) < 1)
        continue;
      const scale = Math.cos((b[1] * Math.PI) / 180);
      assert.ok(
        (b[0] - a[0]) * (c[0] - b[0]) * scale ** 2 + (b[1] - a[1]) * (c[1] - b[1]) >= 0,
        `${id} does not reverse at sample ${i}`,
      );
    }
  }
});

test('shortening a collector can share its own return but cannot consume another matched movement', () => {
  const start = {
    nodeId: 'departure',
    partIndex: 0,
    coordinate: [0, 0],
    travelDirections: [[1, 0]],
  };
  const end = {
    nodeId: 'arrival',
    partIndex: 1,
    coordinate: [0.01, 0.01],
    travelDirections: [[1, 0]],
  };
  const path = (distanceMeters, edgeIndices) => ({
    distanceMeters,
    edgeIndices,
    firstAttachment: start,
    secondAttachment: end,
  });
  const long = path(3000, [1, 2]);
  const short = path(1000, [1, 3]);
  const available = path(1500, [1, 4]);
  const returning = path(1000, [5]);
  const differentReturn = path(1200, [6]);
  const first = [long, returning];
  const other = [short, differentReturn];
  const unavailableAlternative = [short, returning];
  const availableAlternative = [available, returning];
  const groups = new Map([
    [0, 0],
    [1, 1],
  ]);
  assert.deepEqual(
    shortenReciprocalMatches([first, other], [unavailableAlternative], groups),
    [first, other],
  );
  assert.deepEqual(
    shortenReciprocalMatches(
      [first, other],
      [unavailableAlternative, availableAlternative],
      groups,
    ),
    [availableAlternative, other],
  );
  const longest = path(5000, [1, 7]);
  assert.deepEqual(
    shortenReciprocalMatches(
      [[longest, differentReturn], first],
      [
        [long, differentReturn],
        [short, returning],
      ],
      groups,
    ),
    // Shortening the second movement releases its former path for the first.
    [
      [long, differentReturn],
      [short, returning],
    ],
  );
});

test('open ramp links survive residual construction tags while closures remain excluded', () => {
  for (const construction of ['no', 'minor', 'widening', 'motorway_link']) {
    const tags = { highway: 'motorway_link', construction, lanes: '2', oneway: 'yes' };
    assert.equal(classifyOsmMotorwayWay({ tags }), 'connector');
    for (const closure of [
      { highway: 'construction' },
      { construction: 'yes' },
      { access: 'no' },
      { motor_vehicle: 'no' },
    ]) {
      assert.equal(classifyOsmMotorwayWay({ tags: { ...tags, ...closure } }), null);
    }
  }
});

test('Jacksonville restores NW reciprocity and chooses the shorter NE collector despite its shared return', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('./fixtures/jacksonville-collector-interchange.json', import.meta.url),
      'utf8',
    ),
  );
  for (const ways of [fixture.ways, [...fixture.ways].reverse()]) {
    const osm = { nodes: new Map(fixture.nodes), ways };
    const built = buildOsmHighwayCenterlines(osm);
    const connectors = built.parts.filter((part) => part.role === 'connector');
    assert.equal(built.statistics.directedConnectorPathCount, 9);
    assert.equal(built.statistics.alternativeConnectorPathCount, 1);
    assert.equal(built.statistics.unpairedConnectorPathCount, 0);
    assert.equal(connectors.length, 4);
    const leg = ([longitude, latitude]) => {
      if (longitude < -81.654) return 'W';
      if (longitude > -81.635) return 'E';
      return latitude > 30.46 ? 'N' : 'S';
    };
    const movements = new Map(
      connectors.map((connector) => [
        [leg(connector.coordinates[0]), leg(connector.coordinates.at(-1))]
          .sort()
          .join(':'),
        connector,
      ]),
    );
    assert.deepEqual(new Set(movements.keys()), new Set(['N:W', 'E:N', 'E:S', 'S:W']));
    const northwest = movements.get('N:W');
    assert.ok(northwest.sourceWayIds.includes('943967900'));
    assert.ok(northwest.sourceWayIds.includes('943967905'));
    const northeast = movements.get('E:N');
    const southeast = movements.get('E:S');
    // Two N→E alternatives share the SAME E→N path. Endpoint proximity used
    // to consume that return for the longer candidate before comparing length.
    for (const wayId of ['1314789904', '1314789905']) {
      assert.ok(northeast.sourceWayIds.includes(wayId));
    }
    for (const wayId of ['1499507711', '1314789902', '10868544']) {
      assert.ok(!northeast.sourceWayIds.includes(wayId));
    }
    assert.ok(southeast.sourceWayIds.includes('1314789902'));
    const eastEnd = (part) =>
      [part.coordinates[0], part.coordinates.at(-1)].find(
        (point) => leg(point) === 'E',
      );
    assert.ok(eastEnd(northeast)[0] < eastEnd(southeast)[0]);
    assert.ok(geodesicDistanceMeters(eastEnd(northeast), eastEnd(southeast)) > 400);
    for (const connector of connectors) {
      assert.equal(hasProperSelfIntersection(connector.coordinates), false);
      for (const [partIndex, coordinate] of [
        [connector.startMainlinePartIndex, connector.coordinates[0]],
        [connector.endMainlinePartIndex, connector.coordinates.at(-1)],
      ]) {
        assert.ok(
          built.parts[partIndex].coordinates.some(
            (point) => geodesicDistanceMeters(point, coordinate) < 0.25,
          ),
        );
      }
    }
    const graph = buildPairedOsmSourceTopologyGraph(osm, built.parts);
    assert.equal(graph.statistics.sourceConnectorPartCount, 4);
    assert.equal(graph.statistics.explicitTopologyKeyCount, 8);
  }
  // An actual closure on either direction must still remove the NW pair.
  const closed = structuredClone(fixture);
  closed.ways.find((way) => way.id === '943967900').tags.highway = 'construction';
  const built = buildOsmHighwayCenterlines({
    nodes: new Map(closed.nodes),
    ways: closed.ways,
  });
  assert.equal(built.statistics.directConnectorCount, 3);
  assert.equal(built.statistics.unpairedConnectorPathCount, 1);
});

test('a reciprocal pair cannot share one-way source edges internally, even when a shorter route does', () => {
  const start = {
    nodeId: 'start',
    partIndex: 0,
    coordinate: [0, 0],
    travelDirections: [[1, 0]],
  };
  const end = {
    nodeId: 'end',
    partIndex: 1,
    coordinate: [0.01, 0.01],
    travelDirections: [[1, 0]],
  };
  const path = (nodeIds, edgeIndices, distanceMeters) => ({
    nodeIds,
    edgeIndices,
    distanceMeters,
    firstAttachment: start,
    secondAttachment: end,
  });
  const outward = path(['a', 'collector-a', 'collector-b', 'b'], [1, 2, 3], 1000);
  const falseReturn = path(['c', 'collector-a', 'collector-b', 'd'], [4, 2, 5], 1000);
  const actualReturn = path(['c', 'return-a', 'return-b', 'd'], [4, 6, 5], 1200);
  const invalid = [outward, falseReturn],
    valid = [outward, actualReturn];
  assert.deepEqual(
    selectShortestReciprocalMovements(
      [invalid, valid],
      new Map([
        [0, 0],
        [1, 1],
      ]),
    ),
    [valid],
  );
  // Shared junction nodes alone do not mean shared one-way pavement.
  const crossing = [
    outward,
    path(['c', 'collector-a', 'return-b', 'd'], [4, 7, 5], 1100),
  ];
  assert.deepEqual(selectShortestReciprocalMovements([crossing], new Map()), [
    crossing,
  ]);
});

test('a separate shorter collector can replace one side of an identical reciprocal movement', () => {
  const attachment = (nodeId, partIndex, coordinate, chain) => ({
    nodeId,
    partIndex,
    coordinate,
    carriagewayIds: [chain],
    travelDirections: [[1, 0]],
  });
  const long = {
    firstAttachment: attachment('old-exit', 0, [0, 0], 'eastbound'),
    secondAttachment: attachment('old-merge', 1, [0.01, 0.01], 'northbound'),
    distanceMeters: 4000,
    edgeIndices: [1, 2],
  };
  const short = {
    firstAttachment: attachment('later-exit', 0, [0.001, 0], 'eastbound'),
    secondAttachment: attachment('earlier-merge', 1, [0.011, 0.01], 'northbound'),
    distanceMeters: 2000,
    edgeIndices: [3, 4],
  };
  const returning = { ...long, edgeIndices: [5, 6], distanceMeters: 1500 };
  const groups = new Map([
    [0, 0],
    [1, 1],
  ]);
  assert.deepEqual(
    shortenReciprocalMatches([[long, returning]], [[short, returning]], groups),
    [[short, returning]],
  );
  const wrongSide = structuredClone(short);
  wrongSide.secondAttachment.carriagewayIds = ['southbound'];
  assert.deepEqual(
    shortenReciprocalMatches([[long, returning]], [[wrongSide, returning]], groups),
    [[long, returning]],
  );
  assert.deepEqual(
    shortenReciprocalMatches([[long, returning]], [[short, { ...returning }]], groups),
    [[long, returning]],
    'nearby independent movements need their own evidence',
  );
});
