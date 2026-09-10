import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { hasProperSelfIntersection } from './highway-cycle.mjs';
import { geodesicDistanceMeters } from './wgs84-geodesy.mjs';
import {
  buildOsmHighwayCenterlines,
  buildPairedOsmSourceTopologyGraph,
  buildRampConnectors,
} from './osm-highway-network.mjs';

test('Savannah retains all four reciprocal movements including the southeast auxiliary exit', () => {
  const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/savannah-interchange.json', import.meta.url)),
  );
  const identity = (part) => part.sourceWayIds.toSorted().join(':');
  for (const ways of [fixture.ways, fixture.ways.toReversed()]) {
    const osm = { nodes: new Map(fixture.nodes), ways };
    const built = buildOsmHighwayCenterlines(osm);
    const connectors = built.parts.filter((part) => part.role === 'connector');
    assert.equal(connectors.length, 4);
    assert.equal(built.statistics.directedConnectorPathCount, 8);
    assert.equal(built.statistics.unpairedConnectorPathCount, 0);
    const southeast = connectors.find(
      (part) =>
        part.sourceWayIds.includes('9080553') && part.sourceWayIds.includes('9080294'),
    );
    assert.ok(southeast);
    assert.ok(southeast.sourceWayIds.includes('9080294'));
    for (let index = 1; index < southeast.coordinates.length - 1; index += 1) {
      const [before, point, after] = southeast.coordinates.slice(index - 1, index + 2);
      const scale = Math.cos((point[1] * Math.PI) / 180);
      const incoming = [(point[0] - before[0]) * scale, point[1] - before[1]];
      const outgoing = [(after[0] - point[0]) * scale, after[1] - point[1]];
      const alignment =
        incoming.reduce((sum, value, axis) => sum + value * outgoing[axis], 0) /
        (Math.hypot(...incoming) * Math.hypot(...outgoing));
      assert.ok(
        alignment > 0.75,
        'the southeast midpoint must advance smoothly through the source bend',
      );
      assert.ok(geodesicDistanceMeters(before, point) < 35);
    }
    const leg = ([longitude, latitude]) =>
      longitude < -81.25
        ? 'W'
        : latitude < 32.07
          ? 'S'
          : longitude > -81.24
            ? 'E'
            : 'N';
    assert.deepEqual(
      new Set(
        connectors.map((part) =>
          [leg(part.coordinates[0]), leg(part.coordinates.at(-1))].sort().join(':'),
        ),
      ),
      new Set(['E:S', 'E:N', 'N:W', 'S:W']),
    );
    for (const expected of ways === fixture.ways
      ? fixture.existingConnectors
      : fixture.existingConnectorsReversed) {
      assert.deepEqual(
        connectors.find((part) => identity(part) === identity(expected))?.coordinates,
        expected.coordinates,
      );
    }
    for (const part of connectors) {
      assert.equal(hasProperSelfIntersection(part.coordinates), false);
      for (const [partIndex, coordinate] of [
        [part.startMainlinePartIndex, part.coordinates[0]],
        [part.endMainlinePartIndex, part.coordinates.at(-1)],
      ]) {
        assert.ok(
          built.parts[partIndex].coordinates.some(
            // The existing projection insertion coalesces vertices within 25 cm.
            (point) => geodesicDistanceMeters(point, coordinate) <= 0.25,
          ),
        );
      }
    }
    if (ways === fixture.ways) {
      const repair = built.rampAttachmentRepairs.find(
        (entry) => entry.nodeId === '67036679',
      );
      assert.equal(repair.kind, 'auxiliary-carriageway');
      assert.ok(repair.distanceMeters < 30);
    }
    const graph = buildPairedOsmSourceTopologyGraph(osm, built.parts);
    assert.equal(graph.statistics.sourceConnectorPartCount, 4);
    assert.equal(graph.statistics.explicitTopologyKeyCount, 8);
    const graphPartIndex = graph.parts.findIndex((part) => part.id === southeast.id);
    const rampEdges = graph.edges.filter((edge) =>
      edge.partIndices.has(graphPartIndex),
    );
    const degrees = new Map();
    for (const edge of rampEdges) {
      for (const nodeId of [edge.fromId, edge.toId])
        degrees.set(nodeId, (degrees.get(nodeId) ?? 0) + 1);
    }
    const ends = [...degrees]
      .filter(([, degree]) => degree === 1)
      .map(([nodeId]) => nodeId);
    assert.equal(ends.length, 2);
    for (const nodeId of ends)
      assert.ok(
        graph.edges.some(
          (edge) =>
            (edge.fromId === nodeId || edge.toId === nodeId) &&
            [...edge.partIndices].some(
              (index) => graph.parts[index].role === 'mainline',
            ),
        ),
        'the restored ramp must join the mainline graph at both ends',
      );
  }
});

