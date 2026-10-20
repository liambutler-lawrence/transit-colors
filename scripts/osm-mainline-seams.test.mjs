import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPairedOsmSourceTopologyGraph } from './osm-highway-network.mjs';

test('staggered carriageway samples share every vertex across an explicit continuation seam', () => {
  const parts = [
    {
      id: 'before',
      coordinates: [
        [0, 0],
        [0.001, 0],
        [0.002, 0.0002],
      ],
    },
    {
      id: 'continuation',
      coordinates: [
        [0.002, 0.0002],
        [0.003, 0.0005],
        [0.004, 0.0006],
        [0.005, 0.0004],
      ],
      continuationEndpoints: { beforeId: 'before' },
    },
  ].map((part) => ({
    ...part,
    role: 'mainline',
    sourceWayIds: ['1', '2'],
    tokens: ['I95'],
  }));
  const nodes = new Map();
  // One carriageway skips the seam; the other samples it and skips ahead.
  const samples = [
    [
      parts[0].coordinates[0],
      parts[0].coordinates[1],
      parts[1].coordinates[1],
      parts[1].coordinates[3],
    ],
    [parts[1].coordinates[3], parts[0].coordinates[2], parts[0].coordinates[0]],
  ];
  const ways = samples.map((coordinates, wayIndex) => ({
    id: String(wayIndex + 1),
    nodeIds: coordinates.map((coordinate, index) => {
      const id = `${wayIndex}-${index}`;
      nodes.set(id, { coordinate, tags: {} });
      return id;
    }),
    tags: { highway: 'motorway', lanes: '2', oneway: 'yes' },
  }));
  const graph = buildPairedOsmSourceTopologyGraph({ nodes, ways }, parts);
  assert.equal(graph.coordinateByNodeId.size, 7);
  assert.equal(graph.edges.length, 6);
  const degree = new Map();
  for (const edge of graph.edges) {
    for (const id of [edge.fromId, edge.toId])
      degree.set(id, (degree.get(id) ?? 0) + 1);
    assert.equal(
      edge.partIndices.size,
      1,
      'each edge is emitted once from the midpoint geometry',
    );
  }
  assert.deepEqual([...degree.values()].sort(), [1, 1, 2, 2, 2, 2, 2]);
});
