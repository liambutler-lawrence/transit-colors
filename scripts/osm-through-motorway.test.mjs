import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildOsmHighwayCenterlines,
  buildPairedOsmSourceTopologyGraph,
  buildRampConnectors,
  prepareWays,
} from './osm-highway-network.mjs';
import { geodesicDistanceMeters } from './wgs84-geodesy.mjs';
import { hasProperSelfIntersection } from './highway-cycle.mjs';

function fixture() {
  const data = JSON.parse(
    readFileSync(
      new URL('./fixtures/riverside-through-motorway.json', import.meta.url),
    ),
  );
  return { nodes: new Map(data.nodes), ways: data.ways };
}

function distanceToWay(point, way, nodes) {
  const scale = Math.cos((point[1] * Math.PI) / 180);
  return Math.min(
    ...way.nodeIds.slice(1).map((id, index) => {
      const a = nodes.get(way.nodeIds[index]).coordinate;
      const b = nodes.get(id).coordinate;
      const u = [(a[0] - point[0]) * 111320 * scale, (a[1] - point[1]) * 110574];
      const v = [(b[0] - a[0]) * 111320 * scale, (b[1] - a[1]) * 110574];
      const t = Math.max(
        0,
        Math.min(1, -(u[0] * v[0] + u[1] * v[1]) / (v[0] ** 2 + v[1] ** 2)),
      );
      return Math.hypot(u[0] + t * v[0], u[1] + t * v[1]);
    }),
  );
}

test('Riverside retains its east–west through connection where one direction narrows', () => {
  for (const reversed of [false, true]) {
    const osm = fixture();
    if (reversed) osm.ways.reverse();
    const built = buildOsmHighwayCenterlines(osm);
    const restored = built.parts.filter((part) => part.throughMainline);
    assert.equal(restored.length, 1);
    const connector = restored[0];
    assert.ok(connector.sourceWayIds.includes('504329517'));
    assert.equal(connector.pairedDirectionCount, 2);
    assert.equal(hasProperSelfIntersection(connector.coordinates), false);
    const westbound = osm.ways.find((way) => way.id === '504329517');
    const eastbound = osm.ways.filter((way) =>
      ['504329534', '504329535', '504329536'].includes(way.id),
    );
    for (const point of connector.coordinates.slice(1, -1)) {
      const westDistance = distanceToWay(point, westbound, osm.nodes);
      const eastDistance = Math.min(
        ...eastbound.map((way) => distanceToWay(point, way, osm.nodes)),
      );
      assert.ok(
        Math.abs(westDistance - eastDistance) < 8,
        'the connection follows the midpoint between the two through carriageways',
      );
    }
    for (let index = 1; index < connector.coordinates.length; index += 1) {
      const previous = connector.coordinates[index - 1];
      const point = connector.coordinates[index];
      assert.ok(point[0] < previous[0], 'the connection progresses westward');
      assert.ok(geodesicDistanceMeters(previous, point) < 55);
    }
    for (const [index, point] of [
      [connector.startMainlinePartIndex, connector.coordinates[0]],
      [connector.endMainlinePartIndex, connector.coordinates.at(-1)],
    ]) {
      assert.ok(
        built.parts[index].coordinates.some(
          (coordinate) => geodesicDistanceMeters(coordinate, point) < 0.25,
        ),
      );
    }
    const graph = buildPairedOsmSourceTopologyGraph(osm, built.parts);
    const partIndex = graph.parts.findIndex((part) => part.id === connector.id);
    const degrees = new Map();
    for (const edge of graph.edges.filter((edge) => edge.partIndices.has(partIndex))) {
      for (const id of [edge.fromId, edge.toId])
        degrees.set(id, (degrees.get(id) ?? 0) + 1);
    }
    const ends = [...degrees].filter(([, degree]) => degree === 1).map(([id]) => id);
    assert.equal(ends.length, 2);
    for (const id of ends)
      assert.ok(
        graph.edges.some(
          (edge) =>
            (edge.fromId === id || edge.toId === id) &&
            [...edge.partIndices].some(
              (index) => graph.parts[index].role === 'mainline',
            ),
        ),
        'both ends connect in the routing graph',
      );
  }
});