function auxiliaryFixture() {
  const coordinates = {
    a: [0, 0],
    p: [0.002, 0],
    q: [0.004, 0.0003],
    r: [0.008, 0],
    d: [0.01, 0],
    e: [0.01, -0.0004],
    back: [0.002, -0.0004],
    f: [0, -0.0004],
    b: [0, 0.004],
    target: [0.006, 0.004],
    c: [0.01, 0.004],
    h: [0.01, 0.0044],
    reverse: [0.006, 0.0044],
    i: [0, 0.0044],
    turn: [0.005, 0.002],
    return: [0.004, 0.0025],
  };
  const nodes = new Map(
    Object.entries(coordinates).map(([id, coordinate]) => [
      id,
      { coordinate, tags: {} },
    ]),
  );
  const mainlines = [
    { id: 'A', nodeIds: ['a', 'p', 'r', 'd'] },
    { id: 'A-back', nodeIds: ['e', 'back', 'f'] },
    { id: 'auxiliary', nodeIds: ['p', 'q', 'r'] },
    { id: 'B', nodeIds: ['b', 'target', 'c'] },
    { id: 'B-back', nodeIds: ['h', 'reverse', 'i'] },
  ];
  const parts = [
    {
      id: 'a',
      role: 'mainline',
      sourceWayIds: ['A', 'A-back'],
      tokens: ['A'],
      coordinates: [
        [0, -0.0002],
        [0.01, -0.0002],
      ],
    },
    {
      id: 'b',
      role: 'mainline',
      sourceWayIds: ['B', 'B-back'],
      tokens: ['B'],
      coordinates: [
        [0, 0.0042],
        [0.01, 0.0042],
      ],
    },
  ];
  const links = [
    { id: 'exit', nodeIds: ['q', 'turn', 'target'] },
    { id: 'entry', nodeIds: ['reverse', 'return', 'back'] },
  ];
  return { nodes, mainlines, parts, links };
}

function build(fixture) {
  return buildRampConnectors(
    { nodes: fixture.nodes },
    fixture.mainlines,
    fixture.parts,
    fixture.links,
  );
}

test('an auxiliary carriageway attached to the same source corridor at both ends supplies a reciprocal ramp', () => {
  const result = build(auxiliaryFixture());
  assert.equal(result.connectors.length, 1);
  assert.deepEqual(
    new Set(result.connectors[0].sourceWayIds),
    new Set(['exit', 'entry']),
  );
  assert.equal(result.attachmentRepairs.length, 1);
  assert.equal(result.attachmentRepairs[0].nodeId, 'q');
});

test('auxiliary attachments require bounded, unambiguous source continuity in both directions', () => {
  for (const kind of [
    'dead-end',
    'different-corridor',
    'coordinate-crossing',
    'long-detour',
    'closed-branch',
    'too-far',
  ]) {
    const fixture = auxiliaryFixture();
    if (kind === 'dead-end') fixture.mainlines[2].nodeIds = ['p', 'q'];
    if (kind === 'different-corridor')
      fixture.mainlines[2].nodeIds = ['p', 'q', 'target'];
    if (kind === 'coordinate-crossing') {
      fixture.nodes.set('r-copy', structuredClone(fixture.nodes.get('r')));
      fixture.mainlines[2].nodeIds = ['p', 'q', 'r-copy'];
    }
    if (kind === 'long-detour') {
      fixture.nodes.set('detour', { coordinate: [0.04, 0], tags: {} });
      fixture.mainlines[2].nodeIds = ['p', 'q', 'detour', 'r'];
    }
    if (kind === 'closed-branch') {
      fixture.nodes.set('loop', { coordinate: [0.004, 0.0005], tags: {} });
      fixture.nodes.set('loop-2', { coordinate: [0.0042, 0.0005], tags: {} });
      fixture.mainlines.push({ id: 'loop', nodeIds: ['q', 'loop', 'loop-2', 'loop'] });
    }
    if (kind === 'too-far') fixture.nodes.get('q').coordinate = [0.004, 0.002];
    const result = build(fixture);
    assert.equal(result.attachmentRepairs.length, 0, kind);
    assert.equal(result.connectors.length, 0, kind);
  }
});

test('near direct attachments retain their source part even if a related part is closer', () => {
  const fixture = auxiliaryFixture();
  fixture.parts[0].sourceWayIds.push('auxiliary');
  fixture.parts.push({
    ...structuredClone(fixture.parts[0]),
    id: 'closer',
    coordinates: [
      [0, 0.0003],
      [0.01, 0.0003],
    ],
  });
  // Only the established part maps the auxiliary way directly; the candidate
  // shares the parent source corridor but must not replace a valid attachment.
  fixture.parts[2].sourceWayIds = ['A'];
  const result = build(fixture);
  assert.equal(result.attachmentRepairs.length, 0);
  assert.equal(result.connectors.length, 1);
  assert.equal(result.connectors[0].startMainlinePartIndex, 0);
});

test('a distant source-way projection can use the nearby part of the same source corridor', () => {
  const fixture = auxiliaryFixture();
  fixture.parts.push({
    ...structuredClone(fixture.parts[0]),
    id: 'distant',
    sourceWayIds: ['auxiliary', 'A-back'],
    coordinates: [
      [0.026, -0.0002],
      [0.03, -0.0002],
    ],
  });
  const result = build(fixture);
  assert.equal(result.connectors.length, 1);
  assert.equal(result.connectors[0].startMainlinePartIndex, 0);
  assert.equal(result.attachmentRepairs.length, 1);
  assert.equal(result.attachmentRepairs[0].kind, 'shared-source-corridor');
  assert.ok(result.attachmentRepairs[0].previousDistanceMeters > 1_000);
  assert.ok(result.attachmentRepairs[0].distanceMeters < 60);
});

test('newly inferred ramp pairs cannot introduce a backward midpoint or a crossing', () => {
  const fixture = auxiliaryFixture();
  fixture.nodes.get('turn').coordinate = [-0.01, -0.01];
  fixture.nodes.get('return').coordinate = [0.009, 0.001];
  const result = build(fixture);
  assert.equal(result.connectors.length, 0);
  assert.equal(result.statistics.rejectedInferredConnectorCount, 1);
});
