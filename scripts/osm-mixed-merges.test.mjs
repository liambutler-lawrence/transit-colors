import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildOsmHighwayCenterlines,
  buildPairedOsmSourceTopologyGraph,
  classifyOsmMotorwayWay,
} from './osm-highway-network.mjs';
import { geodesicDistanceMeters } from './wgs84-geodesy.mjs';
import { hasProperSelfIntersection } from './highway-cycle.mjs';

function fixture(name) {
  const data = JSON.parse(
    readFileSync(new URL(`./fixtures/${name}-mixed-merge.json`, import.meta.url)),
  );
  return {
    nodes: new Map(data.nodes),
    ways: data.ways,
    connectorWayIds: data.connectorWayIds,
  };
}

for (const name of ['downtown-savannah', 'airport']) {
  test(`${name} retains the merge when only one direction becomes a single-lane ramp`, () => {
    for (const reversed of [false, true]) {
      const osm = fixture(name);
      if (reversed) osm.ways.reverse();
      const built = buildOsmHighwayCenterlines(osm);
      const mixed = built.parts.filter((part) => part.mixedMainline);
      assert.equal(mixed.length, 1);
      const connector = mixed[0];
      for (const id of osm.connectorWayIds)
        assert.ok(connector.sourceWayIds.includes(id));
      assert.equal(connector.pairedDirectionCount, 2);
      assert.equal(hasProperSelfIntersection(connector.coordinates), false);
      for (let i = 1; i < connector.coordinates.length - 1; i += 1) {
        const [a, b, c] = connector.coordinates.slice(i - 1, i + 2);
        const scale = Math.cos((b[1] * Math.PI) / 180);
        const u = [(b[0] - a[0]) * scale, b[1] - a[1]],
          v = [(c[0] - b[0]) * scale, c[1] - b[1]];
        assert.ok(
          u[0] * v[0] + u[1] * v[1] > 0,
          'the midpoint must not turn back on itself',
        );
        assert.ok(
          geodesicDistanceMeters(a, b) < 100,
          'the curve follows sampled source pavement',
        );
      }
      for (const [index, point] of [
        [connector.startMainlinePartIndex, connector.coordinates[0]],
        [connector.endMainlinePartIndex, connector.coordinates.at(-1)],
      ]) {
        assert.ok(
          built.parts[index].coordinates.some(
            (p) => geodesicDistanceMeters(p, point) < 0.25,
          ),
        );
      }
      const graph = buildPairedOsmSourceTopologyGraph(osm, built.parts);
      const partIndex = graph.parts.findIndex((p) => p.id === connector.id);
      const degrees = new Map();
      for (const edge of graph.edges.filter((e) => e.partIndices.has(partIndex))) {
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
          'both restored ends are connected in the routing graph',
        );
    }
  });
}

test('a mixed merge needs the actual opposite source junction, not a coordinate crossing', () => {
  const osm = fixture('airport');
  const split = osm.ways.find((w) => w.id === '562357986');
  const id = split.nodeIds[0];
  osm.nodes.set('disconnected-copy', structuredClone(osm.nodes.get(id)));
  split.nodeIds[0] = 'disconnected-copy';
  assert.equal(
    buildOsmHighwayCenterlines(osm).statistics.mixedMainlineConnectorCount,
    0,
  );
});

test('a mixed merge does not invent the missing directional road', () => {
  const osm = fixture('airport');
  osm.ways = osm.ways.filter((w) => !osm.connectorWayIds.includes(w.id));
  assert.equal(
    buildOsmHighwayCenterlines(osm).statistics.mixedMainlineConnectorCount,
    0,
  );
});

test('a mixed merge cannot traverse a traffic signal', () => {
  const osm = fixture('airport');
  osm.nodes.get('5421546228').tags.highway = 'traffic_signals';
  assert.equal(
    buildOsmHighwayCenterlines(osm).statistics.mixedMainlineConnectorCount,
    0,
  );
});

test('mixed merges retain the shortest reciprocal movement when a ramp has two arrivals', () => {
  for (const reversed of [false, true]) {
    const osm = fixture('alternatives');
    // Keep the established mainline network fixed while reversing the ramp
    // alternatives. The selection must not depend on their input order.
    if (reversed) {
      const links = osm.ways.filter(
        (way) => classifyOsmMotorwayWay(way) === 'connector',
      );
      osm.ways = osm.ways
        .filter((way) => classifyOsmMotorwayWay(way) !== 'connector')
        .concat(links.reverse());
    }
    const built = buildOsmHighwayCenterlines(osm);
    const mixed = built.parts.filter((part) => part.mixedMainline);
    assert.equal(mixed.length, 1);
    assert.ok(mixed[0].sourceWayIds.includes('932630715'), 'use the early arrival');
    assert.ok(
      !mixed[0].sourceWayIds.includes('932630713'),
      'omit the longer parallel alternative',
    );
    assert.equal(built.statistics.alternativeConnectorPathCount, 2);
    assert.equal(built.statistics.unpairedConnectorPathCount, 0);
  }
});