test('a through connection requires a continuous opposite source road', () => {
  const osm = fixture();
  const way = osm.ways.find((way) => way.id === '504329535');
  osm.nodes.set('disconnected-copy', structuredClone(osm.nodes.get(way.nodeIds[0])));
  way.nodeIds[0] = 'disconnected-copy';
  assert.equal(buildOsmHighwayCenterlines(osm).statistics.directConnectorCount, 0);
});

test('a through connection cannot invent a missing direction', () => {
  const osm = fixture();
  osm.ways = osm.ways.filter((way) => way.id !== '504329517');
  assert.equal(buildOsmHighwayCenterlines(osm).statistics.directConnectorCount, 0);
});

test('a through connection cannot traverse a traffic signal', () => {
  const osm = fixture();
  osm.nodes.get('4945000376').tags.highway = 'traffic_signals';
  assert.equal(buildOsmHighwayCenterlines(osm).statistics.directConnectorCount, 0);
});

test('a through connection requires opposing travel directions', () => {
  const osm = fixture();
  for (const way of osm.ways)
    if (['504329534', '504329535'].includes(way.id)) way.tags.oneway = '-1';
  assert.equal(buildOsmHighwayCenterlines(osm).statistics.directConnectorCount, 0);
});

test('overlapping mainline terminals do not get another through connection', () => {
  const osm = fixture();
  const built = buildOsmHighwayCenterlines(osm);
  const connector = built.parts.find((part) => part.throughMainline);
  const mainlines = built.parts.filter((part) => part.role === 'mainline');
  const middle = connector.coordinates[Math.floor(connector.coordinates.length / 2)];
  // Model source junctions that already extend both mainlines across the gap.
  // Preserve the original terminal coordinates, so proximity alone still passes.
  mainlines[connector.startMainlinePartIndex].coordinates.splice(-1, 0, middle);
  mainlines[connector.endMainlinePartIndex].coordinates.splice(1, 0, middle);
  const prepared = prepareWays(osm);
  const ramps = buildRampConnectors(
    osm,
    prepared.mainlines,
    mainlines,
    prepared.connectors,
  );
  assert.equal(ramps.statistics.directConnectorCount, 0);
});

test('a one-lane branch can merge into a continuing mainline through its actual opposite carriageway', () => {
  const data = JSON.parse(
    readFileSync(
      new URL('./fixtures/phoenix-continuing-mainline-merge.json', import.meta.url),
    ),
  );
  const osm = { nodes: new Map(data.nodes), ways: data.ways };
  const prepared = prepareWays(osm);
  const parts = structuredClone(data.parts);
  const ramps = buildRampConnectors(
    osm,
    prepared.mainlines,
    parts,
    prepared.connectors,
  );
  assert.equal(ramps.connectors.length, 1);
  const connector = ramps.connectors[0];
  assert.ok(connector.sourceWayIds.includes('404631326'));
  assert.ok(connector.sourceWayIds.includes('30024248'));
  assert.equal(parts[connector.startMainlinePartIndex].id, 'osm-mainline-877');
  assert.equal(parts[connector.endMainlinePartIndex].id, 'osm-mainline-1214');
  assert.equal(hasProperSelfIntersection(connector.coordinates), false);
  for (let index = 1; index < connector.coordinates.length; index += 1)
    assert.ok(
      connector.coordinates[index][1] < connector.coordinates[index - 1][1],
      'the restored merge advances smoothly southward',
    );
  const withoutReturn = {
    ...osm,
    ways: osm.ways.filter((way) => way.id !== '30024248'),
  };
  const unpaired = prepareWays(withoutReturn);
  assert.equal(
    buildRampConnectors(
      withoutReturn,
      unpaired.mainlines,
      structuredClone(data.parts),
      unpaired.connectors,
    ).connectors.length,
    0,
    'geographic proximity cannot replace the missing opposite source road',
  );
});
