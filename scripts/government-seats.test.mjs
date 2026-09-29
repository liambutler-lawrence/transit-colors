import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { governmentSeatFeatures, RADIUS_METERS } from './build-government-seats.mjs';
import { geodesicDistanceMeters } from './wgs84-geodesy.mjs';
const catalog = JSON.parse(
  await readFile(
    new URL('../data/north-america-government-seats.json', import.meta.url),
    'utf8',
  ),
);
const generated = JSON.parse(
  await readFile(
    new URL('../data/north-america-government-seats.geojson', import.meta.url),
    'utf8',
  ),
);

test('government seats cover all 96 in-scope subdivisions once, with traceable building locations', () => {
  assert.equal(catalog.seats.length, 96);
  assert.equal(new Set(catalog.seats.map((seat) => seat.id)).size, 96);
  for (const [country, count] of [
    ['Canada', 13],
    ['United States', 51],
    ['Mexico', 32],
  ]) {
    assert.equal(
      catalog.seats.filter((seat) => seat.country === country).length,
      count,
    );
  }
  for (const seat of catalog.seats) {
    assert.ok(seat.building && seat.subdivision && seat.role);
    assert.match(seat.sourceUrl, /^https:\/\//);
    assert.match(seat.coordinateSourceUrl, /^https:\/\//);
    const [longitude, latitude] = seat.coordinates;
    assert.ok(
      longitude >= -180 && longitude < -50 && latitude > 14 && latitude < 85,
      seat.id,
    );
  }
});
test('circle files reproduce exactly and have a WGS84 5 km radius at every latitude', () => {
  assert.deepEqual(generated, governmentSeatFeatures(catalog.seats));
  assert.equal(RADIUS_METERS, 5000);
  assert.equal(generated.features.length, 192);
  for (const seat of catalog.seats) {
    const features = generated.features.filter(
      (feature) => feature.properties.id === seat.id,
    );
    const marker = features.find((feature) => feature.geometry.type === 'Point');
    const ring = features.find((feature) => feature.geometry.type === 'Polygon')
      .geometry.coordinates[0];
    assert.deepEqual(marker.geometry.coordinates, seat.coordinates);
    assert.deepEqual(ring[0], ring.at(-1));
    for (const point of ring)
      assert.ok(
        Math.abs(geodesicDistanceMeters(seat.coordinates, point) - 5000) < 0.02,
        seat.id,
      );
    assert.ok(
      Math.abs(geodesicDistanceMeters(ring[0], ring[90]) - 10000) < 0.02,
      seat.id,
    );
  }
});
test('active seats replace museum-only and temporarily closed capitols', () => {
  const byId = Object.fromEntries(catalog.seats.map((seat) => [seat.id, seat]));
  assert.match(byId['US-AZ'].building, /Executive Tower/);
  assert.match(byId['US-KY'].building, /State Office Building/);
  assert.match(byId['CA-PE'].building, /George Coles/);
  assert.match(byId['MX-COL'].building, /Edificio A/);
  assert.match(byId['MX-ZAC'].building, /Ciudad Administrativa/);
  assert.ok(byId['US-FL'].coordinates[0] < -84.282);
});

const chinaCatalog = JSON.parse(
  await readFile(
    new URL('../data/china-government-seats.json', import.meta.url),
    'utf8',
  ),
);
const combined = JSON.parse(
  await readFile(new URL('../data/government-seats.geojson', import.meta.url), 'utf8'),
);

test('China covers the 33 requested provincial-level divisions with sourced headquarters and no routes', async () => {
  const codes =
    'AH BJ CQ FJ GD GS GX GZ HA HB HE HI HK HL HN JL JS JX LN MO NM NX QH SC SD SH SN SX TJ XJ XZ YN ZJ'.split(
      ' ',
    );
  assert.deepEqual(
    chinaCatalog.seats.map((seat) => seat.id).sort(),
    codes.map((code) => `CN-${code}`),
  );
  for (const seat of chinaCatalog.seats) {
    assert.equal(seat.country, 'China');
    assert.ok(seat.building && seat.subdivision && seat.role);
    assert.match(seat.sourceUrl, /^https:\/\//);
    assert.match(
      seat.coordinateSourceUrl,
      /^https:\/\/(www\.openstreetmap\.org|www\.wikidata\.org)\//,
    );
    const [longitude, latitude] = seat.coordinates;
    assert.ok(
      longitude > 73 && longitude < 135 && latitude > 18 && latitude < 54,
      seat.id,
    );
  }
  const byId = Object.fromEntries(chinaCatalog.seats.map((seat) => [seat.id, seat]));
  assert.ok(
    byId['CN-BJ'].coordinates[0] > 116.7,
    'Beijing headquarters must be in Tongzhou',
  );
  assert.ok(
    byId['CN-AH'].coordinates[1] < 31.75,
    'Anhui headquarters must be in Binhu',
  );
  assert.ok(
    byId['CN-JX'].coordinates[0] < 115.85,
    'Jiangxi must use the relocated headquarters',
  );
  for (const file of [
    'north-america-government-connections.geojson',
    'north-america-government-connection-status.json',
  ]) {
    const text = await readFile(new URL(`../data/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /CN-/);
  }
});

test('combined overlay preserves North America and adds only 33 points and 33 geodesic circles', () => {
  assert.deepEqual(
    combined,
    governmentSeatFeatures([...catalog.seats, ...chinaCatalog.seats]),
  );
  assert.deepEqual(
    combined.features.slice(0, generated.features.length),
    generated.features,
  );
  assert.equal(combined.features.length, 258);
  for (const seat of chinaCatalog.seats) {
    const [point, circle] = combined.features.filter(
      (feature) => feature.properties.id === seat.id,
    );
    assert.equal(point.geometry.type, 'Point');
    assert.deepEqual(point.geometry.coordinates, seat.coordinates);
    assert.equal(circle.geometry.type, 'Polygon');
    const ring = circle.geometry.coordinates[0];
    assert.equal(ring.length, 181);
    assert.deepEqual(ring[0], ring.at(-1));
    for (const vertex of ring) {
      assert.ok(
        Math.abs(geodesicDistanceMeters(seat.coordinates, vertex) - 5000) < 0.02,
        seat.id,
      );
    }
    assert.ok(
      Math.abs(geodesicDistanceMeters(ring[0], ring[90]) - 10000) < 0.02,
      seat.id,
    );
  }
});
