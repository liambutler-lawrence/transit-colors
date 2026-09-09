import assert from 'node:assert/strict';
import { open, readFile } from 'node:fs/promises';
import test from 'node:test';

import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import { PMTiles } from 'pmtiles';

import { hasProperSelfIntersection } from '../scripts/highway-cycle.mjs';
import { geodesicDistanceMeters } from '../scripts/wgs84-geodesy.mjs';
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
    'detailed-topology-preserving-perimeter-ears',
  );
  assert.match(data.centerline_method, /Closest-tangent.*staggered joins/);
  assert.equal(data.network.featureCount, data.methodology.sourceFeatureCount);
  assert.equal(
    data.network.featureCount,
    data.methodology.osmPrecisionMainlineCount +
      data.methodology.interchangeConnectorCount,
  );
  assert.equal(data.network.sourceLayer, 'highways');
  assert.match(data.network.tileUrl, /\.pmtiles$/);
  assert.ok(data.network.featureCount > 10_000);
  assert.ok(data.route.boundaryRoadFeatureCount > 20_000);
  assert.ok(data.route.boundaryCorridorCount > 700);
  assert.ok(data.route.areaSquareMeters > 6_150_000_000_000);
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
  assert.ok(
    data.route.coordinates.some(
      ([longitude, latitude]) =>
        longitude > -80 && longitude < -78.5 && latitude > 43.65,
    ),
    'route should use Highway 407 north of Toronto',
  );
  assert.ok(
    data.route.coordinates.some(
      ([longitude, latitude]) =>
        longitude > -76 && longitude < -75.4 && latitude > 45.25,
    ),
    'route should include the Highway 416 / 417 Ottawa leg',
  );
  assert.ok(
    data.route.coordinates.some(
      ([longitude, latitude]) =>
        longitude > -71.1 && longitude < -70.85 && latitude > 41.75 && latitude < 42.05,
    ),
    'route should include the I-495 southeastern Massachusetts detour',
  );
  assert.equal(hasProperSelfIntersection(data.route.coordinates), false);
  assert.ok(data.methodology.interchangeConnectorCount > 5_000);
  assert.ok(data.methodology.directionalRampPathCount > 12_000);
  assert.equal(
    data.methodology.directionalRampPathCount -
      data.methodology.alternativeRampPathCount -
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
  const inside = collection.features.find(
    ({ properties }) => properties.kind === 'highway-inside',
  );
  assert.equal(inside.geometry.type, 'Polygon');
  assert.deepEqual(inside.geometry.coordinates, [data.route.coordinates]);
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

    // The west end used to stop at the average of the two ramp joins. The
    // regenerated ramp must continue along I-20 to its earlier physical split.
    const florencePoint = [-79.8543729, 34.1982187];
    const florenceTile = webMercatorTile(...florencePoint, 14);
    const tile = await archive.getZxy(14, florenceTile.x, florenceTile.y);
    assert.ok(tile);
    const layer = new VectorTile(new Pbf(tile.data)).layers['highways'];
    const rampCoordinates = [];
    for (let index = 0; index < layer.length; index += 1) {
      const feature = layer.feature(index);
      if (feature.properties['role'] !== 'connector') continue;
      const geometry = feature.toGeoJSON(florenceTile.x, florenceTile.y, 14).geometry;
      rampCoordinates.push(
        ...(geometry.type === 'LineString'
          ? geometry.coordinates
          : geometry.coordinates.flat()),
      );
    }
    assert.ok(
      rampCoordinates.some(
        (coordinate) => geodesicDistanceMeters(florencePoint, coordinate) < 20,
      ),
      'Florence ramp tiles must include the mainline continuation',
    );

    // The northern I-285 / I-85 connection previously appeared twice, once
    // for the direct ramps and once for their longer collector alternatives.
    const atlantaPoint = [-84.2597, 33.893045];
    const atlantaTile = webMercatorTile(...atlantaPoint, 14);
    const atlantaData = await archive.getZxy(14, atlantaTile.x, atlantaTile.y);
    assert.ok(atlantaData);
    const atlantaLayer = new VectorTile(new Pbf(atlantaData.data)).layers['highways'];
    const northernConnectors = new Set();
    for (let index = 0; index < atlantaLayer.length; index += 1) {
      const feature = atlantaLayer.feature(index);
      if (feature.properties['role'] !== 'connector') continue;
      const geometry = feature.toGeoJSON(atlantaTile.x, atlantaTile.y, 14).geometry;
      const coordinates =
        geometry.type === 'LineString'
          ? geometry.coordinates
          : geometry.coordinates.flat();
      if (
        coordinates.some(
          (coordinate) => geodesicDistanceMeters(atlantaPoint, coordinate) < 20,
        )
      ) {
        northernConnectors.add(feature.properties['id']);
      }
    }
    assert.equal(northernConnectors.size, 1, 'one centerline for the northern turn');

    // Memorial Drive's centerline must end where its opposing carriageway
    // stops, without a tail formed by repeatedly pairing with its endpoint.
    const oldSpurTip = [-84.1702383, 33.8189497];
    const stoneTile = webMercatorTile(...oldSpurTip, 14);
    const stoneData = await archive.getZxy(14, stoneTile.x, stoneTile.y);
    assert.ok(stoneData);
    const stoneLayer = new VectorTile(new Pbf(stoneData.data)).layers['highways'];
    const stoneMainlineCoordinates = [];
    for (let index = 0; index < stoneLayer.length; index += 1) {
      const feature = stoneLayer.feature(index);
      if (feature.properties['role'] !== 'mainline') continue;
      const geometry = feature.toGeoJSON(stoneTile.x, stoneTile.y, 14).geometry;
      stoneMainlineCoordinates.push(
        ...(geometry.type === 'LineString'
          ? geometry.coordinates
          : geometry.coordinates.flat()),
      );
    }
    assert.ok(
      stoneMainlineCoordinates.every(
        (point) => geodesicDistanceMeters(point, oldSpurTip) > 25,
      ),
      'Stone Mountain tiles must omit the unsupported mainline spur',
    );
    assert.ok(
      stoneMainlineCoordinates.some(
        (point) => geodesicDistanceMeters(point, [-84.1717399, 33.8181365]) < 20,
      ),
      'Stone Mountain tiles must retain the valid approach centerline',
    );

    // Viaducto's two directional merge nodes must render as one shared
    // mainline junction, without the former inserted-point reversals.
    const viaductoPoint = [-99.1744359, 19.398513];
    const viaductoTile = webMercatorTile(...viaductoPoint, 14);
    const viaductoData = await archive.getZxy(14, viaductoTile.x, viaductoTile.y);
    assert.ok(viaductoData);
    const viaductoLayer = new VectorTile(new Pbf(viaductoData.data)).layers['highways'];
    const viaductoLines = [];
    for (let index = 0; index < viaductoLayer.length; index += 1) {
      const feature = viaductoLayer.feature(index);
      const geometry = feature.toGeoJSON(viaductoTile.x, viaductoTile.y, 14).geometry;
      const lines =
        geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates;
      for (const line of lines) {
        const nearby = line.filter(
          ([x, y]) => x > -99.176 && x < -99.1735 && y > 19.3978 && y < 19.399,
        );
        if (nearby.length < 2) continue;
        assert.equal(feature.properties['role'], 'mainline');
        const direction = Math.sign(nearby.at(-1)[0] - nearby[0][0]);
        for (let i = 1; i < nearby.length; i += 1) {
          assert.ok(
            (nearby[i][0] - nearby[i - 1][0]) * direction > 0,
            'Viaducto mainline tiles must not double back',
          );
        }
        viaductoLines.push(nearby);
      }
    }
    assert.ok(viaductoLines.length >= 2);
    assert.ok(
      viaductoLines.every((line) =>
        line.some((point) => geodesicDistanceMeters(point, viaductoPoint) < 5),
      ),
      'both approaches must include the shared merge vertex',
    );

    // The wide median at Coachochitlán must remain a continuous centerline
    // in the published vector data, as well as in the source pairing tests.
    const coachochitlanTile = webMercatorTile(-100.027, 19.8557, 14);
    const coachochitlanData = await archive.getZxy(
      14,
      coachochitlanTile.x,
      coachochitlanTile.y,
    );
    assert.ok(coachochitlanData);
    const coachochitlanLayer = new VectorTile(new Pbf(coachochitlanData.data)).layers[
      'highways'
    ];
    let continuousWideMedian = false;
    for (let index = 0; index < coachochitlanLayer.length; index += 1) {
      const feature = coachochitlanLayer.feature(index);
      if (feature.properties['role'] !== 'mainline') continue;
      const geometry = feature.toGeoJSON(
        coachochitlanTile.x,
        coachochitlanTile.y,
        14,
      ).geometry;
      const lines =
        geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates;
      continuousWideMedian ||= lines.some(
        (line) =>
          line.some(([x, y]) => x < -100.032 && y > 19.854 && y < 19.857) &&
          line.some(([x, y]) => x > -100.022 && y > 19.854 && y < 19.857),
      );
    }
    assert.ok(continuousWideMedian, 'Coachochitlán tiles must span the wide median');

    const toronto407 = await highwayPropertiesNear(archive, -79.54, 43.79);
    assert.ok(
      toronto407.some(
        (properties) =>
          properties['role'] === 'mainline' &&
          String(properties['number']).split(' / ').includes('407'),
      ),
    );

    const ottawa = await highwayPropertiesNear(archive, -75.7, 45.42);
    assert.ok(
      ottawa.some(
        (properties) =>
          properties['role'] === 'mainline' &&
          String(properties['number']).split(' / ').includes('417'),
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
