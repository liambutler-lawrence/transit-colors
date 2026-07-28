import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { hasProperSelfIntersection } from '../scripts/highway-cycle.mjs';
import {
  highwayCircumferenceDataSchema,
  highwayFeatureCollection,
  highwayLandmassArea,
} from './highway-circumference.ts';

const data = highwayCircumferenceDataSchema.parse(
  JSON.parse(
    await readFile(
      new URL('../data/north-america-highway-circumference.json', import.meta.url),
      'utf8',
    ),
  ),
);

test('North America highway data publishes one exact maximum and full network', () => {
  assert.equal(data.methodology.optimizationStatus, 'optimal');
  assert.equal(
    data.methodology.optimizationMethod,
    'exact-planar-biconnected-outer-boundary',
  );
  assert.ok(data.network.features.length > 2_000);
  assert.ok(data.route.boundaryRoadFeatureCount > 200);
  assert.ok(data.route.areaSquareMeters > 4_000_000_000_000);
  assert.ok(data.route.lengthMeters > 15_000_000);
  assert.equal(hasProperSelfIntersection(data.route.coordinates), false);

  const countries = new Set(
    data.network.features.flatMap((feature) => feature.properties.country.split(' / ')),
  );
  assert.ok(countries.has('Canada'));
  assert.ok(countries.has('Mexico'));
  assert.ok(countries.has('United States'));
  for (const feature of data.network.features) {
    if (feature.properties.type === 'Connector') continue;
    assert.equal(feature.properties.divided, 'Divided');
    assert.ok(['Freeway', 'Tollway'].includes(feature.properties.type));
  }
});

test('highway route stores WGS84 land-contained and coastward areas', () => {
  assert.ok(data.route.containedLandAreaSquareMeters < data.route.areaSquareMeters);
  assert.ok(data.route.outsideLandAreaSquareMeters > data.route.areaSquareMeters);
  assert.ok(
    Math.abs(
      data.route.containedLandAreaSquareMeters +
        data.route.outsideLandAreaSquareMeters -
        data.landmass.area_m2,
    ) < 1,
  );
  const landmass = highwayLandmassArea(data);
  assert.equal(landmass.landmasses[0]?.label, 'North American mainland');
  assert.equal(landmass.mask?.length, 1);
});

test('highway map collection separates thin network, thick route, and inside', () => {
  const collection = highwayFeatureCollection(data);
  const kinds = new Set(collection.features.map((feature) => feature.properties?.kind));
  assert.deepEqual(
    kinds,
    new Set(['highway-inside', 'highway-network', 'highway-route']),
  );
  assert.equal(collection.features.length, data.network.features.length + 2);
});
