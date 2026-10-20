import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildInterchangeGraph,
  attachInterchangeBoundaryGraph,
} from './highway-interchange-graph.mjs';
import { planarizeHighways } from './highway-boundary-search.mjs';
import { searchPairedHighwayBoundary } from './highway-paired-boundary-search.mjs';
import { signedAreaContributionSquareMeters as area } from './wgs84-geodesy.mjs';
import { solveInterchangeBoundary } from './highway-interchange-solver.mjs';
import { highwayCycleTurnViolation } from './highway-turns.mjs';
import { boundaryFaceWalks } from './highway-boundary-regions.mjs';

function fixture(missingSW = false) {
  const W = [-0.002, 0],
    E = [0.002, 0],
    N = [0, 0.002],
    S = [0, -0.002];
  const ports = [
    ['center:0:0', W, 0, -1, [-0.01, 0]],
    ['center:0:1', E, 0, 1, [0.01, 0]],
    ['center:1:1', N, 1, 1, [0, 0.01]],
    ['center:1:0', S, 1, -1, [0, -0.01]],
  ];
  const nodes = ports.flatMap(([id, coordinate, , , outer], i) => [
    { id, coordinate },
    { id: `outer:${i}`, coordinate: outer },
  ]);
  const port = (mainlineId, direction) => ({
    mainlineId: `mainline:${mainlineId}`,
    direction,
  });
  const edges = ports.map(([fromId, p, road, d, q], i) => ({
    fromId,
    toId: `outer:${i}`,
    coordinates: [p, q],
    partIndices: new Set([road]),
    fromTurnPort: port(road, d),
  }));
  edges.push(
    {
      fromId: ports[0][0],
      toId: ports[1][0],
      coordinates: [W, E],
      partIndices: new Set([0]),
      fromTurnPort: port(0, 1),
      toTurnPort: port(0, -1),
    },
    {
      fromId: ports[3][0],
      toId: ports[2][0],
      coordinates: [S, N],
      partIndices: new Set([1]),
      fromTurnPort: port(1, 1),
      toTurnPort: port(1, -1),
    },
  );
  const turns = [
    [
      0,
      2,
      [
        [-0.002, 0],
        [-0.001, 0.0004],
        [0, 0.002],
      ],
    ],
    [2, 1, [N, [0.001, 0.001], E]],
    [1, 3, [E, [0.001, -0.001], S]],
    ...(missingSW ? [] : [[3, 0, [S, [-0.001, -0.001], W]]]),
  ];
  for (const [a, b, coordinates] of turns) {
    const pa = ports[a],
      pb = ports[b];
    edges.push({
      fromId: pa[0],
      toId: pb[0],
      coordinates,
      partIndices: new Set([2]),
      fromTurnPort: port(pa[2], -pa[3]),
      toTurnPort: port(pb[2], -pb[3]),
    });
  }
  edges.push({
    fromId: 'outer:0',
    toId: 'outer:2',
    coordinates: [
      [-0.01, 0],
      [-0.01, 0.01],
      [0, 0.01],
    ],
    partIndices: new Set([3]),
  });
  return {
    source: { nodes, edges },
    parts: [
      { role: 'mainline' },
      { role: 'mainline' },
      { role: 'connector' },
      { role: 'mainline' },
    ],
  };
}

test('one interchange node, four approaches, and all twelve legal directed movements', () => {
  const { source, parts } = fixture();
  const macro = buildInterchangeGraph(source, parts);
  assert.equal(macro.interchanges.size, 1);
  assert.equal(macro.edges.length, 5);
  const node = [...macro.interchanges.values()][0];
  assert.equal(node.approaches.length, 4);
  assert.equal(node.movements.size, 12);
  assert.ok([...node.movements.values()].every((m) => m.from !== m.to));
  assert.ok(
    macro.edges.every(
      (e) => ![...e.partIndices].some((i) => parts[i].role === 'connector'),
    ),
  );
});

test('a missing reciprocal movement cannot be manufactured by reversing along another ramp', () => {
  const { source, parts } = fixture(true),
    macro = buildInterchangeGraph(source, parts),
    node = [...macro.interchanges.values()][0];
  const W = node.approaches.find((p) => p.nodeId === 'center:0:0'),
    S = node.approaches.find((p) => p.nodeId === 'center:1:0');
  assert.equal(node.movements.has(`${W.key}|${S.key}`), false);
  assert.equal(node.movements.has(`${S.key}|${W.key}`), false);
});

