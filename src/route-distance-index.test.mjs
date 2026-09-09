import assert from 'node:assert/strict';
import test from 'node:test';

import { RouteDistanceIndex } from './route-distance-index.ts';

test('indexed distance preserves tight bends, repeated vertices, and cutoff distances', () => {
  const points = Array.from({ length: 100 }, (_, i) => ({ x: i, y: 10 * Math.sin(i) }));
  points.splice(50, 0, points[49]);
  const index = new RouteDistanceIndex(points);
  for (let x = -5; x <= 105; x += 2.5) {
    for (let y = -15; y <= 15; y += 5) {
      let expected = 25;
      for (let i = 1; i < points.length; i += 1) {
        const a = points[i - 1];
        const b = points[i];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const t =
          dx === 0 && dy === 0
            ? 0
            : Math.max(
                0,
                Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy)),
              );
        expected = Math.min(expected, Math.hypot(x - a.x - t * dx, y - a.y - t * dy));
      }
      assert.ok(Math.abs(index.distance({ x, y }, 25) - expected) < 1e-10);
    }
  }
});
