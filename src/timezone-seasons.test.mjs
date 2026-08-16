import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTimezonePeriods,
  formatTimezonePeriod,
  formatUtcOffset,
  parseGmtOffset,
  timezoneOffsetsAt,
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
