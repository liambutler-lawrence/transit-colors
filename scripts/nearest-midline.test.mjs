import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nearestMidline,
  nearest,
  segmentIndex,
} from '../src/midpoint-comparison/nearest-midline.mjs';

test('nearest matches use segment interiors and permit any tangent angle', () => {
  const hit = nearest(
    [3, 4],
    segmentIndex([
      [
        [0, 0],
        [10, 0],
      ],
    ]),
  );
  assert.deepEqual(hit.point, [3, 0]);
  assert.equal(hit.squared, 16);
  const crossing = nearest(
    [3, 4],
    segmentIndex([
      [
        [3, -10],
        [3, 10],
      ],
    ]),
  );
  assert.deepEqual(crossing.point, [3, 4]);
});
test('samples both sides and reproduces the exact midpoint of parallel roads', () => {
  const result = nearestMidline(
    [
      [0, 0],
      [100, 0],
    ],
    [
      [0, 20],
      [100, 20],
    ],
    7,
  );
  assert.equal(result.count, 32);
  assert.ok(result.coordinates.every((p) => p[1] === 10));
  assert.deepEqual(result.coordinates[0], [0, 10]);
  assert.deepEqual(result.coordinates.at(-1), [100, 10]);
  assert.equal(result.reversals, 0);
});
test('combined ordering is symmetric when the two sources are swapped', () => {
  const a = [
      [0, 0],
      [30, 15],
      [100, 0],
    ],
    b = [
      [0, 40],
      [80, 80],
      [100, 40],
    ];
  assert.deepEqual(
    nearestMidline(a, b, 2).coordinates,
    nearestMidline(b, a, 2).coordinates,
  );
});
test('does not impose endpoint attachment or tangent constraints', () => {
  const result = nearestMidline(
    [
      [0, 0],
      [100, 0],
    ],
    [
      [20, 20],
      [80, 20],
    ],
    5,
  );
  assert.deepEqual(result.first[0], [10, 10]);
  assert.deepEqual(result.first.at(-1), [90, 10]);
  assert.deepEqual(result.second[0], [20, 10]);
});
test('segment index agrees with exhaustive nearest-segment search', () => {
  const points = Array.from({ length: 70 }, (_, i) => [i * 3, 20 * Math.sin(i / 5)]),
    index = segmentIndex([points]);
  for (let i = 0; i < 100; i++) {
    const p = [i * 2.17 - 5, 30 * Math.cos(i)];
    const expected = Math.min(
      ...points
        .slice(1)
        .map((b, j) => nearest(p, segmentIndex([[points[j], b]])).squared),
    );
    assert.ok(Math.abs(nearest(p, index).squared - expected) < 1e-9);
  }
});
