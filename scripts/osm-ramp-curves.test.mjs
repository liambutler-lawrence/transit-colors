import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { hasProperSelfIntersection } from './highway-cycle.mjs';
import { averageReciprocalPathCoordinates } from './osm-highway-network.mjs';
import { geodesicDistanceMeters } from './wgs84-geodesy.mjs';

const { cases } = JSON.parse(
  readFileSync(
    new URL('./fixtures/ramp-curve-correspondence.json', import.meta.url),
    'utf8',
  ),
);

function average(fixture) {
  return averageReciprocalPathCoordinates(
    fixture.firstCoordinates,
    fixture.secondCoordinates,
    fixture.startCoordinate,
    fixture.endCoordinate,
  );
}

function maximumTurnDegrees(coordinates) {
  let maximum = 0;
  for (let index = 1; index < coordinates.length - 1; index += 1) {
    const [before, point, after] = coordinates.slice(index - 1, index + 2);
    const scale = Math.cos((point[1] * Math.PI) / 180);
    const incoming = [(point[0] - before[0]) * scale, point[1] - before[1]];
    const outgoing = [(after[0] - point[0]) * scale, after[1] - point[1]];
    const cosine =
      (incoming[0] * outgoing[0] + incoming[1] * outgoing[1]) /
      (Math.hypot(...incoming) * Math.hypot(...outgoing));
    maximum = Math.max(
      maximum,
      (Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI,
    );
  }
  return maximum;
}

test('Sugarloaf eastbound midpoint follows the source bend without a tangent-cutoff kink', () => {
  const fixture = cases['sugarloaf-east'];
  const coordinates = average(fixture);
  assert.deepEqual(coordinates[0], fixture.startCoordinate);
  assert.deepEqual(coordinates.at(-1), fixture.endCoordinate);
  assert.equal(hasProperSelfIntersection(coordinates), false);
  // The old correspondence jumped 132 metres in one step and turned 56 degrees.
  assert.ok(maximumTurnDegrees(fixture.beforeCoordinates) > 50);
  assert.ok(maximumTurnDegrees(coordinates) < 20);
  for (let index = 1; index < coordinates.length; index += 1) {
    assert.ok(geodesicDistanceMeters(coordinates[index - 1], coordinates[index]) < 30);
  }
  assert.ok(
    coordinates.some(
      (coordinate) => geodesicDistanceMeters(coordinate, [-83.9068282, 33.9743684]) < 5,
    ),
  );
});

test('ramp bend correspondence is independent of input order and travel orientation', () => {
  const fixture = cases['sugarloaf-east'];
  const expected = average(fixture);
  assert.deepEqual(
    average({
      ...fixture,
      firstCoordinates: fixture.secondCoordinates,
      secondCoordinates: fixture.firstCoordinates,
    }),
    expected,
  );
  assert.deepEqual(
    average({
      firstCoordinates: fixture.firstCoordinates.toReversed(),
      secondCoordinates: fixture.secondCoordinates.toReversed(),
      startCoordinate: fixture.endCoordinate,
      endCoordinate: fixture.startCoordinate,
    }).toReversed(),
    expected,
  );
});

test('a skipped reverse-facing loop is not inserted into the other ramp movement', () => {
  const fixture = cases['sugarloaf-west'];
  assert.deepEqual(average(fixture), fixture.beforeCoordinates);
});

test('continuing correspondence cannot introduce a sharper corner at its attachment', () => {
  const fixture = cases['seattle'];
  // An otherwise smooth candidate develops a hook at the endpoint; retain its
  // original source correspondence when the complete join is not an improvement.
  assert.deepEqual(average(fixture), fixture.beforeCoordinates);
});

test('a repaired bend cannot cross another section of the complete ramp', () => {
  const fixture = cases['crossing-loop'];
  const coordinates = average(fixture);
  assert.equal(hasProperSelfIntersection(coordinates), false);
  assert.deepEqual(coordinates, fixture.beforeCoordinates);
});

test('projected mainline attachments do not retain a midpoint behind the ramp start', () => {
  const fixtures = JSON.parse(
    readFileSync(
      new URL('./fixtures/ramp-attachment-overhangs.json', import.meta.url),
      'utf8',
    ),
  ).cases;
  for (const fixture of fixtures) {
    const coordinates = average(fixture);
    assert.deepEqual(coordinates[0], fixture.startCoordinate);
    assert.deepEqual(coordinates.at(-1), fixture.endCoordinate);
    assert.equal(hasProperSelfIntersection(coordinates), false);
    assert.ok(maximumTurnDegrees(coordinates.slice(0, 3)) < 90, fixture.name);
    assert.ok(
      maximumTurnDegrees(coordinates) <
        maximumTurnDegrees(fixture.beforeCoordinates) - 40,
      `${fixture.name} improves the complete curve, including its attachment`,
    );
  }
});
