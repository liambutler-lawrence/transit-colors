import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  describeSolarNoonSkew,
  formatSolarNoon,
  solarNoonSkewMinutes,
  timezoneSkewCollectionSchema,
} from './timezone-skew.ts';

test('the committed clock-skew zones satisfy the runtime boundary', async () => {
  const data = timezoneSkewCollectionSchema.parse(
    JSON.parse(
      await readFile(
        new URL('../data/timezone-skew-zones.geojson', import.meta.url),
        'utf8',
      ),
    ),
  );

  assert.ok(data.features.length >= 300);
  assert.equal(data.metadata.iana_release, '2026c');
  assert.equal(data.metadata.timezone_release, '2026c');
  assert.equal(Object.keys(data.metadata.timezone_rules).length, data.features.length);
  assert.ok(
    data.features.every(({ geometry }) => geometry.coordinates.length > 0),
    'every timekeeping region should retain renderable geometry',
  );
  assert.ok(data.features.some(({ properties }) => properties.offset_hours === 5.5));
  assert.ok(data.features.some(({ properties }) => properties.offset_hours === 12.75));
  assert.ok(
    data.features.some(
      ({ properties }) => properties.timezone_name === 'America/New_York',
    ),
  );
  assert.ok(
    data.features.some(
      ({ properties }) => properties.timezone_name === 'America/Phoenix',
    ),
  );
  assert.ok(
    data.features.some(
      ({ properties }) => properties.timezone_name === 'America/Edmonton',
    ),
  );
  assert.ok(
    data.features.some(
      ({ properties }) => properties.timezone_name === 'America/Vancouver',
    ),
  );
  assert.deepEqual(
    data.metadata.timezone_rules['America/Edmonton']?.standardTransitions.at(-1),
    [Date.UTC(2026, 10, 1, 8) / 1_000, -6 * 3_600],
  );
  assert.deepEqual(
    data.metadata.timezone_rules['America/New_York']?.transitions.filter(
      ([epochSeconds]) =>
        epochSeconds >= Date.UTC(2026, 0, 1) / 1_000 &&
        epochSeconds < Date.UTC(2027, 0, 1) / 1_000,
    ),
    [
      [Date.UTC(2026, 2, 8, 7) / 1_000, -4 * 3_600],
      [Date.UTC(2026, 10, 1, 6) / 1_000, -5 * 3_600],
    ],
  );
});

test('the clock-skew color wash follows the shared globe projection', async () => {
  const [accessControls, mapLifecycle, timezoneUi] = await Promise.all([
    readFile(new URL('./app/access-controls.ts', import.meta.url), 'utf8'),
    readFile(new URL('./app/map-lifecycle.ts', import.meta.url), 'utf8'),
    readFile(new URL('./app/timezone-skew-ui.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(accessControls, /map\.setProjection\(\{ type: 'globe' \}\)/);
  assert.match(mapLifecycle, /map\.setProjection\(\{ type: 'globe' \}\)/);
  assert.match(timezoneUi, /gl_Position = projectTile\(a_position\)/);
  assert.match(timezoneUi, /shaderData\.variantName/);
  assert.doesNotMatch(accessControls, /timezoneActive \? 'mercator'/);
  assert.doesNotMatch(mapLifecycle, /initialProduct === 'timezone' \? 'mercator'/);
});

test('solar noon skew compares UTC offset with longitude-derived solar time', () => {
  assert.equal(solarNoonSkewMinutes(0, 0), 0);
  assert.equal(solarNoonSkewMinutes(-75, -5), 0);
  assert.equal(solarNoonSkewMinutes(75, 8), 180);
  assert.equal(solarNoonSkewMinutes(15, 0), -60);
  assert.equal(solarNoonSkewMinutes(-179, 12), -4);
  assert.equal(solarNoonSkewMinutes(181, 12), -4);
});

test('solar noon formatting uses a readable twelve-hour clock', () => {
  assert.equal(formatSolarNoon(0), '12:00 pm');
  assert.equal(formatSolarNoon(75), '1:15 pm');
  assert.equal(formatSolarNoon(-64), '10:56 am');
});

test('solar noon descriptions communicate direction without reversing the scale', () => {
  assert.equal(describeSolarNoonSkew(0), 'within about 5 minutes of 12:00');
  assert.equal(describeSolarNoonSkew(90), '1 hr 30 min later than 12:00');
  assert.equal(describeSolarNoonSkew(-35), '35 min earlier than 12:00');
});
