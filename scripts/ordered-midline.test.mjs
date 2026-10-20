import test from 'node:test';
import assert from 'node:assert/strict';
import { orderedMidline } from './ordered-midline.mjs';
test('parallel sides yield the central line', () => {
  const r = orderedMidline(
    [
      [0, 0],
      [20, 0],
    ],
    [
      [0, 10],
      [20, 10],
    ],
    1,
  );
  assert.equal(r.matches.length, 21);
  assert.ok(r.coordinates.every((p) => p[1] === 5));
  assert.ok(r.matches.every((p) => p.i === p.j));
});
test('loop and unequal sides are covered without source-index jumps', () => {
  const r = orderedMidline(
    [
      [0, 0],
      [5, 0],
      [5, 5],
      [0, 5],
      [0, 0],
      [10, 0],
    ],
    [
      [0, 10],
      [10, 10],
    ],
    1,
    10,
  );
  assert.deepEqual(r.matches[0].points, [
    [0, 0],
    [0, 10],
  ]);
  assert.deepEqual(r.matches.at(-1).points, [
    [10, 0],
    [10, 10],
  ]);
  for (let k = 1; k < r.matches.length; k++) {
    const a = r.matches[k - 1],
      b = r.matches[k];
    assert.ok(b.i - a.i >= 0 && b.i - a.i <= 1);
    assert.ok(b.j - a.j >= 0 && b.j - a.j <= 1);
    assert.ok(b.i > a.i || b.j > a.j);
  }
});
test('dynamic programming agrees with exhaustive small-grid paths', () => {
  const a = [
      [0, 0],
      [2, 0],
      [4, 0],
    ],
    b = [
      [0, 3],
      [0, 5],
      [0, 7],
    ],
    penalty = 3;
  function visit(i, j, cost) {
    if (i === 2 && j === 2) return cost;
    let best = Infinity;
    for (const [di, dj] of [
      [1, 1],
      [1, 0],
      [0, 1],
    ]) {
      const x = i + di,
        y = j + dj;
      if (x > 2 || y > 2) continue;
      const advance = di + dj;
      const gap = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
      const dx = a[x][0] - b[y][0] - a[i][0] + b[j][0];
      const dy = a[x][1] - b[y][1] - a[i][1] + b[j][1];
      best = Math.min(
        best,
        visit(
          x,
          y,
          cost +
            ((gap(a[x], b[y]) + gap(a[i], b[j])) / 2) * advance +
            penalty * (dx * dx + dy * dy + (!di || !dj ? advance * advance : 0)),
        ),
      );
    }
    return best;
  }
  assert.ok(Math.abs(orderedMidline(a, b, 2, penalty).cost - visit(0, 0, 0)) < 1e-9);
});
