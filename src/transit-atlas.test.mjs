import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createTransitAtlasLoader, atlasStationMetadata } from './transit-atlas.ts';
import { transitCoverageArea } from './transit-coverage.ts';
import { metersPerDegreeAtLatitude } from './geodesy.ts';
import { createAtlasStreetScorer } from './transit-road-tiles.ts';
import { createStreetAccessScorer } from './routing.ts';

const station = (id, coordinates, status = 'open', area = id) => ({
  type: 'Feature',
  properties: { id, name: id, mode: 'subway', status, area_key: area },
  geometry: { type: 'Point', coordinates },
});
const street = (coordinates) => ({
  type: 'Feature',
  properties: { d: 5000 },
  geometry: { type: 'LineString', coordinates },
});

test('coverage counts overlapping catchments once and excludes future stations', () => {
  const radius = 5000;
  const circle = Math.PI * radius ** 2;
  const first = station('a', [0, 0]);
  assert.equal(transitCoverageArea([]), 0);
  assert.ok(Math.abs(transitCoverageArea([first]) - circle) < 0.001);
  assert.ok(
    Math.abs(transitCoverageArea([first, station('b', [0, 0])]) - circle) < 0.001,
  );
  assert.equal(
    transitCoverageArea([first, station('future', [10, 10], 'future')]),
    transitCoverageArea([first]),
  );
  const offset = radius / metersPerDegreeAtLatitude(0).longitude;
  const overlap = 2 * radius ** 2 * Math.acos(0.5) - (radius ** 2 * Math.sqrt(3)) / 2;
  const actual = transitCoverageArea([first, station('b', [offset, 0])]);
  assert.ok(Math.abs(actual - (2 * circle - overlap)) < 0.001);
  assert.ok(
    Math.abs(transitCoverageArea([first, station('b', [1, 0])]) - 2 * circle) < 0.001,
  );
});

test('global scoring gives every metro the same distances as its own local scorer', async () => {
  const stations = [
    station('mexico', [-99.13, 19.43]),
    station('new-york', [-73.98, 40.75]),
    station('singapore', [103.82, 1.35]),
    station('athens', [23.73, 37.98]),
    station('atlanta', [-84.39, 33.75]),
  ];
  const streets = stations.map(({ geometry }) => {
    const [longitude, latitude] = geometry.coordinates;
    return street([
      [longitude + 0.01, latitude],
      [longitude + 0.01, latitude + 0.001],
    ]);
  });
  const expected = streets.map(
    (feature, index) =>
      createStreetAccessScorer([stations[index]], { exhaustive: true }).score(
        [structuredClone(feature)],
        { candidateCount: 5 },
      )[0],
  );
  const scorer = createAtlasStreetScorer(stations);
  assert.deepEqual(
    scorer.score(structuredClone(streets), { candidateCount: 5 }),
    expected,
  );
  assert.deepEqual(
    await scorer.scoreAsync(structuredClone(streets), { candidateCount: 5 }),
    expected,
  );
  assert.equal(createAtlasStreetScorer([]), null);
  const onlySingapore = createAtlasStreetScorer([stations[2]]);
  assert.deepEqual(
    onlySingapore.score([structuredClone(streets[2])], { candidateCount: 5 }),
    [expected[2]],
  );
});

test('the complete atlas loads once, keeps unique station identities, and ranks real default coverage', async (t) => {
  const keys = ['cdmx', 'nyc', 'singapore', 'atlanta', 'athens'];
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(url);
    return new Response(await readFile(new URL(`../${url}`, import.meta.url)));
  });
  const areas = Object.fromEntries(
    keys.map((key) => [
      key,
      {
        stations: `data/${key}-stations.geojson`,
        metadata: `data/${key}-metadata.json`,
      },
    ]),
  );
  const load = createTransitAtlasLoader(areas, keys);
  const [atlas, sameAtlas] = await Promise.all([load(), load()]);
  assert.equal(atlas, sameAtlas);
  assert.equal(await load(), atlas);
  assert.equal(requests.length, keys.length * 2);
  const features = [...atlas.values()].flatMap((area) => area.stations.features);
  assert.equal(
    new Set(features.map((feature) => feature.properties.id)).size,
    features.length,
  );
  for (const key of keys) {
    const area = atlas.get(key);
    assert.ok(
      area.stations.features.every((feature) => feature.properties.area_key === key),
    );
    assert.ok(area.coverageAreaSquareMeters > 100_000_000);
  }
  const ranked = [...atlas.entries()].sort(
    (a, b) => b[1].coverageAreaSquareMeters - a[1].coverageAreaSquareMeters,
  );
  assert.equal(ranked[0][0], 'nyc');
  assert.equal(ranked[1][0], 'cdmx');
  const metadata = atlasStationMetadata({ type: 'FeatureCollection', features });
  assert.equal(
    metadata.open_station_count,
    features.filter((feature) => feature.properties.status === 'open').length,
  );
  assert.equal(metadata.future_station_count, 23);
  assert.ok(metadata.station_modes_open.brt > 0);
  assert.ok(metadata.station_modes_open.subway > 0);
});

test('an unsuccessful atlas load can be retried', async (t) => {
  const load = createTransitAtlasLoader(
    { city: { stations: 'stations', metadata: 'metadata' } },
    ['city'],
  );
  let count = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    count += 1;
    return new Response('', { status: 503 });
  });
  await assert.rejects(load(), /503/);
  await assert.rejects(load(), /503/);
  assert.equal(count, 4);
});
