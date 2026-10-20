import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  sourceExtension,
  sourceMidpointAttachment,
} from './highway-source-correspondence.mjs';
import {
  buildOsmHighwayCenterlines,
  buildMidpointTopologyGraph,
} from './osm-highway-network.mjs';
import { highwayTurnAllowed } from './highway-turns.mjs';

test('attachments use the saved source position even when another midpoint point is closer', () => {
  const coordinates = [
    [0, 0],
    [0.003, 0],
    [0.004, 0],
  ];
  const chain = {
    id: 'a',
    nodeIds: ['start', 'split', 'end'],
    coordinates: [
      [0, 0.001],
      [0.001, 0.001],
      [0.004, 0.001],
    ],
  };
  const part = {
    coordinates,
    sourceCorrespondence: {
      coordinates,
      sides: [{ chainId: 'a', positions: [0, 1, 2] }],
    },
  };
  const attachment = sourceMidpointAttachment(part, 'split', new Map([['a', chain]]));
  assert.deepEqual(attachment.coordinate, [0.003, 0]);
  assert.deepEqual(attachment.sourceTargets, [{ chainId: 'a', position: 1 }]);
  assert.equal(
    sourceMidpointAttachment(part, 'unrelated', new Map([['a', chain]])),
    null,
  );
});

test('source extensions end at the paired source boundary, ignoring a farther midpoint attachment', () => {
  const chain = {
    id: 'a',
    nodeIds: ['merge', 'middle', 'later', 'farther'],
    coordinates: [
      [0, 0],
      [0.001, 0],
      [0.002, 0],
      [0.003, 0],
    ],
  };
  const chains = new Map([['a', chain]]);
  const target = {
    coordinate: [0.003, 0.001],
    sourceTargets: [{ chainId: 'a', position: 1.5 }],
  };
  assert.deepEqual(sourceExtension({ nodeId: 'merge' }, target, chains, false), [
    [0, 0],
    [0.001, 0],
    [0.0015, 0],
  ]);
  assert.deepEqual(sourceExtension({ nodeId: 'farther' }, target, chains, false), [
    [0.003, 0],
  ]);
  assert.deepEqual(sourceExtension({ nodeId: 'farther' }, target, chains, true), [
    [0.003, 0],
    [0.002, 0],
    [0.0015, 0],
  ]);
});

test('I-275 ramp pairs end at the actual split, leaving one mainline and preserving legal turns', () => {
  const fixture = JSON.parse(
    fs.readFileSync(new URL('./fixtures/i275-source-merge.json', import.meta.url)),
  );
  for (const ways of [fixture.ways, fixture.ways.toReversed()]) {
    const built = buildOsmHighwayCenterlines({ nodes: new Map(fixture.nodes), ways });
    const ramps = built.parts.filter((p) => p.role === 'connector');
    assert.equal(ramps.length, 2);
    const westernEndpoints = ramps.map((p) =>
      p.coordinates.reduce((a, b) => (a[0] < b[0] ? a : b)),
    );
    assert.deepEqual(westernEndpoints[0], westernEndpoints[1]);
    // The western source split is at -82.5288571. The old connector continued
    // another ~140 m west and crossed its independent copy twelve times.
    for (const ramp of ramps)
      assert.ok(
        ramp.coordinates.every((p) => p[0] >= -82.5288571 - 2 / 98300),
        'no mainline tail beyond the source split',
      );
    const graph = buildMidpointTopologyGraph(built.parts);
    const node = [...graph.coordinateByNodeId].find(
      ([, coordinate]) => coordinate.join() === westernEndpoints[0].join(),
    )?.[0];
    assert.ok(node);
    const incident = graph.edges.filter((e) => e.fromId === node || e.toId === node);
    assert.equal(incident.length, 3, 'one trunk and two ramp movements');
    const mainline = incident.find((e) =>
      [...e.partIndices].some((i) => graph.parts[i].role === 'mainline'),
    );
    const rampEdges = incident.filter((e) => e !== mainline);
    assert.ok(mainline);
    assert.ok(rampEdges.every((e) => highwayTurnAllowed(e, mainline, node)));
    assert.equal(
      highwayTurnAllowed(...rampEdges, node),
      false,
      'ramp-to-ramp reversal remains forbidden',
    );
  }
});