test('the solver scores expanded ramp geometry and keeps its relaxation a conservative bound', () => {
  const { source, parts } = fixture(),
    macro = buildInterchangeGraph(source, parts);
  const graph = attachInterchangeBoundaryGraph(
    planarizeHighways(macro.edges, () => {}, { geodesic: true }),
    macro,
  );
  const result = searchPairedHighwayBoundary(graph, { maxMilliseconds: 1000 });
  assert.equal(result.status, 'complete', result.error);
  assert.ok(result.best);
  const expected = Math.abs(
    area([
      [-0.002, 0],
      [-0.01, 0],
      [-0.01, 0.01],
      [0, 0.01],
      [0, 0.002],
      [-0.001, 0.0004],
      [-0.002, 0],
    ]),
  );
  assert.ok(
    Math.abs(result.best.area - expected) < 0.01,
    `${result.best.area} vs ${expected}`,
  );
  assert.ok(result.best.pieces.some((p) => p.role === 'connector'));
  const before = { ...graph.scoreStatistics };
  const cached = graph.scoreWalk(
    [...result.best.walk.slice(1), result.best.walk[0]],
    () => {
      throw Error('Unexpected recomputation');
    },
  );
  assert.equal(cached.area, result.best.area);
  assert.equal(graph.scoreStatistics.hits, before.hits + 1);
  assert.equal(graph.scoreStatistics.misses, before.misses);
  assert.equal(
    result.best.coordinates[0].join(),
    result.best.coordinates.at(-1).join(),
  );
  assert.ok(
    graph.relaxationUpperBound(
      boundaryFaceWalks(
        graph,
        graph.edges.map((_, i) => i),
      ),
    ) >= result.best.area,
  );
});

test('expanded solver route retains real source identities and passes source turn validation', () => {
  const { source, parts } = fixture(),
    timings = [];
  const result = solveInterchangeBoundary(source, parts, {
    maxPhaseMilliseconds: 1000,
    onTiming: (t) => timings.push(t),
  });
  assert.equal(result.optimizationStatus, 'optimal', result.search.error);
  assert.ok(result.segments.length >= 3);
  assert.equal(highwayCycleTurnViolation(result.segments, source.edges), null);
  assert.deepEqual(
    timings.map((t) => t.phase),
    ['interchange-graph', 'mainline-planarization', 'outer-boundary-search'],
  );
  assert.ok(timings.every((t) => t.milliseconds >= 0));
});

test('local unrestricted mode stops at the normal root, expands real ramp geometry, and never scores or checkpoints', () => {
  const { source, parts } = fixture();
  const macro = buildInterchangeGraph(source, parts);
  const graph = attachInterchangeBoundaryGraph(planarizeHighways(macro.edges), macro);
  const result = searchPairedHighwayBoundary(
    {
      ...graph,
      scoreWalk: () => {
        throw Error('Preview entered scoring');
      },
    },
    {
      previewUnrestricted: true,
      onCheckpoint: () => {
        throw Error('Preview overwrote a solver checkpoint');
      },
    },
  );
  assert.equal(result.status, 'unrestricted-preview');
  assert.equal(result.states, 1);
  assert.equal(result.timings.scoring, 0);
  assert.equal(result.timings.branching, 0);
  assert.ok(result.best.pieces.some((piece) => piece.role === 'connector'));
  const output = solveInterchangeBoundary(source, parts, { previewUnrestricted: true });
  assert.equal(output.optimizationStatus, 'unrestricted-preview');
  assert.equal(output.objectiveUpperBoundSquareMeters, null);
});

test('forbidden turns can only be expanded when explicitly requested as a diagnostic', () => {
  const { source, parts } = fixture();
  const macro = buildInterchangeGraph(source, parts);
  const graph = attachInterchangeBoundaryGraph(planarizeHighways(macro.edges), macro);
  const root = searchPairedHighwayBoundary(graph, { previewUnrestricted: true });
  const h = root.best.walk[0],
    e = graph.edges[h >> 1],
    v = h % 2 ? e.fromId : e.toId;
  const backward = [h, h ^ 1];
  assert.equal(graph.legal(h >> 1, h >> 1, v), false);
  assert.throws(() => graph.expand(backward), /Forbidden interchange movement/);
  assert.ok(graph.expand(backward, { allowForbiddenTurns: true }).pieces.length);
});

test('an overpass without reciprocal ramps creates no interchange or cross-road turn', () => {
  const source = {
    nodes: [
      { id: 'a', coordinate: [-0.01, 0] },
      { id: 'b', coordinate: [0.01, 0] },
      { id: 'c', coordinate: [0, -0.01] },
      { id: 'd', coordinate: [0, 0.01] },
    ],
    edges: [
      {
        fromId: 'a',
        toId: 'b',
        coordinates: [
          [-0.01, 0],
          [0.01, 0],
        ],
        partIndices: new Set([0]),
      },
      {
        fromId: 'c',
        toId: 'd',
        coordinates: [
          [0, -0.01],
          [0, 0.01],
        ],
        partIndices: new Set([1]),
      },
    ],
  };
  const macro = buildInterchangeGraph(source, [
    { role: 'mainline' },
    { role: 'mainline' },
  ]);
  assert.equal(macro.interchanges.size, 0);
  const graph = attachInterchangeBoundaryGraph(planarizeHighways(macro.edges), macro);
  const junction = graph.nodes.find((n) => n.coordinate.join() === '0,0').id;
  const a = graph.edges.findIndex((e) => e.road === 0),
    b = graph.edges.findIndex((e) => e.road === 1);
  assert.equal(graph.legal(a, b, junction), false);
});
