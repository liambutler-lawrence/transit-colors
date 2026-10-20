import { biconnectedEdgeBlocks } from './highway-cycle.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDenseBoundaryBlocks,
  planarizeHighways,
  searchHighwayBoundary,
} from './highway-boundary-search.mjs';
import { solveHighwayAreaCycle } from './highway-area-cycle.mjs';
const network = (points, pairs) => ({
  nodes: Object.entries(points).map(([id, coordinate]) => ({ id, coordinate })),
  edges: pairs.map(([fromId, toId]) => ({
    fromId,
    toId,
    coordinates: [points[fromId], points[toId]],
    partIndices: new Set(),
  })),
});
async function compare(g) {
  const planar = planarizeHighways(g.edges);
  const actual = searchHighwayBoundary(planar);
  const expected = await solveHighwayAreaCycle(g.nodes, g.edges);
  assert.equal(actual.status, 'optimal', actual.error);
  assert.ok(
    Math.abs(actual.best.area - expected.areaSquareMeters) <
      Math.max(1, expected.areaSquareMeters * 1e-5),
    `${actual.best.area} vs ${expected.areaSquareMeters}`,
  );
  return actual;
}
test('outer boundary matches exact solver for two neighboring loops', async () => {
  await compare(
    network(
      {
        a: [0, 0],
        b: [0.01, 0],
        c: [0.01, 0.01],
        d: [0, 0.01],
        e: [0.03, 0],
        f: [0.03, 0.01],
      },
      [
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'd'],
        ['d', 'a'],
        ['b', 'e'],
        ['e', 'f'],
        ['f', 'c'],
      ],
    ),
  );
});
test('illegal junction turn branches without permitting a median reversal', async () => {
  const g = network(
    {
      a: [0, 0],
      b: [0.01, 0],
      c: [0.01, 0.01],
      d: [0, 0.01],
      e: [0.03, 0],
      f: [0.03, 0.01],
    },
    [
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'd'],
      ['d', 'a'],
      ['b', 'e'],
      ['e', 'f'],
      ['f', 'c'],
    ],
  );
  g.edges[0].toTurnPort = { mainlineId: 'road', direction: 1 };
  g.edges[1].fromTurnPort = { mainlineId: 'road', direction: -1 };
  g.edges[4].fromTurnPort = { mainlineId: 'road', direction: 1 };
  const r = await compare(g);
  assert.ok(r.states > 1);
});
test('crossing independent triangles cannot switch roads at overpasses', async () => {
  const g = network(
    {
      a: [0, 0],
      b: [0.04, 0],
      c: [0.02, 0.04],
      d: [0, 0.025],
      e: [0.05, 0.025],
      f: [0.025, -0.02],
    },
    [
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'a'],
      ['d', 'e'],
      ['e', 'f'],
      ['f', 'd'],
    ],
  );
  const r = await compare(g);
  assert.ok(r.states > 1);
});
test('coincident roads retain separate identities and a valid rotation system', async () => {
  const g = network({ a: [0, 0], b: [0.01, 0], c: [0.01, 0.01], d: [0, 0.01] }, [
    ['a', 'b'],
    ['b', 'c'],
    ['c', 'd'],
    ['d', 'a'],
    ['a', 'b'],
  ]);
  const r = await compare(g);
  assert.ok(r.best.area > 0);
});
test('repeated coordinates do not create zero-length planar edges', async () => {
  const g = network({ a: [0, 0], b: [0.01, 0], c: [0.01, 0.01], d: [0, 0.01] }, [
    ['a', 'b'],
    ['b', 'c'],
    ['c', 'd'],
    ['d', 'a'],
  ]);
  g.edges[0].coordinates.splice(1, 0, g.edges[0].coordinates[0]);
  await compare(g);
});
test('self-crossing road geometry does not create a legal shortcut cycle', () => {
  const graph = planarizeHighways([
    {
      fromId: 'a',
      toId: 'z',
      coordinates: [
        [0, 0],
        [0.01, 0],
        [0.01, 0.01],
        [0.02, 0.01],
        [0.02, 0],
        [0.01, 0],
        [0.03, -0.01],
      ],
    },
  ]);
  const actual = searchHighwayBoundary(graph);
  assert.equal(actual.status, 'optimal', actual.error);
  assert.equal(actual.best, null);
});
test('near-parallel endpoint contact uses the exact source endpoint', () => {
  const a = [-79.4831681, 43.7221698],
    b = [-79.4831025, 43.7221862];
  const c = [-79.4830653, 43.7221955],
    d = [-79.4831417, 43.7221764];
  const graph = planarizeHighways([
    { fromId: 'a', toId: 'b', coordinates: [a, b] },
    { fromId: 'c', toId: 'd', coordinates: [c, d] },
  ]);
  assert.equal(graph.nodes.length, 4);
  assert.equal(graph.edges.length, 4);
  const contact = graph.nodes.find(
    (n) => n.coordinate[0] === d[0] && n.coordinate[1] === d[1],
  );
  assert.ok(contact);
  assert.equal(
    graph.edges.filter((e) => e.fromId === contact.id || e.toId === contact.id).length,
    3,
  );
  // Geometric contact alone must not authorize a road transfer.
  const pieces = graph.edges.map((e, i) => ({ e, i }));
  const left = pieces.find(({ e }) => e.road === 0 && e.toId === contact.id);
  const right = pieces.find(({ e }) => e.road === 1);
  assert.equal(graph.legal(left.i, right.i, contact.id), false);
});
const crossingFixture = () =>
  planarizeHighways(
    network(
      {
        a: [0, 0],
        b: [0.04, 0],
        c: [0.02, 0.04],
        d: [0, 0.025],
        e: [0.05, 0.025],
        f: [0.025, -0.02],
      },
      [
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'a'],
        ['d', 'e'],
        ['e', 'f'],
        ['f', 'd'],
      ],
    ).edges,
  );
