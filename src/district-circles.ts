import type { Coordinate } from './domain.js';

interface Circle {
  readonly center: Coordinate;
  readonly radius: number;
}

export interface PopulationPoint {
  readonly point: Coordinate;
  readonly population: number;
}

const TAU = 2 * Math.PI;
const EDGE_TOLERANCE_METERS = 1e-6;

export function circleContains(circle: Circle, point: Coordinate): boolean {
  return (
    (point[0] - circle.center[0]) ** 2 + (point[1] - circle.center[1]) ** 2 <=
    (circle.radius + EDGE_TOLERANCE_METERS) ** 2
  );
}

function diameter(a: Coordinate, b: Coordinate): Circle {
  const center: Coordinate = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return { center, radius: Math.hypot(a[0] - center[0], a[1] - center[1]) };
}

function circleThroughPair(
  points: readonly Coordinate[],
  a: Coordinate,
  b: Coordinate,
): Circle {
  const base = diameter(a, b);
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let left: { circle: Circle; offset: number } | undefined;
  let right: typeof left;
  for (const point of points) {
    if (circleContains(base, point)) continue;
    const x = point[0] - a[0];
    const y = point[1] - a[1];
    const cross = dx * y - dy * x;
    if (cross === 0) continue;
    const span = dx * dx + dy * dy;
    const distance = x * x + y * y;
    const cx = (span * y - distance * dy) / (2 * cross);
    const cy = (dx * distance - x * span) / (2 * cross);
    const offset = dx * cy - dy * cx;
    const circle = {
      center: [a[0] + cx, a[1] + cy] satisfies Coordinate,
      radius: Math.hypot(cx, cy),
    };
    if (cross > 0 && (left === undefined || offset > left.offset))
      left = { circle, offset };
    if (cross < 0 && (right === undefined || offset < right.offset))
      right = { circle, offset };
  }
  if (!left || !right) return left?.circle ?? right?.circle ?? base;
  return left.circle.radius < right.circle.radius ? left.circle : right.circle;
}

// Incremental minimum enclosing circle. Shuffle with a fixed seed so that each
// boundary repair is infrequent while the same input always gives the same result.
export function minimumEnclosingCircle(points: readonly Coordinate[]): Circle {
  const ordered = [...points];
  let seed = 0x6a09e667;
  for (let end = ordered.length - 1; end > 0; end -= 1) {
    seed = (Math.imul(1_664_525, seed) + 1_013_904_223) >>> 0;
    const swap = seed % (end + 1);
    const a = ordered[end];
    const b = ordered[swap];
    if (a && b) {
      ordered[end] = b;
      ordered[swap] = a;
    }
  }

  let circle: Circle | undefined;
  const seen: Coordinate[] = [];
  for (const point of ordered) {
    if (!circle || !circleContains(circle, point)) {
      circle = { center: point, radius: 0 };
      for (const [index, other] of seen.entries()) {
        if (circleContains(circle, other)) continue;
        circle =
          circle.radius === 0
            ? diameter(point, other)
            : circleThroughPair(seen.slice(0, index), point, other);
      }
    }
    seen.push(point);
  }
  if (!circle) throw new Error('A district must contain at least one point');
  return circle;
}

function angleAroundCircle(angle: number): number {
  return (angle + TAU) % TAU;
}

// Any feasible disk can move until it touches a covered point. For each such
// point, sweep the possible center bearings. Each neighboring point contributes
// its population over the angles at which it lies within the disk.
function findCenter(
  points: readonly PopulationPoint[],
  target: number,
  radius: number,
): Coordinate | undefined {
  const reachSquared = (2 * radius) ** 2;
  for (const anchor of points) {
    const [x, y] = anchor.point;
    let covered = 0;
    const events: { angle: number; change: number }[] = [];
    for (const other of points) {
      const dx = other.point[0] - x;
      const dy = other.point[1] - y;
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared === 0) {
        covered += other.population;
      } else if (distanceSquared <= reachSquared) {
        const bearing = Math.atan2(dy, dx);
        const span = Math.acos(Math.min(1, Math.sqrt(distanceSquared) / (2 * radius)));
        const start = angleAroundCircle(bearing - span);
        const end = angleAroundCircle(bearing + span);
        if (start > end) covered += other.population;
        events.push(
          { angle: start, change: other.population },
          { angle: end, change: -other.population },
        );
      }
    }
    if (covered >= target) return [x + radius, y];
    events.sort((a, b) => a.angle - b.angle || b.change - a.change);
    for (const { angle, change } of events) {
      covered += change;
      if (covered >= target) {
        return [x + radius * Math.cos(angle), y + radius * Math.sin(angle)];
      }
    }
  }
  return undefined;
}

/** Minimize the disk radius over all possible centers, to within one metre. */
export function minimumPopulationCircle(
  points: readonly PopulationPoint[],
  target: number,
): Circle {
  const all = minimumEnclosingCircle(points.map(({ point }) => point));
  if (target === points.reduce((total, { population }) => total + population, 0))
    return all;
  const coincident = findCenter(points, target, 0);
  if (coincident) return { center: coincident, radius: 0 };
  let low = 0;
  let best = all;
  while (best.radius - low > 1) {
    const radius = (low + best.radius) / 2;
    const center = findCenter(points, target, radius);
    if (center) best = { center, radius };
    else low = radius;
  }
  return best;
}
