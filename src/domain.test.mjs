import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { metadataSchema } from './domain.js';

test('committed metadata matches the runtime boundary schema', async () => {
  for (const areaKey of ['cdmx', 'nyc']) {
    const rawMetadata = JSON.parse(
      await readFile(
        new URL(`../data/${areaKey}-metadata.json`, import.meta.url),
        'utf8',
      ),
    );
    const metadata = metadataSchema.parse(rawMetadata);
    assert.ok(metadata.city.length > 0);

    if (areaKey === 'nyc') {
      assert.equal(metadata.histogram, null);
      assert.equal(metadata.street_count, null);
    }
  }
});
