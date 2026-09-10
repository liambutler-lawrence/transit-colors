import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  assignAutomaticTimezones,
  automaticTimezoneDataSchema,
  fitAutomaticTimezone,
} from './automatic-timezones.ts';
import { PolygonHitIndex } from './polygon-hit-index.ts';

const region = (id, level, west, east, parent_id = null) => ({
  id,
  parent_id,
  name: id,
  country_name: 'Example',
  country_code: 'EX',
  iso_code: '',
  level,
  longitude_ranges: [[west, east]],
  source: 'fixture',
  coverage_note: '',
  geometry: {
    type: 'MultiPolygon',
    coordinates: [
      [
        [
          [west, 0],
          [east, 0],
          [east, 1],
          [west, 1],
          [west, 0],
        ],
      ],
    ],
  },
});

test('whole-hour meridians use strict 30-minute then strict 60-minute containment', () => {
  assert.equal(fitAutomaticTimezone([[-7.499, 7.499]]).toleranceMinutes, 30);
  assert.deepEqual(fitAutomaticTimezone([[-7.5, 7.5]]), {
    offsetHours: 0,
    maximumSkewMinutes: 30,
    toleranceMinutes: 60,
  });
  assert.equal(fitAutomaticTimezone([[-14.999, 14.999]]).toleranceMinutes, 60);
  assert.equal(fitAutomaticTimezone([[-15, 15]]), null);
  assert.equal(fitAutomaticTimezone([[7.5, 7.5]]).toleranceMinutes, 60);
  assert.equal(fitAutomaticTimezone([[82, 88]]).offsetHours, 6);
});

test('the full interval and every offshore island must fit, including the date line', () => {
  assert.equal(
    fitAutomaticTimezone([
      [174, 179],
      [-179, -174],
    ]).offsetHours,
    12,
  );
  assert.equal(
    fitAutomaticTimezone([
      [534, 539],
      [-539, -534],
    ]).offsetHours,
    12,
  );
  assert.equal(fitAutomaticTimezone([[-179, 179]]), null);
  assert.equal(
    fitAutomaticTimezone([
      [-5, 5],
      [40, 41],
    ]),
    null,
  );
  assert.throws(() => fitAutomaticTimezone([]));
  assert.throws(() => fitAutomaticTimezone([[1, -1]]));
});

test('ambiguous meridians minimize worst-case skew, then favor UTC+0', () => {
  assert.equal(fitAutomaticTimezone([[7, 9]]).offsetHours, 1);
  assert.equal(fitAutomaticTimezone([[6, 9]]).offsetHours, 0);
  assert.equal(fitAutomaticTimezone([[-9, -6]]).offsetHours, 0);
});

test('a country fitting the relaxed range stays whole even when children fit tighter', () => {
  const results = assignAutomaticTimezones([
    region('country', 0, -10, 10),
    region('west', 1, -10, -5, 'country'),
    region('east', 1, 5, 10, 'country'),
  ]);
  assert.equal(results.length, 1);
  assert.equal(results[0].region.id, 'country');
  assert.equal(results[0].fit.toleranceMinutes, 60);
});

test('only failing branches descend; second-level failures get a named UTC+0 fallback', () => {
  const results = assignAutomaticTimezones([
    region('country', 0, -50, 50),
    region('fits', 1, -3, 3, 'country'),
    region('split', 1, -50, 50, 'country'),
    region('child-fit', 2, 25, 28, 'split'),
    region('offender', 2, -50, 50, 'split'),
  ]);
  assert.deepEqual(
    results.map((r) => [r.region.id, r.offsetHours, r.fallback]),
    [
      ['fits', 0, null],
      ['child-fit', 2, null],
      ['offender', 0, 'too-wide'],
    ],
  );
});

test('missing children and unmatched boundary coverage are explicit data fallbacks', () => {
  const missing = assignAutomaticTimezones([region('missing', 0, -50, 50)])[0];
  assert.equal(missing.fallback, 'missing-subdivisions');
  const gap = assignAutomaticTimezones([
    { ...region('gap', 0, 25, 28), coverage_note: 'No boundary coverage.' },
  ])[0];
  assert.equal(gap.fallback, 'uncovered-area');
  assert.equal(gap.offsetHours, 0);
  assert.throws(() => assignAutomaticTimezones([region('orphan', 1, 0, 1, 'absent')]));
  assert.throws(() =>
    assignAutomaticTimezones([region('same', 0, 0, 1), region('same', 0, 0, 1)]),
  );
});

