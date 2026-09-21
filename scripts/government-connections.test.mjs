import test from 'node:test';
import assert from 'node:assert/strict';
import {
  firstCircleEntry,
  distance,
  lineTraversesSubdivision,
} from './government-connections-geometry.mjs';
import { shortestCircleRoute } from './government-connections-routing.mjs';

test('clips first entry on WGS84 even when both segment endpoints are outside', () => {
  const center = [0, 0],
    route = [
      [-0.1, 0],
      [0.1, 0],
    ];
  const entry = firstCircleEntry(route, center);
  assert.ok(entry);
  assert.ok(Math.abs(distance(entry.coordinates.at(-1), center) - 5000) < 0.001);
  assert.ok(entry.coordinates.at(-1)[0] < 0);
  assert.equal(
    firstCircleEntry(
      [
        [-0.1, 0.1],
        [0.1, 0.1],
      ],
      center,
    ),
    null,
  );
});
test('traversal detects a crossed subdivision but excludes holes', () => {
  const geometry = {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [4, 0],
        [4, 4],
        [0, 4],
        [0, 0],
      ],
      [
        [1, 1],
        [3, 1],
        [3, 3],
        [1, 3],
        [1, 1],
      ],
    ],
  };
  assert.equal(
    lineTraversesSubdivision(
      [
        [-1, 2],
        [5, 2],
      ],
      geometry,
    ),
    true,
  );
  assert.equal(
    lineTraversesSubdivision(
      [
        [1.5, 2],
        [2.5, 2],
      ],
      geometry,
    ),
    false,
  );
});
test('shortest route carries incoming edge state and rejects impossible ramp reversals', () => {
  const port = (direction) => ({ mainlineId: 'main', direction });
  const edges = [
    {
      fromId: 'b',
      toId: 'j',
      coordinates: [
        [-0.3, 0],
        [-0.2, 0],
      ],
      toTurnPort: port(1),
    },
    {
      fromId: 'j',
      toId: 'target',
      coordinates: [
        [-0.2, 0],
        [0, 0],
      ],
      fromTurnPort: port(1),
    },
    {
      fromId: 'j',
      toId: 'k',
      coordinates: [
        [-0.2, 0],
        [-0.1, 0.08],
      ],
      fromTurnPort: port(-1),
    },
    {
      fromId: 'k',
      toId: 'target',
      coordinates: [
        [-0.1, 0.08],
        [0, 0],
      ],
    },
  ];
  const result = shortestCircleRoute({
    edges,
    starts: [{ node: 'j', incoming: 0 }],
    center: [0, 0],
    forbiddenEdges: new Set([0]),
  });
  assert.deepEqual(
    result.steps.map((s) => s.edgeIndex),
    [2, 3],
  );
  assert.ok(
    Math.abs(distance(result.steps.at(-1).coordinates.at(-1), [0, 0]) - 5000) < 0.001,
  );
});

import { interchangeApproaches } from './government-connections-interchanges.mjs';
function junctionFixture() {
  const port = (mainlineId, direction) => ({ mainlineId, direction });
  const rawEdges = [];
  const make = (fromId, toId, role, boundary, fromPort, toPort) => {
    const rawIndices = [rawEdges.length];
    rawEdges.push({
      fromId,
      toId,
      boundaryForward: true,
      boundaryIndex: rawIndices[0],
    });
    return {
      fromId,
      toId,
      role,
      boundary,
      coordinates: [
        [0, 0],
        [0.001, 0],
      ],
      lengthMeters: 100,
      fromTurnPort: fromPort,
      toTurnPort: toPort,
      rawIndices,
    };
  };
  const edges = [
    make('west', 'a', 'mainline', true, undefined, port('ring', -1)),
    make('a', 'b', 'mainline', true, port('ring', 1), port('ring', -1)),
    make('b', 'east', 'mainline', true, port('ring', 1), undefined),
    make('a', 'c', 'connector', false, port('ring', 1), port('spur', -1)),
    make('b', 'd', 'connector', false, port('ring', -1), port('spur', -1)),
    make('c', 'd', 'mainline', false, port('spur', 1), port('spur', -1)),
    make('d', 'capital', 'mainline', false, port('spur', 1), undefined),
  ];
  return { edges, rawEdges };
}
test('requires distinct legal reciprocal ramp approaches for both boundary directions', () => {
  const network = junctionFixture();
  const { starts } = interchangeApproaches(network);
  assert.ok(starts.length > 0);
  assert.equal(
    starts[0].seed.primary.seed.direction,
    -starts[0].seed.secondary.seed.direction,
  );
  network.edges[4].invalidTurn = true;
  assert.equal(interchangeApproaches(network).starts.length, 0);
});
test('matching displayed coordinates cannot create a connection at a grade-separated crossing', () => {
  const network = junctionFixture();
  network.edges[4].toId = 'different-level';
  assert.equal(interchangeApproaches(network).starts.length, 0);
});
test('cannot use a second interchange to acquire the missing direction', () => {
  const network = junctionFixture();
  network.edges[5].role = 'connector';
  assert.equal(interchangeApproaches(network).starts.length, 0);
});