test('saved frontier resumes to the same optimum after a bounded run', () => {
  const graph = crossingFixture();
  const expected = searchHighwayBoundary(graph);
  let saved;
  const paused = searchHighwayBoundary(graph, {
    maxStates: 1,
    checkpointKey: 'fixture-v1',
    onCheckpoint: (c) => {
      saved = structuredClone(c);
    },
  });
  assert.equal(paused.status, 'incomplete');
  assert.ok(saved.queue.length);
  const resumed = searchHighwayBoundary(graph, {
    checkpoint: saved,
    checkpointKey: 'fixture-v1',
  });
  assert.equal(resumed.status, 'optimal');
  assert.equal(resumed.best.area, expected.best.area);
  assert.deepEqual(resumed.best.cycle, expected.best.cycle);
  assert.throws(
    () =>
      searchHighwayBoundary(graph, { checkpoint: saved, checkpointKey: 'different' }),
    /does not match/,
  );
});
test('interruption during validation preserves the popped state', () => {
  const graph = crossingFixture(),
    original = graph.legal;
  let armed = false,
    saved;
  graph.legal = (...args) => {
    if (armed) throw new Error('Injected interruption');
    return original(...args);
  };
  const interrupted = searchHighwayBoundary(graph, {
    checkpointKey: 'fixture-v1',
    onCheckpoint: (c) => {
      saved = structuredClone(c);
      armed = true;
    },
  });
  assert.equal(interrupted.status, 'incomplete');
  assert.ok(saved.queue.length);
  graph.legal = original;
  const resumed = searchHighwayBoundary(graph, {
    checkpointKey: 'fixture-v1',
    checkpoint: saved,
  });
  assert.equal(resumed.status, 'optimal');
  assert.equal(resumed.best.area, searchHighwayBoundary(graph).best.area);
});
test('interrupted child expansion rolls back partial branch bookkeeping', () => {
  const graph = crossingFixture(),
    original = graph.legal;
  let armed = false,
    saved,
    childCalls = 0;
  graph.legal = (...args) => {
    if (armed && new Error().stack.includes('at enqueue') && ++childCalls === 10)
      throw new Error('Injected child interruption');
    return original(...args);
  };
  const interrupted = searchHighwayBoundary(graph, {
    checkpointKey: 'fixture-v1',
    onCheckpoint: (c) => {
      saved = structuredClone(c);
      armed = true;
    },
  });
  assert.equal(interrupted.error, 'Injected child interruption');
  graph.legal = original;
  const resumed = searchHighwayBoundary(graph, {
    checkpointKey: 'fixture-v1',
    checkpoint: saved,
  });
  assert.equal(resumed.status, 'optimal');
  assert.equal(resumed.best.area, searchHighwayBoundary(graph).best.area);
});
test('cached rotation preserves the searched frontier and optimum', () => {
  const graph = crossingFixture();
  const baseline = searchHighwayBoundary(graph, { cacheRotation: false });
  const cached = searchHighwayBoundary(graph, { cacheRotation: true });
  assert.equal(cached.status, baseline.status);
  assert.deepEqual(cached.best, baseline.best);
  assert.equal(cached.states, baseline.states);
});

