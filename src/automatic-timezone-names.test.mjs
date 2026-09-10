import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  nameAutomaticTimezoneRegions,
  timezoneNameSegment,
} from './automatic-timezone-names.ts';
import {
  assignAutomaticTimezones,
  automaticTimezoneDataSchema,
} from './automatic-timezones.ts';

const region = (id, west, east, country = 'USA') => ({
  id,
  parent_id: null,
  name: id,
  country_name: country,
  country_code: country,
  iso_code: id,
  level: 0,
  longitude_ranges: [[west, east]],
  source: 'test',
  coverage_note: '',
  naming: null,
  geometry: {
    type: 'MultiPolygon',
    coordinates: [
      [
        [
          [west, 0],
          [east, 0],
          [east, 10],
          [west, 10],
          [west, 0],
        ],
      ],
    ],
  },
});
const place = (id, name, longitude, population, extras = {}) => ({
  id,
  name,
  asciiName: name,
  longitude,
  latitude: 5,
  population,
  countryCode: 'USA',
  timezone: 'America/New_York',
  source: 'natural-earth-populated-places',
  ...extras,
});

test('names follow each metro center, not its existing official timezone or a neighbor', () => {
  const regions = [region('NJ', 0, 10), region('NY', 10, 20)];
  const before = structuredClone(regions);
  const names = nameAutomaticTimezoneRegions(
    regions,
    [
      place('ny', 'New York', 15, 19_000_000),
      place('newark', 'Newark', 5, 4_800_000),
      place('trenton', 'Trenton', 7, 360_000),
      place('foreign', 'Wrong country', 5, 100_000_000, { countryCode: 'CAN' }),
      place('outside', 'Outside', 25, 100_000_000),
    ],
    [place('suburb', 'Suburb', 6, 5_000_000, { source: 'geonames-cities500' })],
  );
  assert.equal(names.get('NJ').timezone_name, 'America/Newark');
  assert.equal(names.get('NY').timezone_name, 'America/New_York');
  assert.deepEqual(regions, before, 'naming must not mutate geography or UTC inputs');
  const offsets = assignAutomaticTimezones(regions).map(({ region, offsetHours }) => [
    region.id,
    offsetHours,
  ]);
  const renamed = regions.map((r) => ({ ...r, naming: names.get(r.id) }));
  assert.deepEqual(
    assignAutomaticTimezones(renamed).map(({ region, offsetHours }) => [
      region.id,
      offsetHours,
    ]),
    offsets,
  );
});

test('settlement and empty-region fallbacks stay explicit and never borrow another region’s city', () => {
  const gap = { ...region('Coastal gap', 30, 40), coverage_note: 'Missing coverage' };
  const names = nameAutomaticTimezoneRegions(
    [region('Town district', 0, 10), region('Empty island', 10, 20), gap],
    [],
    [
      place('small', 'Small Town', 5, 500, { source: 'geonames-cities500' }),
      place('large', 'Bigger Town', 6, 1_000, { source: 'geonames-cities500' }),
      place('gap', 'Uncertain place', 35, 10_000, { source: 'geonames-cities500' }),
    ],
  );
  assert.equal(names.get('Town district').timezone_name, 'America/Bigger_Town');
  assert.equal(names.get('Town district').method, 'settlement');
  assert.equal(names.get('Empty island').timezone_name, 'Etc/Empty_island');
  assert.equal(names.get('Empty island').metro_name, null);
  assert.equal(names.get('Coastal gap').method, 'administrative-fallback');
});

test('homonyms get stable unique names while the matching IANA city keeps its bare name', () => {
  const regions = [
    region('US-A', 0, 10),
    region('US-B', 10, 20),
    region('US-C', 20, 30),
  ];
  const places = [
    place('a', 'New York', 5, 50_000),
    place('b', 'New York', 15, 50_000, { timezone: 'America/Chicago' }),
    place('c', 'São José', 25, 50_000),
    place('d', 'Zeta', 25, 50_000),
  ];
  const names = nameAutomaticTimezoneRegions(regions, places, []);
  assert.equal(names.get('US-A').timezone_name, 'America/New_York');
  assert.equal(names.get('US-B').timezone_name, 'America/New_York_US-B');
  assert.equal(names.get('US-C').timezone_name, 'America/Sao_Jose');
  const reversed = nameAutomaticTimezoneRegions(
    [...regions].reverse(),
    [...places].reverse(),
    [],
  );
  assert.deepEqual([...names].sort(), [...reversed].sort());
  assert.equal(timezoneNameSegment('Mexico City'), 'Mexico_City');
});

test('centers in holes are excluded and date-line islands retain their local metro', () => {
  const island = region('island', 170, 190, 'FJI');
  island.geometry.coordinates[0].push([
    [175, 2],
    [180, 2],
    [180, 8],
    [175, 8],
    [175, 2],
  ]);
  const names = nameAutomaticTimezoneRegions(
    [island],
    [
      place('hole', 'In the lake', 178, 200_000, {
        countryCode: 'FJI',
        timezone: 'Pacific/Fiji',
      }),
      place('land', 'Island Town', -175, 100_000, {
        countryCode: 'FJI',
        timezone: 'Pacific/Fiji',
      }),
    ],
    [],
  );
  assert.equal(names.get('island').timezone_name, 'Pacific/Island_Town');
});

test('every deployed terminal region has a unique name with the requested major metros preserved', async () => {
  const data = automaticTimezoneDataSchema.parse(
    JSON.parse(
      await readFile(
        new URL('../data/timezone-automatic-regions.json', import.meta.url),
        'utf8',
      ),
    ),
  );
  const assignments = assignAutomaticTimezones(data.regions);
  const sourceIds = new Set(data.metadata.sources.map((s) => s.id));
  const names = new Set();
  for (const { region } of assignments) {
    assert.ok(region.naming, region.id);
    assert.ok(!names.has(region.naming.timezone_name), region.naming.timezone_name);
    names.add(region.naming.timezone_name);
    if (region.naming.method === 'administrative-fallback') {
      assert.equal(region.naming.metro_name, null);
      assert.equal(region.naming.population, null);
    } else {
      assert.ok(region.naming.metro_name);
      assert.ok(sourceIds.has(region.naming.source));
      assert.equal(region.naming.coordinates.length, 2);
    }
  }
  for (const [iso, name] of [
    ['US-NY', 'America/New_York'],
    ['US-NJ', 'America/Newark'],
    ['MX-CMX', 'America/Mexico_City'],
    ['MX-MEX', 'America/Toluca'],
    ['MX-JAL', 'America/Guadalajara'],
    ['US-CA', 'America/Los_Angeles'],
  ])
    assert.equal(
      data.regions.find((r) => r.iso_code === iso).naming.timezone_name,
      name,
    );
});
