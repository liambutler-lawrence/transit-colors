import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  findReciprocalMainlineContinuations,
  outerReciprocalAttachment,
} from './osm-highway-network.mjs';

const { cases } = JSON.parse(
  readFileSync(
    new URL('./fixtures/reciprocal-mainline-continuations.json', import.meta.url),
  ),
);

// Keep the canonical display intervals and traced directional paths. Cropping
// and re-pairing a regional network changes its chain identities and can hide
// the split-segment matching failure these examples reproduce.

function context(data) {
  return {
    osm: { nodes: new Map(data.nodes), ways: data.ways },
    parts: data.parts,
    chains: data.chains,
    paths: data.paths,
    establishedPairs: [],
  };
}

test('reciprocal ramps remain paired when one highway leg spans multiple centerline parts', () => {
  assert.equal(cases.length, 4);
  for (const data of cases) {
    for (const paths of [data.paths, data.paths.toReversed()]) {
      const pairs = findReciprocalMainlineContinuations({ ...context(data), paths });
      assert.equal(pairs.length, 1, data.name);
      assert.ok(pairs[0].some((path) => path.sourceWayIds.includes(data.requiredWay)));
      assert.deepEqual(
        pairs[0].map((path) => path.nodeIds.join()).sort(),
        data.paths.map((path) => path.nodeIds.join()).sort(),
        'retain both real directional source paths',
      );
    }
  }
});

test('nearby mainline ends cannot replace missing source-road continuity', () => {
  for (const data of cases) {
    const input = context(data);
    input.osm = { ...input.osm, ways: [] };
    input.chains = [];
    assert.equal(findReciprocalMainlineContinuations(input).length, 0, data.name);
  }
  const cleveland = cases.find((data) => data.requiredWay === '1027305702');
  const disconnected = context(cleveland);
  disconnected.osm = { ...disconnected.osm, ways: [] };
  assert.equal(
    findReciprocalMainlineContinuations(disconnected).length,
    0,
    'retaining the source intervals cannot replace the missing road between them',
  );
});

test('continued mainline matching preserves existing reciprocal assignments and rejects the same travel side', () => {
  for (const data of cases) {
    assert.equal(
      findReciprocalMainlineContinuations({
        ...context(data),
        establishedPairs: [data.paths],
      }).length,
      0,
      'an established pair cannot be consumed twice',
    );
    const paths = structuredClone(data.paths);
    paths[0].firstAttachment.carriagewayIds = paths[1].secondAttachment.carriagewayIds;
    assert.equal(
      findReciprocalMainlineContinuations({ ...context(data), paths }).length,
      0,
      `${data.name}: a second ramp on the same carriageway is not a return direction`,
    );
  }
});

test('a ramp attachment on a junction vertex uses the continuing mainline tangent', () => {
  const toronto = cases.find((data) => data.requiredWay === '3992897');
  const [forward, reverse] = toronto.paths;
  assert.equal(
    outerReciprocalAttachment(
      forward.secondAttachment,
      reverse.firstAttachment,
      toronto.parts,
      false,
    ),
    reverse.firstAttachment,
    'the 401-to-404 pair must extend north to the farther reciprocal split',
  );
  assert.equal(
    outerReciprocalAttachment(
      reverse.firstAttachment,
      forward.secondAttachment,
      toronto.parts,
      true,
    ),
    reverse.firstAttachment,
    'reversing the pair retains the same outer mainline attachment',
  );
});

test('the same two carriageways can support staggered joins across a longer split, with actual road continuity', () => {
  const nodes = new Map();
  const way = (id, xs, y) => ({
    id,
    tags: { highway: 'motorway', oneway: 'yes', lanes: '2' },
    nodeIds: xs.map((x, i) => {
      const key = `${id}-${i}`;
      nodes.set(key, { coordinate: [x, y], tags: {} });
      return key;
    }),
  });
  const ways = [
    way('a', [0, 0.008, 0.01, 0.012, 0.016, 0.02], 0.0002),
    way('back', [0.02, 0.016, 0.012, 0.01, 0.008, 0], -0.0002),
  ];
  const chains = ways.map((w) => ({
    ...w,
    sourceWayIds: [w.id],
    coordinates: w.nodeIds.map((id) => nodes.get(id).coordinate),
  }));
  const part = (id, coordinates, ranges) => ({
    id,
    role: 'mainline',
    coordinates,
    sourceWayIds: ['a', 'back'],
    sourceChainId: 'a',
    pairedChainId: 'back',
    sourceRanges: ranges.map(([chainId, positions]) => ({ chainId, positions })),
  });
  const parts = [
    part(
      'left',
      [
        [0, 0],
        [0.01, 0],
      ],
      [
        ['a', [0, 1, 2]],
        ['back', [3, 4, 5]],
      ],
    ),
    part(
      'right',
      [
        [0.012, 0],
        [0.02, 0],
      ],
      [
        ['a', [3, 4, 5]],
        ['back', [0, 1, 2]],
      ],
    ),
    {
      id: 'target',
      role: 'mainline',
      coordinates: [
        [0, 0.01],
        [0.02, 0.01],
      ],
      sourceWayIds: ['target'],
    },
  ];
  const attachment = (
    nodeId,
    partIndex,
    coordinate,
    direction,
    carriagewayIds = [],
  ) => ({
    nodeId,
    partIndex,
    coordinate,
    travelDirections: [direction],
    carriagewayIds,
  });
  const paths = [
    {
      firstAttachment: attachment('a-1', 0, [0.008, 0], [1, 0], ['a']),
      secondAttachment: attachment('target-east', 2, [0.008, 0.01], [1, 0]),
      nodeIds: ['a-1', 'target-east'],
      edgeIndices: [0],
      sourceWayIds: ['exit'],
      distanceMeters: 1200,
    },
    {
      firstAttachment: attachment('target-west', 2, [0.016, 0.01], [-1, 0]),
      secondAttachment: attachment('back-1', 1, [0.016, 0], [-1, 0], ['back']),
      nodeIds: ['target-west', 'back-1'],
      edgeIndices: [1],
      sourceWayIds: ['entry'],
      distanceMeters: 1200,
    },
  ];
  const input = {
    osm: { nodes, ways },
    mainlineWays: ways,
    parts,
    chains,
    paths,
    establishedPairs: [],
  };
  assert.equal(findReciprocalMainlineContinuations(input).length, 1);
  assert.equal(
    findReciprocalMainlineContinuations({ ...input, mainlineWays: [] }).length,
    0,
    'matching chain ids cannot replace the actual road between the joins',
  );
});