test('minimizes distance to the circle edge rather than distance to the building', () => {
  const edges = [
    {
      fromId: 'a',
      toId: 'center',
      coordinates: [
        [-0.09, 0],
        [0, 0],
      ],
      lengthMeters: 10018,
    },
    {
      fromId: 'b',
      toId: 'far',
      coordinates: [
        [0, -0.1],
        [0, 0.1],
      ],
      lengthMeters: 22200,
    },
  ];
  const result = shortestCircleRoute({
    edges,
    starts: [{ node: 'a' }, { node: 'b' }],
    center: [0, 0],
  });
  assert.equal(result.steps[0].edgeIndex, 0);
  assert.ok(Math.abs(result.distanceMeters - 5018.754) < 1);
});
test('circle entry on an approach stops before the shared branch starts', () => {
  const prefix = [
    {
      edgeIndex: 0,
      fromId: 'a',
      coordinates: [
        [-0.1, 0],
        [0, 0],
      ],
    },
  ];
  const seed = { primary: { steps: prefix }, secondary: { steps: [] }, outgoing: 1 };
  const result = shortestCircleRoute({
    edges: [],
    starts: [{ node: 'b', distance: 20000, seed }],
    center: [0, 0],
  });
  assert.ok(result);
  assert.equal(result.steps.length, 0);
  assert.ok(result.distanceMeters < 10000);
});

test('supports a circumference that turns at the joining interchange', () => {
  const network = junctionFixture();
  network.edges[1].role = 'connector';
  network.edges[3].role = 'mainline';
  assert.ok(interchangeApproaches(network).starts.length > 0);
});

