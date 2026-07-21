import assert from 'node:assert/strict';
import test from 'node:test';

import { CURATED_CDMX_STATIONS } from './cdmx-curated-stations.mjs';
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
    buildStationFeatures([
      { type: 'node', id: 1, lon: -99.7, lat: 19.2, tags },
    ]),
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
    buildStationFeatures([
      { type: 'node', id: 2, lon: -99.6, lat: 19.25, tags },
    ]).length,
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

test('official supplements cover Tren AIFA and Trolebús Lines 10–12', () => {
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

  assert.equal(CURATED_CDMX_STATIONS.length, 66);
  assert.equal(new Set(reconciled.map((feature) => feature.properties.id)).size, 66);
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
    reconciled.find(
      (feature) =>
        feature.properties.name === 'Teotongo' &&
        feature.properties.route_ref === '11',
    ).geometry.coordinates,
    [-98.9746, 19.3374],
  );
  assert.equal(
    reconciled.some((feature) => feature.properties.id === 'node/12852049416'),
    false,
  );
});
