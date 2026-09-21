import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  recoverTerminalContinuations,
  pruneUnusableTerminalContinuations,
} from './highway-terminal-continuations.mjs';
import {
  averageReciprocalPathCoordinates,
  prepareWays,
} from './osm-highway-network.mjs';
import { hasProperSelfIntersection } from './highway-cycle.mjs';

const sites = [
  'richmond-i295-i95',
  'petersburg-i85-i95',
  'columbia-i26-i126',
  'atlanta-i675-i75',
];
function fixture(site) {
  const data = JSON.parse(
    readFileSync(new URL(`./fixtures/${site}-terminal.json`, import.meta.url), 'utf8'),
  );
  return { ...data, osm: { nodes: new Map(data.nodes) } };
}
function recover(data) {
  return recoverTerminalContinuations(
    data.osm,
    data.prepared,
    data.chains,
    data.parts,
    averageReciprocalPathCoordinates,
    new Set([data.branchIndex]),
  );
}
for (const site of sites) {
  test(`${site}: recover the source-connected mainline merge with explicit directional ports`, () => {
    const data = fixture(site),
      { additions, audit } = recover(data);
    assert.equal(additions.length, 1);
    const part = additions[0];
    assert.equal(part.startMainlinePartIndex, data.branchIndex);
    assert.equal(part.endMainlinePartIndex, data.targetIndex);
    assert.equal(part.role, site === 'richmond-i295-i95' ? 'connector' : 'mainline');
    assert.equal(part.explicitMainlineMerge, true);
    assert.ok([-1, 1].includes(part.startMainlineDirection));
    assert.ok([-1, 1].includes(part.endMainlineDirection));
    assert.ok(!hasProperSelfIntersection(part.coordinates));
    assert.deepEqual(
      part.coordinates[0],
      data.parts[data.branchIndex].coordinates.at(-1),
    );
    assert.ok(
      data.parts[data.targetIndex].coordinates.some(
        (p) => JSON.stringify(p) === JSON.stringify(part.coordinates.at(-1)),
      ),
    );
    for (const path of audit[0].paths) {
      assert.ok(path.segments.length > 0);
      for (const segment of path.segments) {
        const way = data.prepared[
          segment.role === 'mainline' ? 'mainlines' : 'connectors'
        ].find((w) => w.id === segment.wayId);
        assert.ok(way, `missing source way ${segment.wayId}`);
        assert.ok(
          way.nodeIds.some(
            (node, i) =>
              node === segment.from &&
              (way.nodeIds[i + 1] === segment.to || way.nodeIds[i - 1] === segment.to),
          ),
        );
      }
    }
  });
  test(`${site}: recovery is independent of the stored centerline orientation`, () => {
    const data = fixture(site);
    const branch = data.parts[data.branchIndex];
    branch.coordinates.reverse();
    branch.sourceRanges.reverse();
    const { additions } = recover(data);
    assert.equal(additions.length, 1);
    assert.equal(additions[0].startMainlineDirection, -1);
    assert.equal(additions[0].endMainlinePartIndex, data.targetIndex);
    assert.deepEqual(additions[0].coordinates[0], branch.coordinates[0]);
  });
  test(`${site}: a single carriageway cannot establish a two-way merge`, () => {
    const baseline = fixture(site),
      { audit } = recover(baseline);
    const data = fixture(site),
      removed = new Set(audit[0].paths[0].segments.map((s) => s.wayId));
    for (const role of ['mainlines', 'connectors'])
      data.prepared[role] = data.prepared[role].filter((w) => !removed.has(w.id));
    assert.equal(recover(data).additions.length, 0);
  });
}

test('signal-controlled roads are excluded while ramp meters remain eligible', () => {
  const site = sites[0];
  const baseline = fixture(site);
  const { audit } = recover(baseline);
  const nodeId = audit[0].paths[0].segments[0].from;
  const blocked = fixture(site);
  blocked.osm.nodes.get(nodeId).tags = { highway: 'traffic_signals' };
  assert.equal(recover(blocked).additions.length, 0);
  const metered = fixture(site);
  metered.osm.nodes.get(nodeId).tags = {
    highway: 'traffic_signals',
    traffic_signals: 'ramp_meter',
  };
  assert.equal(recover(metered).additions.length, 1);
});

