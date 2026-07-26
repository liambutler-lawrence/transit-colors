import assert from 'node:assert/strict';
import test from 'node:test';

import { CURATED_CDMX_STATIONS } from './cdmx-curated-stations.mjs';
import {
  metroLineRefsForStation,
  normalizedPlatformStationName,
  stationMatchesRoute,
} from './cdmx-platforms.mjs';
import {
  buildStationFeatures,
  classifyStation,
  isKnownFalsePositiveTags,
  reconcileStationFeatures,
} from './build-cdmx-data.mjs';

test('ordinary bus terminals cannot fall through to commuter rail', () => {
  const tags = {
    name: 'Servicios Urbanos Y Suburbanos Xinantecatl',
    amenity: 'bus_station',
    public_transport: 'station',
    bus: 'yes',
  };

  assert.equal(classifyStation(tags).keep, false);
  assert.equal(isKnownFalsePositiveTags(tags), true);
  assert.deepEqual(
    buildStationFeatures([{ type: 'node', id: 1, lon: -99.7, lat: 19.2, tags }]),
    [],
  );
  assert.equal(
    classifyStation({
      name: 'Lechería',
      network: 'Suburbano',
      railway: 'station',
    }).mode,
    'commuter_rail',
  );
});

test('known false Mexibús platform is rejected', () => {
  const tags = {
    name: 'Plaza Maguey',
    network: 'MexiBus',
    highway: 'bus_stop',
    public_transport: 'platform',
  };

  assert.equal(classifyStation(tags).mode, 'brt');
  assert.equal(isKnownFalsePositiveTags(tags), true);
  assert.equal(
    buildStationFeatures([{ type: 'node', id: 2, lon: -99.6, lat: 19.25, tags }])
      .length,
    0,
  );
});

test('Trolebús Line 12 is classified as BRT', () => {
  assert.deepEqual(
    classifyStation({
      name: 'Cantil',
      network: 'Trolebús Línea 12',
      route: 'trolleybus',
      public_transport: 'platform',
    }),
    { keep: true, mode: 'brt', system: 'BRT' },
  );
});

test('Metro platform matching keeps interchange lines distinct', () => {
  assert.deepEqual(
    metroLineRefsForStation({
      name: 'Chabacano L8',
      network: 'STC Metro Línea 8',
      route_ref: '8',
    }),
    new Set(['8']),
  );
  assert.equal(normalizedPlatformStationName('Tacuba (Línea 7)'), 'tacuba');
  assert.equal(
    stationMatchesRoute(
      { name: 'Chabacano L8', route_ref: '8' },
      new Set(['metro-8']),
      new Map([
        ['metro-8', { route_short_name: '8' }],
        ['metro-9', { route_short_name: '9' }],
      ]),
    ),
    true,
  );
  assert.equal(
    stationMatchesRoute(
      { name: 'Chabacano L8', route_ref: '8' },
      new Set(['metro-9']),
      new Map([['metro-9', { route_short_name: '9' }]]),
    ),
    false,
  );

  const reconciled = reconcileStationFeatures([
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-99.1356, 19.4092] },
      properties: {
        id: 'osm/chabacano-l2',
        name: 'Chabacano L2',
        network: 'Línea 2',
        mode: 'subway',
      },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-99.1342, 19.4087] },
      properties: {
        id: 'osm/chabacano-l9',
        name: 'Chabacano L9',
        mode: 'subway',
      },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-99.1878, 19.4582] },
      properties: {
        id: 'osm/tacuba-l7',
        name: 'Tacuba L7',
        mode: 'subway',
      },
    },
  ]);
  assert.ok(reconciled.some((feature) => feature.properties.id === 'osm/chabacano-l2'));
  assert.equal(
    reconciled.some((feature) => feature.properties.id === 'osm/chabacano-l9'),
    false,
  );
  assert.equal(
    reconciled.some((feature) => feature.properties.id === 'osm/tacuba-l7'),
    false,
  );
});

test('official supplements cover corrected Metro platforms, Tren AIFA, and Trolebús Lines 10–12', () => {
  const reconciled = reconcileStationFeatures([
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-98.9875, 19.3519] },
      properties: {
        id: 'node/12852049416',
        name: 'Teotongo',
        mode: 'brt',
        route_ref: '11',
      },
    },
  ]);

  assert.equal(CURATED_CDMX_STATIONS.length, 69);
  assert.equal(new Set(reconciled.map((feature) => feature.properties.id)).size, 69);
  assert.equal(reconcileStationFeatures(reconciled).length, reconciled.length);
  assert.equal(
    reconciled.filter((feature) => feature.properties.route_ref === 'AIFA').length,
    7,
  );
  assert.equal(
    reconciled.filter((feature) => feature.properties.route_ref === '10').length,
    12,
  );
  assert.equal(
    reconciled.filter((feature) => feature.properties.route_ref === '11').length,
    15,
  );
  assert.equal(
    reconciled.filter((feature) => feature.properties.route_ref === '12').length,
    32,
  );
  assert.deepEqual(
    reconciled
      .filter((feature) =>
        ['official/metro/chabacano-line-8', 'official/metro/chabacano-line-9'].includes(
          feature.properties.id,
        ),
      )
      .map((feature) => feature.geometry.coordinates),
    [
      [-99.1338, 19.4102],
      [-99.134, 19.4085],
    ],
  );
  assert.deepEqual(
    reconciled.find(
      (feature) =>
        feature.properties.name === 'Teotongo' && feature.properties.route_ref === '11',
    ).geometry.coordinates,
    [-98.9746, 19.3374],
  );
  assert.equal(
    reconciled.some((feature) => feature.properties.id === 'node/12852049416'),
    false,
  );
});
