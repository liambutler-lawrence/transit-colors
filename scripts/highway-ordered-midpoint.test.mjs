import assert from 'node:assert/strict';
import test from 'node:test';
import {
  orderedCarriagewayMidpoints,
  compactMidpointIndices,
} from './highway-ordered-midpoint.mjs';
import { geodesicDistanceMeters, geodesicMidpoint } from './wgs84-geodesy.mjs';

const coordinate = ([x, y]) => [x / 111_320, y / 110_574];

test('long mainlines retain source bends between coarse optimization samples', () => {
  const first = Array.from({ length: 8001 }, (_, i) =>
    coordinate([i * 25, 300 * Math.sin((i * 25 * Math.PI) / 1000)]),
  );
  const second = first.map(([x, y]) => [x, y + 20 / 110574]);
  const result = orderedCarriagewayMidpoints(first, second, { compact: true });
  assert.ok(result.spacing[0] > 100, 'fixture exercises a coarse continental grid');
  const line = result.coordinates.map(([x, y]) => [x * 111320, y * 110574]);
  let segment = 0;
  for (let i = 20; i < first.length - 20; i++) {
    const x = i * 25,
      y = first[i][1] * 110574 + 10;
    while (segment + 1 < line.length - 1 && line[segment + 1][0] < x) segment++;
    const a = line[segment],
      b = line[segment + 1];
    const interpolated = a[1] + ((x - a[0]) / (b[0] - a[0])) * (b[1] - a[1]);
    assert.ok(Math.abs(interpolated - y) < 1, `source bend at ${x} m survives`);
  }
});

test('geometry compaction preserves bends and loops within its 10 cm error bound', () => {
  const straight = Array.from({ length: 1001 }, (_, i) => coordinate([i, 0]));
  assert.deepEqual(compactMidpointIndices(straight), [0, 1000]);
  const meters = Array.from({ length: 1001 }, (_, i) => {
    const angle = (i / 1000) * Math.PI * 2.5;
    return [100 * Math.cos(angle), 100 * Math.sin(angle)];
  });
  const kept = compactMidpointIndices(meters.map(coordinate));
  assert.ok(kept.length < meters.length / 2);
  assert.equal(kept[0], 0);
  assert.equal(kept.at(-1), meters.length - 1);
  for (let k = 1; k < kept.length; k++) {
    const a = meters[kept[k - 1]],
      b = meters[kept[k]];
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    for (let i = kept[k - 1]; i <= kept[k]; i++) {
      const x = meters[i][0] - a[0],
        y = meters[i][1] - a[1];
      const t = Math.max(0, Math.min(1, (x * dx + y * dy) / (dx * dx + dy * dy)));
      assert.ok(Math.hypot(x - t * dx, y - t * dy) <= 0.100001);
    }
  }
});

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
    const result = orderedCarriagewayMidpoints(a, b);
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
        assert.ok(pair.firstPosition >= result.pairs[index - 1].firstPosition);
        assert.ok(pair.secondPosition >= result.pairs[index - 1].secondPosition);
        assert.ok(
          geodesicDistanceMeters(
            result.coordinates[index - 1],
            result.coordinates[index],
          ) < 60,
        );
      }
      for (const [side, position, point] of [
        [a, pair.firstPosition, pair.first],
        [b, pair.secondPosition, pair.second],
      ]) {
        const i = Math.min(side.length - 2, Math.floor(position));
        const expected = side[i].map(
          (v, axis) => v + (side[i + 1][axis] - v) * (position - i),
        );
        assert.ok(geodesicDistanceMeters(expected, point) < 0.001);
      }
    }
  }
});

test('ordered correspondence retains source excursions while source distances stay monotone', () => {
  const first = [
    [0, 0],
    [4000, 0],
  ].map(coordinate);
  const second = [
    [0, 100],
    [2000, 100],
    [1500, 100],
    [4000, 100],
  ].map(coordinate);
  const result = orderedCarriagewayMidpoints(first, second);
  assert.ok(result);
  for (let i = 1; i < result.pairs.length; i++) {
    assert.ok(
      result.pairs[i].firstDistance >= result.pairs[i - 1].firstDistance - 1e-8,
    );
    assert.ok(
      result.pairs[i].secondDistance >= result.pairs[i - 1].secondDistance - 1e-8,
    );
  }
  assert.deepEqual(
    orderedCarriagewayMidpoints(second, first).coordinates,
    result.coordinates,
  );
  assert.deepEqual(
    orderedCarriagewayMidpoints(
      first.toReversed(),
      second.toReversed(),
    ).coordinates.toReversed(),
    result.coordinates,
  );
  const compact = orderedCarriagewayMidpoints(first, second, { compact: true });
  assert.deepEqual(
    orderedCarriagewayMidpoints(second, first, { compact: true }).coordinates,
    compact.coordinates,
  );
  assert.deepEqual(
    orderedCarriagewayMidpoints(first.toReversed(), second.toReversed(), {
      compact: true,
    }).coordinates.toReversed(),
    compact.coordinates,
  );
});
