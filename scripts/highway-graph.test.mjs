import assert from 'node:assert/strict';
import test from 'node:test';
import { compressHighwayCore, highwayTwoCore } from './highway-graph.mjs';
import { buildInterchangeGraph } from './highway-interchange-graph.mjs';

function ring(parts) {
  const coordinates = new Map([
    ['a', [0, 0]],
    ['b', [0.01, 0]],
    ['c', [0.02, 0]],
    ['d', [0.02, 0.01]],
    ['e', [0.01, 0.01]],
    ['f', [0, 0.01]],
  ]);
  const ids = [...coordinates.keys()];
  const edges = ids.map((fromId, i) => ({
    fromId,
    toId: ids[(i + 1) % ids.length],
    partIndices: new Set([i === 2 ? 1 : 0]),
  }));
  const core = highwayTwoCore(new Set(ids), edges);
  return { coordinates, edges, core, parts };
}

test('degree-two ramp boundaries survive compression without changing the source walk', () => {
  const f = ring([{ role: 'mainline' }, { role: 'connector' }]);
  const compressed = compressHighwayCore(f.coordinates, f.edges, f.core, {
    parts: f.parts,
    includeSourceEdges: true,
  });
  assert.deepEqual(new Set(compressed.nodes.map((n) => n.id)), new Set(['c', 'd']));
  assert.equal(compressed.edges.length, 2);
  const ramp = compressed.edges.find((e) => e.partIndices.has(1));
  assert.deepEqual(ramp.partIndices, new Set([1]));
  assert.deepEqual(ramp.coordinates, [f.coordinates.get('c'), f.coordinates.get('d')]);
  const mainline = compressed.edges.find((e) => e.partIndices.has(0));
  assert.equal(mainline.coordinates.length, 6);
  assert.deepEqual(mainline.partIndices, new Set([0]));
  assert.equal(
    compressed.edges.reduce((n, e) => n + e.sourceEdgeIndices.length, 0),
    f.edges.length,
  );
});

test('explicit merge boundaries survive even when both parts render as mainlines', () => {
  const f = ring([
    { role: 'mainline' },
    { role: 'mainline', explicitMainlineMerge: true },
  ]);
  const c = compressHighwayCore(f.coordinates, f.edges, f.core, { parts: f.parts });
  assert.equal(c.nodes.length, 2);
  assert.equal(c.edges.length, 2);
  assert.ok(c.edges.every((e) => e.partIndices.size === 1));
});

test('interchange construction rejects a stale edge containing both a mainline and ramp', () => {
  const source = {
    nodes: [
      { id: 'a', coordinate: [0, 0] },
      { id: 'b', coordinate: [0.01, 0] },
    ],
    edges: [
      {
        fromId: 'a',
        toId: 'b',
        coordinates: [
          [0, 0],
          [0.01, 0],
        ],
        partIndices: new Set([0, 1]),
      },
    ],
  };
  assert.throws(
    () => buildInterchangeGraph(source, [{ role: 'mainline' }, { role: 'connector' }]),
    /mixes mainlines with ramps/,
  );
});
