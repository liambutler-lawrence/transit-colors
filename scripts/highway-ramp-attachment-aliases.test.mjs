import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { rampAttachmentAliases } from './highway-ramp-attachment-aliases.mjs';
import { reciprocalPathPairs } from './osm-highway-network.mjs';

test('Des Moines reciprocal ramps survive a change of parent at their shared source seam', () => {
  const { parts, paths } = JSON.parse(
    readFileSync(new URL('./fixtures/des-moines-ramp-seam.json', import.meta.url)),
  );
  const groups = new Map(parts.map((_, i) => [i, 0]));
  const pairs = new Map();
  for (const p of parts)
    for (const [a, b] of [
      [p.sourceChainId, p.pairedChainId],
      [p.pairedChainId, p.sourceChainId],
    ]) {
      const set = pairs.get(a) ?? new Set();
      set.add(b);
      pairs.set(a, set);
    }
  assert.equal(reciprocalPathPairs(paths, groups, pairs).pairs.length, 0);
  const aliases = rampAttachmentAliases(parts);
  const annotated = paths.map((path) => ({
    ...path,
    ...Object.fromEntries(
      ['firstAttachment', 'secondAttachment'].map((key) => [
        key,
        {
          ...path[key],
          pairingPartIndices: aliases(path[key]).map((a) => a.partIndex),
        },
      ]),
    ),
  }));
  const result = reciprocalPathPairs(annotated, groups, pairs).pairs;
  assert.equal(result.length, 1);
  assert.deepEqual(
    result[0].map((p) => p.nodeIds).sort(),
    paths.map((p) => p.nodeIds).sort(),
  );
});

test('attachment aliases require both explicit identity and the same endpoint position', () => {
  const parts = [
    {
      coordinates: [
        [0, 0],
        [0.001, 0],
      ],
      startTopologyKeys: [],
      endTopologyKeys: ['seam'],
    },
    {
      coordinates: [
        [0.001, 0],
        [0.002, 0],
      ],
      startTopologyKeys: ['seam'],
      endTopologyKeys: [],
    },
    {
      coordinates: [
        [0.001, 0],
        [0.002, 0],
      ],
      startTopologyKeys: ['other-road'],
      endTopologyKeys: [],
    },
    {
      coordinates: [
        [0.004, 0],
        [0.005, 0],
      ],
      startTopologyKeys: ['seam'],
      endTopologyKeys: [],
    },
  ];
  const aliases = rampAttachmentAliases(parts);
  const results = aliases({
    partIndex: 0,
    coordinate: [0.001, 0],
    nodeId: 'source-node',
    travelDirections: [[1, 0]],
  });
  assert.deepEqual(
    results.map((a) => a.partIndex),
    [0, 1],
  );
  assert.equal(results[1].segmentIndex, 0);
  assert.equal(results[1].distanceAlongPartMeters, 0);
  assert.equal(results[1].nodeId, 'source-node');
  assert.deepEqual(results[1].travelDirections, [[1, 0]]);
  assert.equal(aliases({ partIndex: 0, coordinate: [0.0005, 0] }).length, 1);
});
