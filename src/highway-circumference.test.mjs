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
  assert.equal(data.methodology.interchangeConnectorCount, 1);
  assert.equal(data.methodology.osmPrecisionMainlineCount, 2);

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
    new Set([
      'highway-inside',
      'highway-network-mainline',
      'highway-network-connector',
      'highway-route-mainline',
    ]),
  );
  assert.equal(
    collection.features.length,
    data.network.features.length + data.route.segments.length + 1,
  );
});

test('Norwalk uses paired OSM mainlines and one explicit ramp connector', () => {
  const i95 = data.network.features.find(
    (feature) => feature.properties.id === 'ne-road-49175-0',
  );
  const us7 = data.network.features.find(
    (feature) => feature.properties.id === 'ne-road-7118-0',
  );
  const connector = data.network.features.find(
    (feature) => feature.properties.id === 'osm-interchange-norwalk-i95-us7',
  );
  assert.equal(i95?.properties.role, 'mainline');
  assert.equal(us7?.properties.role, 'mainline');
  assert.equal(connector?.properties.role, 'connector');
  assert.deepEqual(us7?.geometry.coordinates[0], [-73.41898, 41.11031]);
  assert.ok(
    i95?.geometry.coordinates.some(
      (coordinate) =>
        coordinate[0] === connector?.geometry.coordinates[0]?.[0] &&
        coordinate[1] === connector?.geometry.coordinates[0]?.[1],
    ),
  );
  assert.ok(
    us7?.geometry.coordinates.some(
      (coordinate) =>
        coordinate[0] === connector?.geometry.coordinates.at(-1)?.[0] &&
        coordinate[1] === connector?.geometry.coordinates.at(-1)?.[1],
    ),
  );
  assert.equal(
    data.route.coordinates.some(
      ([longitude, latitude]) =>
        longitude > -73.435 &&
        longitude < -73.41 &&
        latitude > 41.115 &&
        latitude < 41.15,
    ),
    false,
  );
});
