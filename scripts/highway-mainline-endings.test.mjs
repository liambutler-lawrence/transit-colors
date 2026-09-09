import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildMainlineEndingIndex,
  trimRampOnlyMainlineTails,
} from './highway-mainline-endings.mjs';
import {
  buildOsmHighwayCenterlines,
  buildPairedOsmSourceTopologyGraph,
} from './osm-highway-network.mjs';
import { geodesicDistanceMeters } from './wgs84-geodesy.mjs';

function terminalInterchange(reverse = false) {
  const coordinates = [0, 1, 2, 3, 4].map((x) => [x / 1_000, 0]);
  const part = {
    id: 'trunk',
    role: 'mainline',
    sourceChainId: 'outbound',
    pairedChainId: 'inbound',
    coordinates,
    startTopologyKeys: ['osm-node:a', 'osm-node:b'],
    endTopologyKeys: [],
    topologyCoordinates: [
      { coordinate: coordinates[2], key: 'east-ramp' },
      { coordinate: coordinates[3], key: 'west-ramp' },
    ],
  };
  const connectors = ['east', 'west'].map((id, index) => ({
    id,
    role: 'connector',
    sourceWayIds: [`${id}-link`],
    startMainlinePartIndex: 0,
    endMainlinePartIndex: 1,
    coordinates: [coordinates[index + 2], [0.005, 0.001 * (index * 2 - 1)]],
  }));
  const chains = [
    { id: 'outbound', startNodeId: 'a', endNodeId: 'c' },
    { id: 'inbound', startNodeId: 'd', endNodeId: 'b' },
  ];
  const mainlines = [
    { id: 'outbound', nodeIds: ['a', 'c'] },
    { id: 'inbound', nodeIds: ['d', 'b'] },
  ];
  const links = [
    { id: 'east-link', nodeIds: ['a', 'east'], tags: { highway: 'motorway_link' } },
    { id: 'west-link', nodeIds: ['west', 'b'], tags: { highway: 'motorway_link' } },
  ];
  if (reverse) {
    part.coordinates = coordinates.toReversed();
    [part.startTopologyKeys, part.endTopologyKeys] = [
      part.endTopologyKeys,
      part.startTopologyKeys,
    ];
  }
  return { parts: [part], connectors, chains, mainlines, links };
}

function audit(fixture) {
  return trimRampOnlyMainlineTails(
    fixture.parts,
    fixture.connectors,
    buildMainlineEndingIndex(fixture.chains, fixture.mainlines, fixture.links),
  );
}

test('ramp-only terminal pavement stops at the outermost existing attachment in either orientation', () => {
  for (const reverse of [false, true]) {
    const fixture = terminalInterchange(reverse);
    const original = structuredClone(fixture);
    const result = audit(fixture);
    assert.equal(result.statistics.trimmedRampOnlyTailCount, 1);
    assert.deepEqual(
      fixture.parts[0].coordinates,
      reverse
        ? original.parts[0].coordinates.slice(0, 3)
        : original.parts[0].coordinates.slice(2),
    );
    assert.deepEqual(fixture.connectors, original.connectors);
    assert.deepEqual(
      fixture.parts[0][reverse ? 'endTopologyKeys' : 'startTopologyKeys'],
      ['east-ramp'],
    );
    assert.equal(audit(fixture).statistics.trimmedRampOnlyTailCount, 0);
  }
});

test('a reciprocal movement using both terminal roadways retains its common trunk', () => {
  const fixture = terminalInterchange();
  fixture.connectors[0].sourceWayIds.push('west-link');
  const original = structuredClone(fixture.parts);
  assert.equal(audit(fixture).statistics.trimmedRampOnlyTailCount, 0);
  assert.deepEqual(fixture.parts, original);
});

test('unrepresented exits and non-ramp continuations prevent terminal trimming', () => {
  for (const kind of ['unpaired', 'motorway', 'through', 'split-way']) {
    const fixture = terminalInterchange();
    if (kind === 'unpaired') {
      fixture.links.push({
        id: 'extra',
        nodeIds: ['a', 'extra'],
        tags: { highway: 'motorway_link' },
      });
    } else if (kind === 'motorway') {
      fixture.links[0].tags.highway = 'motorway';
    } else if (kind === 'through') {
      fixture.mainlines[0].nodeIds.unshift('upstream');
    } else {
      fixture.mainlines.push({ id: 'continuation', nodeIds: ['upstream', 'a'] });
    }
    const original = structuredClone(fixture.parts);
    assert.equal(audit(fixture).statistics.trimmedRampOnlyTailCount, 0, kind);
    assert.deepEqual(fixture.parts, original, kind);
  }
});

test('shared terminal topology and intermediate mainline junctions remain connected', () => {
  for (const terminal of [false, true]) {
    const fixture = terminalInterchange();
    if (terminal) {
      fixture.parts.push({
        id: 'other',
        role: 'mainline',
        coordinates: [[-0.001, 0], fixture.parts[0].coordinates[0]],
        endTopologyKeys: ['osm-node:a'],
      });
    } else {
      fixture.parts[0].topologyCoordinates.push({
        coordinate: fixture.parts[0].coordinates[1],
        key: 'other-mainline',
      });
    }
    const original = structuredClone(fixture.parts);
    assert.equal(audit(fixture).statistics.trimmedRampOnlyTailCount, 0);
    assert.deepEqual(fixture.parts, original);
  }
});

test('Morelia removes the redundant parallel mainline tail and retains both reciprocal ramp routes', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('./fixtures/morelia-interchange.json', import.meta.url),
      'utf8',
    ),
  );
  const osm = { nodes: new Map(fixture.nodes), ways: fixture.ways };
  const result = buildOsmHighwayCenterlines(osm);
  const branch = result.parts.find(
    (part) => part.role === 'mainline' && part.sourceWayIds.includes('737125246'),
  );
  assert.equal(result.statistics.trimmedRampOnlyTailCount, 1);
  assert.ok(result.statistics.trimmedRampOnlyTailMeters > 440);
  assert.ok(result.statistics.trimmedRampOnlyTailMeters < 447);
  assert.ok(
    geodesicDistanceMeters(branch.coordinates[0], [-101.2073167, 19.8784307]) < 1,
  );
  assert.ok(
    branch.coordinates.every(
      (point) => geodesicDistanceMeters(point, [-101.2044415, 19.8812978]) > 430,
    ),
  );
  const connectors = result.parts.filter((part) => part.role === 'connector');
  assert.equal(connectors.length, 2);
  for (const connector of connectors) {
    for (const [index, coordinate] of [
      [connector.startMainlinePartIndex, connector.coordinates[0]],
      [connector.endMainlinePartIndex, connector.coordinates.at(-1)],
    ]) {
      assert.ok(
        result.parts[index].coordinates.some(
          (point) => point.join() === coordinate.join(),
        ),
      );
    }
  }
  const graph = buildPairedOsmSourceTopologyGraph(osm, result.parts);
  assert.equal(graph.statistics.sourceConnectorPartCount, 2);
  assert.equal(graph.statistics.explicitTopologyKeyCount, 4);
});
