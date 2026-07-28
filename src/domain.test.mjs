import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { metadataSchema, scheduleSchema, stationCollectionSchema } from './domain.js';

const AREA_KEYS = ['cdmx', 'nyc', 'singapore', 'atlanta', 'athens'];

test('committed metadata matches the runtime boundary schema', async () => {
  for (const areaKey of AREA_KEYS) {
    const rawMetadata = JSON.parse(
      await readFile(
        new URL(`../data/${areaKey}-metadata.json`, import.meta.url),
        'utf8',
      ),
    );
    const metadata = metadataSchema.parse(rawMetadata);
    assert.ok(metadata.city.length > 0);

    if (areaKey !== 'cdmx') {
      assert.equal(metadata.histogram, null);
      assert.equal(metadata.street_count, null);
    }
  }
});

test('every metro area publishes heatmap stations and schedules', async () => {
  for (const areaKey of AREA_KEYS) {
    const [stationCollection, schedules] = await Promise.all([
      readFile(
        new URL(`../data/${areaKey}-stations.geojson`, import.meta.url),
        'utf8',
      ).then((data) => stationCollectionSchema.parse(JSON.parse(data))),
      readFile(
        new URL(`../data/${areaKey}-schedules.json`, import.meta.url),
        'utf8',
      ).then((data) => scheduleSchema.parse(JSON.parse(data))),
    ]);

    assert.ok(stationCollection.features.length > 0);
    assert.ok(Object.keys(schedules.routes).length > 0);
    assert.ok(Object.keys(schedules.stations).length > 0);
  }
});