test('committed world hierarchy resolves to drawable, source-backed, correctly nested regions', async () => {
  const data = automaticTimezoneDataSchema.parse(
    JSON.parse(
      await readFile(
        new URL('../data/timezone-automatic-regions.json', import.meta.url),
        'utf8',
      ),
    ),
  );
  const assignments = assignAutomaticTimezones(data.regions);
  const sources = new Set(data.metadata.sources.map(({ id }) => id));
  assert.equal(data.regions.filter((r) => r.level === 0).length, 258);
  const leaves = new Set(assignments.map(({ region }) => region.id));
  for (const { region, fit, fallback, offsetHours } of assignments) {
    assert.ok(region.geometry.coordinates.length > 0, region.id);
    assert.ok(sources.has(region.source), region.source);
    assert.ok(Number.isInteger(offsetHours));
    if (fit) assert.ok(fit.maximumSkewMinutes < fit.toleranceMinutes);
    else assert.equal(offsetHours, 0);
    if (fallback === 'too-wide') assert.equal(region.level, 2);
    if (region.parent_id) assert.ok(!leaves.has(region.parent_id), region.id);
  }
  const index = new PolygonHitIndex(
    assignments.map((assignment) => ({
      polygons: assignment.region.geometry.coordinates,
      value: assignment,
    })),
  );
  assert.equal(index.find(-0.12, 51.5).offsetHours, 0); // London: keep the UK whole.
  assert.equal(index.find(2.35, 48.85).region.level, 1); // France descends to regions.
  assert.equal(index.find(-99.13, 19.43).region.iso_code, 'MX-CMX');
  assert.equal(index.find(-149.9, 61.2).region.level, 2); // Anchorage, Alaska.
  assert.equal(index.find(116.4, 39.9).offsetHours, 8); // Beijing.
  assert.ok(
    assignments.some(
      (a) =>
        a.region.country_code === 'CAN' &&
        a.region.level === 2 &&
        a.fallback === 'too-wide',
    ),
  );
  assert.ok(
    assignments.some(
      (a) =>
        a.region.country_code === 'RUS' &&
        a.region.level === 2 &&
        a.fallback === 'too-wide',
    ),
  );
  assert.deepEqual(
    assignments
      .filter(({ fallback }) => fallback === 'too-wide')
      .map(({ region }) => `${region.country_code} / ${region.name}`)
      .sort(),
    [
      'CAN / Kitikmeot',
      'CAN / Kivalliq',
      'CAN / Qikiqtaaluk',
      'CAN / Region 1',
      'RUS / Bulunsky Ulus',
      'RUS / Evenkiysky Rayon',
      'RUS / Primorsky District',
      'RUS / Taymyrsky Dolgano-Nenetsky District',
      'RUS / Zapolyarny District',
      'USA / North Slope',
    ],
  );
});

test('Mexico follows detailed state boundaries, including the narrow Jalisco border corridors', async () => {
  const data = JSON.parse(
    await readFile(new URL('../data/timezone-automatic-regions.json', import.meta.url)),
  );
  const mexico = assignAutomaticTimezones(data.regions).filter(
    ({ region }) => region.country_code === 'MEX',
  );
  assert.equal(mexico.length, 32, 'one complete coverage of the 32 states');
  assert.equal(new Set(mexico.map(({ region }) => region.iso_code)).size, 32);
  for (const { region, fallback } of mexico) {
    assert.equal(region.source, 'geoboundaries-MEX1');
    assert.equal(
      fallback,
      null,
      'a matching country footprint must not create coastal gaps',
    );
  }
  const index = new PolygonHitIndex(
    mexico.map(({ region }) => ({
      polygons: region.geometry.coordinates,
      value: region.iso_code,
    })),
  );
  // Reference points in the pinned INEGI coverage, >200 m inside their states.
  // Every point below was assigned to the wrong state by the old coarse outlines.
  for (const [longitude, latitude, expected] of [
    [-104, 21.42, 'MX-NAY'],
    [-103.82, 21.42, 'MX-NAY'],
    [-103.68, 21.4, 'MX-JAL'],
    [-103.6, 22.52, 'MX-JAL'],
    [-103.42, 22.42, 'MX-ZAC'],
    [-103.28, 22.42, 'MX-ZAC'],
    [-102.88, 21.28, 'MX-ZAC'],
    [-102.16, 22.82, 'MX-ZAC'],
    [-101.84, 22.54, 'MX-ZAC'],
    [-101.56, 21.7, 'MX-GUA'],
  ])
    assert.equal(
      index.find(longitude, latitude),
      expected,
      `${longitude}, ${latitude}`,
    );
  // The source's duplicate MX-MEX code must not conflate the capital and state.
  assert.equal(index.find(-99.13, 19.43), 'MX-CMX');
  assert.equal(index.find(-99.66, 19.28), 'MX-MEX');

  // Evenly spaced reference positions along INEGI's Jalisco/Zacatecas shared
  // border. Both outlines must stay within ~56 m, including at sharp bends.
  // This catches excessive simplification even when town hit tests still pass.
  const referenceBorder = [
    [-102.7452999, 21.7200523],
    [-102.6438227, 21.461055],
    [-102.8178323, 21.3040189],
    [-103.0595038, 21.2442604],
    [-103.2303927, 21.0808507],
    [-103.538822, 21.1285398],
    [-103.7065397, 21.3223648],
    [-103.585246, 21.3985596],
    [-103.5860897, 21.589884],
    [-103.4723527, 21.8359817],
    [-103.1811763, 21.9977839],
    [-103.0576834, 22.2157835],
    [-103.2126998, 22.4097317],
    [-103.3072287, 22.2395681],
    [-103.5774053, 22.1197776],
    [-103.6059566, 22.3497029],
    [-103.7700446, 22.5534106],
    [-103.8939496, 22.2309259],
    [-103.8650083, 22.5392549],
    [-103.91097, 22.7497792],
    [-103.9944307, 22.5702923],
    [-104.0636175, 22.3648508],
    [-104.2139407, 22.4833776],
    [-101.5545035, 21.8350205],
  ];
  for (const iso of ['MX-JAL', 'MX-ZAC']) {
    const rings = mexico
      .find(({ region }) => region.iso_code === iso)
      .region.geometry.coordinates.flat();
    for (const [x, y] of referenceBorder) {
      let nearest = Infinity;
      for (const ring of rings) {
        for (let i = 1; i < ring.length; i++) {
          const [ax, ay] = ring[i - 1];
          const [bx, by] = ring[i];
          const dx = bx - ax;
          const dy = by - ay;
          const lengthSquared = dx * dx + dy * dy;
          const t =
            lengthSquared === 0
              ? 0
              : Math.max(
                  0,
                  Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSquared),
                );
          nearest = Math.min(nearest, Math.hypot(x - ax - t * dx, y - ay - t * dy));
        }
      }
      assert.ok(nearest < 0.0005, `${iso} border drift at ${x}, ${y}: ${nearest}°`);
    }
  }
});