test('ordinary ramps cannot bypass the reciprocal-ramp matcher', () => {
  const data = fixture(sites[0]);
  for (const way of data.prepared.connectors) way.mainlineTransition = false;
  assert.equal(recover(data).additions.length, 0);
});

test('sparse source nodes stop a merge at the fractional start of the receiving mainline', () => {
  const a = [
    [0, 0],
    [0.001, 0],
    [0.02, 0],
    [0.03, 0],
  ];
  const b = a.toReversed().map(([x, y]) => [x, y + 0.0001]);
  const chains = [a, b].map((coordinates, side) => ({
    id: `chain-${side}`,
    coordinates,
    nodeIds: coordinates.map((_, i) => `${side}:${i}`),
  }));
  const nodes = new Map(
    chains.flatMap((c) =>
      c.nodeIds.map((id, i) => [id, { coordinate: c.coordinates[i], tags: {} }]),
    ),
  );
  const mainlines = chains.map((c, i) => ({ id: `way-${i}`, nodeIds: c.nodeIds }));
  const parts = [
    {
      id: 'branch',
      role: 'mainline',
      coordinates: [
        [0, 0.00005],
        [0.00195, 0.00005],
      ],
      sourceWayIds: ['way-0', 'way-1'],
      sourceRanges: [
        { chainId: 'chain-0', positions: [0, 1.05] },
        { chainId: 'chain-1', positions: [1.95, 3] },
      ],
    },
    {
      id: 'receiver',
      role: 'mainline',
      coordinates: [
        [0.0029, 0.00005],
        [0.03, 0.00005],
      ],
      sourceWayIds: ['way-0', 'way-1'],
      sourceRanges: [
        { chainId: 'chain-0', positions: [1.1, 3] },
        { chainId: 'chain-1', positions: [0, 1.9] },
      ],
    },
  ];
  const { additions } = recoverTerminalContinuations(
    { nodes },
    { mainlines, connectors: [] },
    chains,
    parts,
    averageReciprocalPathCoordinates,
    new Set([0]),
  );
  assert.equal(additions.length, 1);
  assert.deepEqual(additions[0].coordinates.at(-1), [0.0029, 0.00005]);
  assert.deepEqual(additions[0].sourceWayIds, ['way-0', 'way-1']);
});

test('only ordinary motorway lane transitions are eligible outside the ramp matcher', () => {
  const nodes = new Map([
    ['a', { coordinate: [0, 0], tags: {} }],
    ['b', { coordinate: [0.01, 0], tags: {} }],
  ]);
  const ways = [
    { highway: 'motorway', lanes: '1' },
    { highway: 'motorway_link', lanes: '2' },
    { highway: 'motorway', lanes: '2', name: 'Express Lanes' },
  ].map((tags, i) => ({
    id: String(i),
    nodeIds: ['a', 'b'],
    tags: { ...tags, oneway: 'yes' },
  }));
  assert.deepEqual(
    prepareWays({ nodes, ways }).connectors.map((w) => w.mainlineTransition),
    [true, false, false],
  );
});

for (const usable of [true, false]) {
  test(`graph validation ${usable ? 'keeps a legal merge' : 'removes a merge with no legal onward leg'}`, () => {
    const parts = [
      { id: 'parent', role: 'mainline' },
      {
        id: 'merge',
        role: 'mainline',
        explicitMainlineMerge: true,
        coordinates: [
          [0, 0],
          [1, 0],
        ],
      },
    ];
    const graph = {
      parts: [...parts],
      edges: [
        {
          fromId: 'before',
          toId: 'start',
          partIndices: new Set([0]),
          toTurnPort: { mainlineId: 'parent', direction: -1 },
        },
        {
          fromId: 'start',
          toId: 'end',
          partIndices: new Set([1]),
          fromTurnPort: { mainlineId: 'parent', direction: 1 },
          toTurnPort: { mainlineId: 'receiver', direction: -1 },
        },
        {
          fromId: 'end',
          toId: 'after',
          partIndices: new Set([0]),
          fromTurnPort: { mainlineId: 'receiver', direction: usable ? 1 : -1 },
        },
      ],
      statistics: { explicitTopologyKeyCount: 2 },
    };
    assert.deepEqual(
      pruneUnusableTerminalContinuations(graph, parts),
      usable ? [] : ['merge'],
    );
    assert.equal(parts.length, usable ? 2 : 1);
    assert.equal(graph.edges.length, usable ? 3 : 2);
  });
}
