import assert from 'node:assert/strict';
import { open, readFile } from 'node:fs/promises';
import test from 'node:test';

import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import { PMTiles } from 'pmtiles';

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

function webMercatorTile(longitude, latitude, zoom) {
  const dimension = 2 ** zoom;
  return {
    x: Math.floor(((longitude + 180) / 360) * dimension),
    y: Math.floor(
      ((1 - Math.asinh(Math.tan((latitude * Math.PI) / 180)) / Math.PI) / 2) *
        dimension,
    ),
  };
}

async function highwayPropertiesNear(archive, longitude, latitude) {
  const zoom = 14;
  const center = webMercatorTile(longitude, latitude, zoom);
  const propertiesById = new Map();
  for (let xOffset = -2; xOffset <= 2; xOffset += 1) {
    for (let yOffset = -2; yOffset <= 2; yOffset += 1) {
      const tile = await archive.getZxy(zoom, center.x + xOffset, center.y + yOffset);
      if (!tile) continue;
      const vectorTile = new VectorTile(new Pbf(tile.data));
      const layer = vectorTile.layers['highways'];
      for (let index = 0; index < layer.length; index += 1) {
        const properties = layer.feature(index).properties;
        propertiesById.set(properties['id'], properties);
      }
    }
  }
  return [...propertiesById.values()];
}

test('North America highway data publishes one validated maximum and full vector network', () => {
  assert.equal(data.methodology.optimizationStatus, 'validated-detailed');
  assert.equal(
    data.methodology.optimizationMethod,
    'detailed-macro-cycle-with-envelope-ears',
  );
  assert.equal(data.network.featureCount, data.methodology.sourceFeatureCount);
  assert.equal(data.network.sourceLayer, 'highways');
  assert.match(data.network.tileUrl, /\.pmtiles$/);
  assert.ok(data.network.featureCount > 10_000);
  assert.ok(data.route.boundaryRoadFeatureCount > 20_000);
  assert.ok(data.route.boundaryCorridorCount > 700);
  assert.ok(data.route.areaSquareMeters > 6_000_000_000_000);
  assert.ok(data.route.lengthMeters > 14_000_000);
  assert.ok(
    data.route.coordinates.some(
      ([longitude, latitude]) => longitude > -74 && latitude > 45,
    ),
  );
  assert.ok(
    data.route.coordinates.some(
      ([longitude, latitude]) => longitude > -71 && latitude > 42,
    ),
  );
  assert.equal(hasProperSelfIntersection(data.route.coordinates), false);
  assert.ok(data.methodology.interchangeConnectorCount > 4_000);
  assert.ok(data.methodology.directionalRampPathCount > 10_000);
  assert.equal(
    data.methodology.directionalRampPathCount -
      data.methodology.interchangeConnectorCount * 2,
    data.methodology.unpairedRampPathCount,
  );
  assert.ok(data.methodology.osmPrecisionMainlineCount > 5_000);
  assert.equal(data.methodology.endpointSnapCount, 0);
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
    new Set(['highway-inside', 'highway-route-mainline', 'highway-route-connector']),
  );
  assert.equal(collection.features.length, data.route.segments.length + 1);
  assert.ok(data.route.segments.some((segment) => segment.role === 'connector'));
  assert.ok(data.route.segments.some((segment) => segment.role === 'mainline'));
});

test('regenerated tiles retain centered mainlines and separate ramps continent-wide', async () => {
  const handle = await open(
    new URL('../data/north-america-highways.pmtiles', import.meta.url),
  );
  const source = {
    getKey: () => 'north-america-highways-test',
    getBytes: async (offset, length) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      const view = buffer.subarray(0, bytesRead);
      return {
        data: view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength),
      };
    },
  };
  try {
    const archive = new PMTiles(source);
    const norwalk = await highwayPropertiesNear(archive, -73.4204, 41.109);
    assert.ok(
      norwalk.some(
        (properties) =>
          properties['role'] === 'mainline' &&
          String(properties['number']).split(' / ').includes('US7'),
      ),
    );
    assert.ok(
      norwalk.some(
        (properties) =>
          properties['role'] === 'connector' &&
          properties['divided'] === 'Averaged directional pair',
      ),
    );

    const seattle = await highwayPropertiesNear(archive, -122.322, 47.595);
    assert.ok(seattle.some((properties) => properties['role'] === 'mainline'));
    assert.ok(
      seattle.some(
        (properties) =>
          properties['role'] === 'connector' &&
          properties['divided'] === 'Averaged directional pair',
      ),
    );
  } finally {
    await handle.close();
  }
});