import { matchBoundaryCorridors } from './government-connections-boundary.mjs';
test('recovers source aliases trimmed from display geometry without marking another corridor', () => {
  const coordinateByNodeId = new Map([
    ['a', [0, 0]],
    ['alias', [0, 0]],
    ['b', [1, 0]],
    ['c', [1, 1]],
    ['d', [0, 1]],
  ]);
  const edge = (fromId, toId) => ({ fromId, toId, partIndices: new Set([0]) });
  const edges = [
    edge('a', 'alias'),
    edge('alias', 'b'),
    edge('b', 'c'),
    edge('c', 'd'),
    edge('d', 'a'),
    edge('a', 'c'),
  ];
  const route = {
    segments: [
      {
        coordinates: [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
      },
      {
        coordinates: [
          [1, 1],
          [0, 1],
          [0, 0],
        ],
      },
    ],
  };
  const matched = matchBoundaryCorridors({ coordinateByNodeId, edges }, route);
  assert.equal(matched.selectedCorridorCount, 2);
  assert.deepEqual([...matched.boundary.keys()].sort(), [0, 1, 2, 3, 4]);
});

test('a proven paired mainline continuation is not mistaken for a second interchange', () => {
  const network = junctionFixture();
  network.edges[5].role = 'connector';
  network.edges[5].mainlineContinuation = true;
  assert.ok(interchangeApproaches(network).starts.length > 0);
});

import fs from 'node:fs';
import { applySourceRecoveries } from './government-connections-recoveries.mjs';
import { highwayTurnAllowed } from './highway-turns.mjs';
test('audited recovery splits only its source parent and preserves boundary direction and ports', () => {
  const network = {
    parts: [],
    rawEdges: [
      {
        fromId: 'center:7:0',
        toId: 'center:7:1',
        boundary: true,
        boundaryForward: true,
        partIndices: new Set([0]),
      },
    ],
    edges: [
      {
        fromId: 'center:7:0',
        toId: 'center:7:1',
        role: 'mainline',
        boundary: true,
        coordinates: [
          [0, 0],
          [0.02, 0],
        ],
        rawIndices: [0],
        partIndices: [0],
      },
    ],
  };
  const recovery = {
    id: 'proof',
    sourceFingerprint: 'source',
    start: { partIndex: 7, coordinate: [0.01, 0], direction: -1 },
    end: { partIndex: 7, coordinate: [0.02, 0], direction: 1 },
    coordinates: [
      [0.01, 0],
      [0.015, 0.01],
      [0.02, 0],
    ],
    directionalPaths: [{ rampWayIds: ['a'] }, { rampWayIds: ['b'] }],
  };
  applySourceRecoveries(network, [recovery], 'source');
  assert.equal(network.edges.length, 3);
  const [left, right, ramp] = network.edges;
  assert.equal(left.toId, right.fromId);
  assert.equal(ramp.fromId, left.toId);
  assert.equal(highwayTurnAllowed(left, ramp, left.toId), false);
  assert.equal(highwayTurnAllowed(right, ramp, right.fromId), true);
  assert.equal(highwayTurnAllowed(left, right, left.toId), true);
  assert.equal(network.rawEdges[right.rawIndices[0]].boundaryForward, true);
  assert.throws(
    () =>
      applySourceRecoveries(
        network,
        [{ ...recovery, id: 'crossing', start: { ...recovery.start, partIndex: 8 } }],
        'source',
      ),
    /no longer lies/,
  );
  assert.throws(
    () => applySourceRecoveries(network, [recovery], 'different-source'),
    /Re-audit/,
  );
});

test('published routes end at the circle edge and have opposing approaches at one receiving junction', () => {
  const { seats } = JSON.parse(
    fs.readFileSync('data/north-america-government-seats.json', 'utf8'),
  );
  const { results, boundaryProof, sourceRecoveries } = JSON.parse(
    fs.readFileSync('data/north-america-government-connections.json', 'utf8'),
  );
  const { features } = JSON.parse(
    fs.readFileSync('data/north-america-government-connections.geojson', 'utf8'),
  );
  assert.equal(results.length, seats.length);
  assert.equal(boundaryProof.junctionAnomalies, 0);
  assert.ok(boundaryProof.sourceCorridors > 1000);
  assert.ok(sourceRecoveries.includes('source-verified-401-east-dvp-south'));
  for (const result of results) {
    const lines = features.filter((f) => f.properties.id === result.id);
    if (result.status !== 'connected') {
      assert.equal(lines.length, 0);
      continue;
    }
    const seat = seats.find((s) => s.id === result.id);
    assert.ok(
      Math.abs(distance(result.circleEntry, seat.coordinates) - 5000) < 0.01,
      result.id,
    );
    assert.equal(result.approaches.length, 2);
    assert.equal(
      result.approaches[0].boundaryDirection,
      -result.approaches[1].boundaryDirection,
    );
    assert.ok(
      distance(
        result.approaches[0].receivingCoordinate,
        result.approaches[1].receivingCoordinate,
      ) < 0.01,
    );
    assert.ok(
      distance(
        result.approaches[0].boundaryCoordinate,
        result.approaches[1].boundaryCoordinate,
      ) < 10000,
    );
    assert.ok(lines.some((f) => f.properties.role === 'connector'));
    for (const line of lines)
      for (const p of line.geometry.coordinates)
        assert.ok(
          distance(p, seat.coordinates) >= 4999.99,
          `${result.id} highlights inside the circle`,
        );
  }
  const ontario = results.find((r) => r.id === 'CA-ON');
  assert.equal(ontario.status, 'connected');
  assert.ok(ontario.lengthMeters < 13000);
  assert.ok(
    ontario.approaches.some((a) =>
      a.sourceParts.includes('source-verified-401-east-dvp-south'),
    ),
  );
  assert.equal(results.find((r) => r.id === 'US-DE').status, 'connected');
});