test('dense face scratch preserves boundaries across blocks and child expansions', () => {
  const graph = crossingFixture();
  const baseline = searchHighwayBoundary(graph, { denseFaceTraversal: false });
  const dense = searchHighwayBoundary(graph);
  assert.equal(dense.status, baseline.status);
  assert.deepEqual(dense.best, baseline.best);
  assert.equal(dense.states, baseline.states);
});

test('dense blocks preserve multiedges, articulations and repeated changing subsets', () => {
  let seed = 12345;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const graph = { nodes: Array.from({ length: 14 }, (_, id) => ({ id })), edges: [] };
  for (let i = 0; i < 65; i++) {
    const fromId = random() % 14;
    const toId = (fromId + 1 + (random() % 13)) % 14;
    graph.edges.push({ fromId, toId });
  }
  const dense = createDenseBoundaryBlocks(graph);
  for (let run = 0; run < 80; run++) {
    const ids = graph.edges.map((_, i) => i).filter(() => random() % 5 > run % 4);
    if (run % 2) ids.reverse();
    const subset = ids.map((i) => graph.edges[i]);
    const nodes = [...new Set(subset.flatMap((e) => [e.fromId, e.toId]))].map((id) => ({
      id,
    }));
    const expected = biconnectedEdgeBlocks(nodes, subset).map((block) =>
      block.map((i) => ids[i]),
    );
    assert.deepEqual(dense(ids), expected);
  }
});
test('dense block search preserves the optimum and branch count', () => {
  const graph = crossingFixture();
  const baseline = searchHighwayBoundary(graph, { denseBlocks: false });
  const dense = searchHighwayBoundary(graph);
  assert.equal(dense.status, baseline.status);
  assert.deepEqual(dense.best, baseline.best);
  assert.equal(dense.states, baseline.states);
});

test('incremental propagation preserves complete frontier and optimum', () => {
  const graph = crossingFixture();
  let baseline, incremental;
  for (const enabled of [false, true]) {
    const result = searchHighwayBoundary(graph, {
      incrementalPropagation: enabled,
      checkpointKey: 'same-semantics',
      onCheckpoint: (c) => {
        if (enabled) incremental = structuredClone(c);
        else baseline = structuredClone(c);
      },
    });
    assert.equal(result.status, 'optimal');
  }
  assert.deepEqual(incremental.best, baseline.best);
  assert.equal(incremental.states, baseline.states);
  assert.deepEqual(new Set(incremental.seen), new Set(baseline.seen));
});

test('zero-length explicit road preserves a legal source-node transition', async () => {
  const g = network(
    { a: [0, 0], b: [0.01, 0], alias: [0.01, 0], c: [0.01, 0.01], d: [0, 0.01] },
    [
      ['a', 'b'],
      ['b', 'alias'],
      ['alias', 'c'],
      ['c', 'd'],
      ['d', 'a'],
    ],
  );
  await compare(g);
  const graph = planarizeHighways(g.edges);
  const first = graph.edges.findIndex((e) => e.road === 0);
  const second = graph.edges.findIndex((e) => e.road === 2);
  assert.deepEqual(graph.transitionRoads(first, second, graph.edges[first].toId), [1]);
  g.edges[1].fromTurnPort = { mainlineId: 'wrong', direction: 1 };
  const blocked = planarizeHighways(g.edges);
  assert.equal(blocked.legal(first, second, blocked.edges[first].toId), false);
  g.edges.splice(1, 1);
  const missing = planarizeHighways(g.edges);
  const x = missing.edges.findIndex((e) => e.road === 0),
    y = missing.edges.findIndex((e) => e.road === 1);
  assert.equal(missing.legal(x, y, missing.edges[x].toId), false);
});
