import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTimezoneRule } from './tzif.mjs';

const DAY = 24 * 60 * 60;

function parsedRule(types, transitions) {
  return {
    types,
    transitions: transitions.map(([atSeconds, typeIndex]) => ({
      atSeconds,
      typeIndex,
    })),
  };
}

test('recurring seasonal reversals do not become historical standard changes', () => {
  const parsed = parsedRule(
    [
      { offsetSeconds: 0, isDst: false },
      { offsetSeconds: 3600, isDst: true },
    ],
    [
      [90 * DAY, 1],
      [300 * DAY, 0],
      [455 * DAY, 1],
      [665 * DAY, 0],
    ],
  );
  const rule = buildTimezoneRule(parsed, 0, 800 * DAY);

  assert.deepEqual(rule.transitions, [
    [90 * DAY, 3600],
    [300 * DAY, 0],
    [455 * DAY, 3600],
    [665 * DAY, 0],
  ]);
  assert.deepEqual(rule.standardTransitions, []);
});

test('one-off standard offset moves create historical boundaries', () => {
  const parsed = parsedRule(
    [
      { offsetSeconds: 0, isDst: false },
      { offsetSeconds: 3600, isDst: false },
      { offsetSeconds: 7200, isDst: true },
    ],
    [
      [100 * DAY, 1],
      [200 * DAY, 2],
      [300 * DAY, 1],
    ],
  );
  const rule = buildTimezoneRule(parsed, 0, 400 * DAY);

  assert.deepEqual(rule.standardTransitions, [[100 * DAY, 3600]]);
});

test('adopting a seasonal offset permanently is a historical change even without a clock jump', () => {
  const parsed = parsedRule(
    [
      { offsetSeconds: -7 * 3600, isDst: false },
      { offsetSeconds: -6 * 3600, isDst: true },
      { offsetSeconds: -6 * 3600, isDst: false },
    ],
    [
      [70 * DAY, 1],
      [300 * DAY, 2],
    ],
  );
  const rule = buildTimezoneRule(parsed, 0, 400 * DAY);

  assert.deepEqual(rule.standardTransitions, [[300 * DAY, -6 * 3600]]);
});
