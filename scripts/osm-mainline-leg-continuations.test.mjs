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
