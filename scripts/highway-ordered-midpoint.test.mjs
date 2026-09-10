import assert from 'node:assert/strict';
import test from 'node:test';
import { orderedCarriagewayMidpoints } from './highway-ordered-midpoint.mjs';
import { geodesicDistanceMeters, geodesicMidpoint } from './wgs84-geodesy.mjs';

const coordinate = ([x, y]) => [x / 111_320, y / 110_574];

test('ordered correspondence follows unequal concentric arcs at their radial midpoint', () => {
  const arc = (radius) =>
    Array.from({ length: 151 }, (_, index) => {
      const angle = (index / 150) * Math.PI * 0.8;
      return coordinate([radius * Math.cos(angle), radius * Math.sin(angle)]);
    });
  const first = arc(900);
  const second = arc(1300);
  for (const [a, b] of [
    [first, second],
    [second, first],
  ]) {
    const result = orderedCarriagewayMidpoints(a, b, 2000);
    assert.ok(result);
    for (const [index, pair] of result.pairs.entries()) {
      assert.ok(
        geodesicDistanceMeters(
          result.coordinates[index],
          geodesicMidpoint(pair.first, pair.second),
        ) < 0.02,
      );
      const radius = Math.hypot(
        result.coordinates[index][0] * 111_320,
        result.coordinates[index][1] * 110_574,
      );
      assert.ok(Math.abs(radius - 1100) < 10);
      if (index) {
        assert.ok(pair.firstDistance >= result.pairs[index - 1].firstDistance);
        assert.ok(pair.secondDistance >= result.pairs[index - 1].secondDistance);
        assert.ok(
          geodesicDistanceMeters(
            result.coordinates[index - 1],
            result.coordinates[index],
          ) < 60,
        );
      }
    }
  }
});

test('ordered correspondence cannot traverse an oppositely directed source excursion', () => {
  assert.equal(
    orderedCarriagewayMidpoints(
      [
        [0, 0],
        [4000, 0],
      ].map(coordinate),
      [
        [0, 100],
        [2000, 100],
        [1500, 100],
        [4000, 100],
      ].map(coordinate),
      2000,
    ),
    null,
  );
});
