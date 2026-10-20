import assert from 'node:assert/strict';
import test from 'node:test';
import { finalizeMidpointTopology } from './highway-midpoint-topology.mjs';
import {
  buildMidpointTopologyGraph,
  buildPairedOsmSourceTopologyGraph,
} from './osm-highway-network.mjs';
const mainline = (id, coordinates, extra = {}) => ({
  id,
  coordinates,
  role: 'mainline',
  sourceWayIds: [],
  tokens: [],
  ...extra,
});

test('graph consumes midpoint geometry without accessing source carriageways', () => {
  const parts = [
    mainline('curve', [
      [0, 0],
      [0.001, 0.001],
      [0.002, 0],
    ]),
  ];
  const source = new Proxy(
    {},
    {
      get() {
        throw new Error('Source carriageways accessed');
      },
    },
  );
  const graph = buildPairedOsmSourceTopologyGraph(source, structuredClone(parts));
  assert.deepEqual(graph, buildMidpointTopologyGraph(parts));
  assert.deepEqual([...graph.coordinateByNodeId.values()], parts[0].coordinates);
  assert.equal(graph.edges.length, 2);
});

test('topology finalization reconciles sub-meter explicit identities, then is idempotent', () => {
  const parts = [
    mainline(
      'a',
      [
        [0, 0],
        [0.001, 0],
      ],
      { endTopologyKeys: ['seam'] },
    ),
    mainline(
      'b',
      [
        [0.001, 0.000002],
        [0.002, 0],
      ],
      { startTopologyKeys: ['seam'] },
    ),
  ];
  finalizeMidpointTopology(parts);
  assert.deepEqual(parts[0].coordinates.at(-1), parts[1].coordinates[0]);
  const saved = structuredClone(parts);
  finalizeMidpointTopology(parts);
  assert.deepEqual(parts, saved);
  const graph = buildMidpointTopologyGraph(parts);
  for (const edge of graph.edges) {
    const a = graph.coordinateByNodeId.get(edge.fromId),
      b = graph.coordinateByNodeId.get(edge.toId);
    assert.ok(
      JSON.stringify(a) === JSON.stringify(b) ||
        parts.some((p) =>
          p.coordinates.some(
            (c, i) =>
              i &&
              JSON.stringify(c) === JSON.stringify(b) &&
              JSON.stringify(p.coordinates[i - 1]) === JSON.stringify(a),
          ),
        ),
    );
  }
});

test('coincident endpoints with no shared identity remain disconnected', () => {
  const parts = [
    mainline('a', [
      [0, 0],
      [0.001, 0],
    ]),
    mainline('b', [
      [0.001, 0],
      [0.002, 0],
    ]),
  ];
  const graph = buildMidpointTopologyGraph(finalizeMidpointTopology(parts));
  assert.equal(graph.edges.length, 2);
  assert.equal(graph.coordinateByNodeId.size, 4);
});

test('inconsistent explicit metadata fails instead of creating a shortcut', () => {
  const parts = [
    mainline(
      'a',
      [
        [0, 0],
        [0.001, 0],
      ],
      { endTopologyKeys: ['seam'] },
    ),
    mainline(
      'b',
      [
        [0.01, 0],
        [0.02, 0],
      ],
      { startTopologyKeys: ['seam'] },
    ),
  ];
  assert.throws(() => finalizeMidpointTopology(parts), /more than 1 m/);
  assert.throws(() => buildMidpointTopologyGraph(parts), /different coordinates/);
});
