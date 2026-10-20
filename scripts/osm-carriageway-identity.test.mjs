import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  buildAveragedMainlines,
  buildOsmHighwayCenterlines,
  buildMidpointTopologyGraph,
  prepareWays,
  traceMotorwayChains,
} from './osm-highway-network.mjs';
import { hasProperSelfIntersection } from './highway-cycle.mjs';

test('a closer branch cannot borrow a route ref used elsewhere along its chain', () => {
  const a = new Set(['A']),
    b = new Set(['B']),
    both = new Set(['A', 'B']);
  const chains = [
    {
      id: 'chain-1',
      coordinates: [
        [0, 0],
        [0.004, 0],
      ],
      tokens: a,
      segmentTokens: [a],
      sourceWayIds: ['a'],
    },
    {
      id: 'chain-2',
      coordinates: [
        [0.004, 0.0005],
        [0, 0.0005],
      ],
      tokens: both,
      segmentTokens: [a],
      sourceWayIds: ['a-return'],
    },
    {
      id: 'chain-3',
      coordinates: [
        [0.004, 0.00005],
        [0, 0.00005],
      ],
      tokens: both,
      segmentTokens: [b],
      sourceWayIds: ['b-branch'],
    },
  ];
  const result = buildAveragedMainlines(chains);
  const primary = result.parts.filter((p) => p.sourceChainId === 'chain-1');
  assert.ok(primary.length);
  assert.ok(primary.every((p) => p.pairedChainId === 'chain-2'));
  assert.ok(
    primary.flatMap((p) => p.coordinates).every((p) => Math.abs(p[1] - 0.00025) < 1e-7),
  );
});

test('unreferenced carriageways retain geometric pairing and concurrent refs remain compatible', () => {
  for (const [a, b] of [
    [new Set(), new Set()],
    [new Set(['A', 'B']), new Set(['B'])],
  ]) {
    const result = buildAveragedMainlines([
      {
        id: 'chain-1',
        coordinates: [
          [0, 0],
          [0.002, 0],
        ],
        tokens: a,
        segmentTokens: [a],
        sourceWayIds: ['a'],
      },
      {
        id: 'chain-2',
        coordinates: [
          [0.002, 0.0001],
          [0, 0.0001],
        ],
        tokens: b,
        segmentTokens: [b],
        sourceWayIds: ['b'],
      },
    ]);
    assert.ok(result.parts.length);
    assert.ok(
      result.parts.every(
        (p) => p.sourceChainId === 'chain-1' && p.pairedChainId === 'chain-2',
      ),
    );
  }
});

test('a locally witnessed pair stays continuous across asymmetric route-ref transitions', () => {
  const a = new Set(['A']),
    b = new Set(['B']);
  const result = buildAveragedMainlines([
    {
      id: 'chain-1',
      coordinates: [
        [0, 0],
        [0.002, 0],
        [0.004, 0],
      ],
      tokens: new Set(['A', 'B']),
      segmentTokens: [a, b],
      sourceWayIds: ['a', 'b'],
    },
    {
      id: 'chain-2',
      coordinates: [
        [0.004, 0.0001],
        [0, 0.0001],
      ],
      tokens: b,
      segmentTokens: [b],
      sourceWayIds: ['return'],
    },
  ]);
  assert.equal(result.parts.length, 1);
  assert.ok(Math.abs(result.parts[0].coordinates[0][0]) < 1e-7);
  assert.ok(Math.abs(result.parts[0].coordinates.at(-1)[0] - 0.004) < 1e-7);
});

test('Butte has a continuous I-15/I-90 median and one actual reciprocal I-115 ramp', () => {
  const f = JSON.parse(
    fs.readFileSync(
      new URL('./fixtures/butte-carriageway-branch.json', import.meta.url),
      'utf8',
    ),
  );
  const osm = { nodes: new Map(f.nodes), ways: f.ways };
  const chains = traceMotorwayChains(prepareWays(osm).mainlines);
  assert.ok(chains.every((c) => c.segmentTokens.length === c.coordinates.length - 1));
  const built = buildOsmHighwayCenterlines(osm);
  const mainlines = built.parts.filter((p) => p.role === 'mainline');
  assert.ok(
    mainlines.every((p) => !(p.tokens.includes('I15') && p.tokens.includes('I115'))),
  );
  assert.ok(mainlines.every((p) => !hasProperSelfIntersection(p.coordinates)));
  const ramps = built.parts.filter((p) => p.role === 'connector');
  assert.equal(ramps.length, 1);
  assert.deepEqual(
    new Set(ramps[0].sourceWayIds),
    new Set(['1021544989', '1228189715']),
  );
  assert.equal(built.statistics.unpairedConnectorPathCount, 0);
  const g = buildMidpointTopologyGraph(built.parts);
  const adjacency = new Map();
  for (const e of g.edges) {
    if (![...e.partIndices].every((i) => g.parts[i].tokens.includes('I15'))) continue;
    for (const [a, b] of [
      [e.fromId, e.toId],
      [e.toId, e.fromId],
    ]) {
      const row = adjacency.get(a) ?? [];
      row.push(b);
      adjacency.set(a, row);
    }
  }
  const target = [...g.coordinateByNodeId].filter(
    ([id, p]) =>
      adjacency.has(id) &&
      p[0] > -112.58 &&
      p[0] < -112.55 &&
      p[1] > 45.99 &&
      p[1] < 46.009,
  );
  assert.ok(target.length > 10);
  const seen = new Set([target[0][0]]),
    pending = [target[0][0]];
  while (pending.length)
    for (const id of adjacency.get(pending.pop()) ?? [])
      if (!seen.has(id)) {
        seen.add(id);
        pending.push(id);
      }
  assert.ok(
    target.every(([id]) => seen.has(id)),
    'all I-15/I-90 approaches connect across the interchange',
  );
});
