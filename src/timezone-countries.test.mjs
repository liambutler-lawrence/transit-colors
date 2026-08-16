import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { timezoneCountryCollectionSchema } from './timezone-countries.ts';

test('the committed country boundaries satisfy the simulator schema', async () => {
  const data = timezoneCountryCollectionSchema.parse(
    JSON.parse(
      await readFile(
        new URL('../data/timezone-skew-countries.geojson', import.meta.url),
        'utf8',
      ),
    ),
  );

  assert.equal(data.features.length, 242);
  assert.equal(data.metadata.license, 'Public domain');
  assert.ok(data.features.some(({ properties }) => properties.name === 'Monaco'));
  assert.ok(
    data.features.some(
      ({ properties }) => properties.name === 'United States of America',
    ),
  );
  assert.ok(data.features.every(({ geometry }) => geometry.type === 'MultiPolygon'));
});
