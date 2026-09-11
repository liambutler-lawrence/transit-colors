import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildOsmHighwayCenterlines,
  buildOsmSourceTopologyGraph,
  buildPairedOsmSourceTopologyGraph,
  connectMainlinePartsAtSourceNodes,
} from './osm-highway-network.mjs';
import { hasProperSelfIntersection } from './highway-cycle.mjs';
import { geodesicDistanceMeters } from './wgs84-geodesy.mjs';

const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/jacksonville-mainline-crossings.json', import.meta.url),
    'utf8',
  ),
);
const inside = (point, [west, south, east, north]) =>
  point[0] > west && point[0] < east && point[1] > south && point[1] < north;
const crossing = [-81.554, 30.3475, -81.551, 30.3501];
const merge = [-81.556, 30.3566, -81.5525, 30.3615];

test('a source-proven continuation replaces its terminal instead of doubling back to it', () => {
  const coordinate = (x, y = 0) => [x / 111_320, y / 110_574];
  const nodeIds = ['west', 'join', 'east'];
  const source = [coordinate(0, 10), coordinate(125, 10), coordinate(250, 10)];
  const nodes = new Map(
    nodeIds.map((id, index) => [id, { coordinate: source[index], tags: {} }]),
  );
  const ways = [
    { id: 'west', nodeIds: ['west', 'join'] },
    { id: 'east', nodeIds: ['join', 'east'] },
  ];
  const parts = [
    {
      id: 'west',
      sourceWayIds: ['west'],
      coordinates: [coordinate(0), coordinate(100)],
      sourceRanges: [{ chainId: 'road', positions: [0, 0.9] }],
    },
    {
      id: 'east',
      sourceWayIds: ['east'],
      coordinates: [coordinate(150), coordinate(250)],
      sourceRanges: [{ chainId: 'road', positions: [1.1, 2] }],
    },
  ];
  connectMainlinePartsAtSourceNodes({ nodes }, ways, parts, [
    { id: 'road', coordinates: source, nodeIds },
  ]);
  assert.deepEqual(parts[0].coordinates.at(-1), parts[1].coordinates[0]);
  for (const part of parts)
    for (let index = 1; index < part.coordinates.length; index += 1) {
      assert.ok(part.coordinates[index][0] > part.coordinates[index - 1][0]);
    }
});

function assertForwardRuns(parts, bounds) {
  let checked = 0;
  for (const part of parts) {
    let run = [];
    const check = () => {
      if (run.length < 3) return;
      checked += 1;
      assert.equal(hasProperSelfIntersection(run), false, part.id);
      const direction = Math.sign(run.at(-1)[1] - run[0][1]);
      for (let i = 1; i < run.length; i += 1)
        assert.ok(
          (run[i][1] - run[i - 1][1]) * direction > 0,
          `${part.id} advances through the crossing or merge`,
        );
    };
    for (const point of part.coordinates) {
      if (inside(point, bounds)) run.push(point);
      else {
        check();
        run = [];
      }
    }
    check();
  }
  assert.ok(checked >= 2, 'both approaches were checked');
}

test('Jacksonville ring-road source intervals preserve clean merges and disconnected bridge crossings', () => {
  // Keep the complete I-295 loop: a small geographic crop splits its source
  // chains and hides the false junctions this regression needs to reproduce.
  const osm = { nodes: new Map(fixture.nodes), ways: fixture.ways };
  const built = buildOsmHighwayCenterlines(osm);
  const parts = built.parts.filter((part) => part.role === 'mainline');
  assertForwardRuns(parts, crossing);
  assertForwardRuns(parts, merge);
  const junctions = parts.flatMap((part) => part.topologyCoordinates ?? []);
  assert.equal(
    junctions.filter((entry) => inside(entry.coordinate, crossing)).length,
    0,
    'an overpass is not an interchange',
  );
  const joins = junctions.filter(
    (entry) => entry.key === 'osm-mainline-junction:96580868',
  );
  assert.ok(joins.length >= 2, 'preserve the actual northern mainline merge');
  assert.equal(new Set(joins.map((entry) => entry.coordinate.join())).size, 1);
  assert.ok(
    geodesicDistanceMeters(joins[0].coordinate, [-81.5537868, 30.3604028]) < 10,
  );
  let arms = 0;
  for (const part of parts)
    for (let i = 1; i < part.coordinates.length; i += 1) {
      if (
        part.coordinates[i - 1].join() === joins[0].coordinate.join() ||
        part.coordinates[i].join() === joins[0].coordinate.join()
      )
        arms += 1;
    }
  assert.equal(arms, 3, 'exactly three arms meet at the real merge');
  const graph = buildOsmSourceTopologyGraph(null, built.parts);
  const degrees = new Map();
  for (const edge of graph.edges)
    for (const id of [edge.fromId, edge.toId])
      degrees.set(id, (degrees.get(id) ?? 0) + 1);
  let vertices = 0;
  for (const [id, coordinate] of graph.coordinateByNodeId)
    if (inside(coordinate, crossing)) {
      assert.equal(
        degrees.get(id),
        2,
        'the crossing must neither join the roads nor break either road',
      );
      vertices += 1;
    }
  assert.ok(vertices >= 8);
  // The routing graph also maps source vertices to displayed medians. It
  // must use the same interval constraint, rather than silently creating a
  // connection that is absent from the corrected rendering.
  const routing = buildPairedOsmSourceTopologyGraph(osm, built.parts);
  const remaining = new Set(
    [...routing.coordinateByNodeId]
      .filter(([, point]) => inside(point, crossing))
      .map(([id]) => id),
  );
  const adjacency = new Map([...remaining].map((id) => [id, new Set()]));
  for (const edge of routing.edges)
    if (remaining.has(edge.fromId) && remaining.has(edge.toId)) {
      adjacency.get(edge.fromId).add(edge.toId);
      adjacency.get(edge.toId).add(edge.fromId);
    }
  let components = 0;
  while (remaining.size) {
    const pending = [remaining.values().next().value];
    components += 1;
    while (pending.length) {
      const id = pending.pop();
      if (!remaining.delete(id)) continue;
      pending.push(...adjacency.get(id));
    }
  }
  assert.equal(
    components,
    2,
    'the actual route graph keeps the two highway crossings independent',
  );
});
