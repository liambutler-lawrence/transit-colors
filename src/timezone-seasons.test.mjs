import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildHistoricalTimezonePeriods,
  buildTimezonePeriods,
  buildTimezonePeriodsFromRules,
  formatTimezonePeriod,
  formatUtcOffset,
  parseGmtOffset,
  timezoneOffsetsAt,
  timezoneOffsetsFromRulesAt,
  timezoneRuleOffsetHours,
  timezoneTransitionsForYear,
} from './timezone-seasons.ts';

const YEAR = 2026;
const MARCH_CHANGE = Date.UTC(YEAR, 2, 1, 2);
const NOVEMBER_CHANGES = [1, 5, 9, 13, 17].map((hour) => Date.UTC(YEAR, 10, 1, hour));

function syntheticOffset(timezone, epochMs) {
  if (timezone === 'Region/A' || timezone === 'Region/B') {
    return epochMs >= MARCH_CHANGE ? 1 : 0;
  }
  const regionIndex = Number(timezone.split('/').at(-1)) - 1;
  const transition = NOVEMBER_CHANGES[regionIndex];
  return transition !== undefined && epochMs >= transition ? 1 : 0;
}

test('UTC offsets parse and format whole-hour and fractional zones', () => {
  assert.equal(parseGmtOffset('GMT'), 0);
  assert.equal(parseGmtOffset('GMT-4'), -4);
  assert.equal(parseGmtOffset('GMT+05:30'), 5.5);
  assert.equal(formatUtcOffset(-3.5), 'UTC-03:30');
  assert.equal(formatUtcOffset(5.75), 'UTC+05:45');
});

test('transition search finds the instant when a region changes offset', () => {
  assert.deepEqual(timezoneTransitionsForYear('Region/A', YEAR, syntheticOffset), [
    MARCH_CHANGE,
  ]);
});

test('time-of-year options group simultaneous changes and split every unique pattern', () => {
  const timezones = [
    'Region/A',
    'Region/B',
    'Region/1',
    'Region/2',
    'Region/3',
    'Region/4',
    'Region/5',
  ];
  const periods = buildTimezonePeriods(timezones, YEAR, syntheticOffset);

  assert.equal(periods.length, 7);
  assert.deepEqual(periods[1].changedTimezones, ['Region/A', 'Region/B']);
  assert.deepEqual(
    periods.slice(2).map(({ startMs }) => startMs),
    NOVEMBER_CHANGES,
  );

  const julyStart = Date.UTC(YEAR, 6, 1);
  const julyEnd = Date.UTC(YEAR, 7, 1) - 1;
  const julyPeriod = periods.find(
    ({ startMs, endMs }) => startMs <= julyStart && endMs > julyStart,
  );
  assert.ok(julyPeriod);
  assert.ok(julyPeriod.startMs <= julyStart);
  assert.ok(julyPeriod.endMs > julyEnd);

  assert.equal(
    formatTimezonePeriod(periods[1].startMs, periods[1].endMs, YEAR),
    'Mar 1, 02:00 UTC → Nov 1, 01:00 UTC',
  );
});

test('offset snapshots return the complete selected global combination', () => {
  const offsets = timezoneOffsetsAt(
    ['Region/A', 'Region/1'],
    NOVEMBER_CHANGES[0],
    syntheticOffset,
  );
  assert.deepEqual(Object.fromEntries(offsets), {
    'Region/A': 1,
    'Region/1': 1,
  });
});

test('pinned timezone rules produce exact seasonal slices without browser data', () => {
  const rules = {
    'Region/A': {
      initialOffsetSeconds: 0,
      initialStandardOffsetSeconds: 0,
      transitions: [
        [MARCH_CHANGE / 1_000, 3_600],
        [NOVEMBER_CHANGES[0] / 1_000, 0],
      ],
      standardTransitions: [],
    },
    'Region/B': {
      initialOffsetSeconds: 7_200,
      initialStandardOffsetSeconds: 7_200,
      transitions: [[MARCH_CHANGE / 1_000, 10_800]],
      standardTransitions: [],
    },
  };
  const periods = buildTimezonePeriodsFromRules(rules, YEAR);

  assert.equal(periods.length, 3);
  assert.deepEqual(periods[1].changedTimezones, ['Region/A', 'Region/B']);
  assert.equal(timezoneRuleOffsetHours(rules['Region/A'], MARCH_CHANGE), 1);
  assert.deepEqual(
    Object.fromEntries(timezoneOffsetsFromRulesAt(rules, MARCH_CHANGE)),
    { 'Region/A': 1, 'Region/B': 3 },
  );
});

test('historical periods group simultaneous official changes and omit recurring DST', () => {
  const startMs = Date.UTC(1970, 0, 1);
  const firstChangeMs = Date.UTC(1990, 0, 1);
  const secondChangeMs = Date.UTC(2011, 11, 30);
  const endMs = Date.UTC(2026, 7, 16);
  const rules = {
    'Region/A': {
      initialOffsetSeconds: 0,
      initialStandardOffsetSeconds: 0,
      transitions: [
        [Date.UTC(1989, 2, 1) / 1_000, 3_600],
        [Date.UTC(1989, 10, 1) / 1_000, 0],
      ],
      standardTransitions: [[firstChangeMs / 1_000, 3_600]],
    },
    'Region/B': {
      initialOffsetSeconds: 7_200,
      initialStandardOffsetSeconds: 7_200,
      transitions: [],
      standardTransitions: [
        [firstChangeMs / 1_000, 10_800],
        [secondChangeMs / 1_000, 14_400],
      ],
    },
  };
  const periods = buildHistoricalTimezonePeriods(rules, startMs, endMs);

  assert.equal(periods.length, 3);
  assert.deepEqual(periods[1].changedTimezones, ['Region/A', 'Region/B']);
  assert.equal(periods[2].startMs, secondChangeMs);
  assert.equal(periods[2].isPresent, true);
  assert.match(periods[2].label, /Dec 30, 2011 → present/);
  assert.equal(timezoneRuleOffsetHours(rules['Region/B'], secondChangeMs, true), 4);
});
