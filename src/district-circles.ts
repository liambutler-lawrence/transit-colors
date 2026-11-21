import type { Coordinate } from './domain.js';

export interface Circle {
  readonly center: Coordinate;
  readonly radius: number;
}

export interface PopulationPoint {
  readonly point: Coordinate;
  readonly population: number;
}

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

interface Bounds {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

interface PopulationNode {
  readonly bounds: Bounds;
  readonly population: number;
  readonly children: readonly PopulationNode[];
  readonly points: readonly PopulationPoint[];
}

const CENTER_SEARCH_TOLERANCE_METERS = 0.25;

function indexPopulation(points: PopulationPoint[]): PopulationNode {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  let population = 0;
  for (const {
    point: [x, y],
    population: count,
  } of points) {
    west = Math.min(west, x);
    south = Math.min(south, y);
    east = Math.max(east, x);
    north = Math.max(north, y);
    population += count;
  }
  const bounds = { west, south, east, north };
  if (points.length <= 32) return { bounds, population, children: [], points };

  const axis = east - west >= north - south ? 0 : 1;
  points.sort((a, b) => a.point[axis] - b.point[axis]);
  const middle = points.length >>> 1;
  const children = [
    indexPopulation(points.slice(0, middle)),
    indexPopulation(points.slice(middle)),
  ];
  return { bounds, population, children, points: [] };
}

// Count the population at most radius away from the region of possible centers.
// This bounds what any individual center in the region can enclose.
function populationNear(
  { bounds, population, children, points }: PopulationNode,
  centers: Bounds,
  radiusSquared: number,
): number {
  const nearestX = Math.max(0, centers.west - bounds.east, bounds.west - centers.east);
  const nearestY = Math.max(
    0,
    centers.south - bounds.north,
    bounds.south - centers.north,
  );
  if (nearestX ** 2 + nearestY ** 2 > radiusSquared) return 0;
  const farthestX = Math.max(0, centers.west - bounds.west, bounds.east - centers.east);
  const farthestY = Math.max(
    0,
    centers.south - bounds.south,
    bounds.north - centers.north,
  );
  if (farthestX ** 2 + farthestY ** 2 <= radiusSquared) return population;

  let covered = 0;
  for (const child of children)
    covered += populationNear(child, centers, radiusSquared);
  for (const {
    point: [x, y],
    population: count,
  } of points) {
    const dx = Math.max(0, centers.west - x, x - centers.east);
    const dy = Math.max(0, centers.south - y, y - centers.north);
    if (dx ** 2 + dy ** 2 <= radiusSquared) covered += count;
  }
  return covered;
}

function findCircle(
  index: PopulationNode,
  target: number,
  radius: number,
): Circle | undefined {
  const radiusSquared = radius ** 2;

  function search(region: Bounds, possible: number): Circle | undefined {
    if (possible < target) return undefined;
    const { west, south, east, north } = region;
    const x = (west + east) / 2;
    const y = (south + north) / 2;
    const point = { west: x, east: x, south: y, north: y };
    if (populationNear(index, point, radiusSquared) >= target) {
      return { center: [x, y], radius };
    }

    const halfDiagonal = Math.hypot(east - x, north - y);
    // Every point counted by the region's bound is within this enlarged disk
    // around its midpoint, even if some have different nearest centers.
    if (halfDiagonal <= CENTER_SEARCH_TOLERANCE_METERS) {
      return { center: [x, y], radius: radius + halfDiagonal };
    }

    const [first, second] =
      east - west >= north - south
        ? [
            { ...region, east: x },
            { ...region, west: x },
          ]
        : [
            { ...region, north: y },
            { ...region, south: y },
          ];
    const firstCount = populationNear(index, first, radiusSquared);
    const secondCount = populationNear(index, second, radiusSquared);
    return firstCount >= secondCount
      ? (search(first, firstCount) ?? search(second, secondCount))
      : (search(second, secondCount) ?? search(first, firstCount));
  }

  // Moving a center into the bounding rectangle cannot increase its distance
  // to any demand point.
  return search(index.bounds, index.population);
}

/** Minimize the disk radius over all possible centers, to within one metre. */
export function minimumPopulationCircle(
  points: readonly PopulationPoint[],
  target: number,
): Circle {
  const all = minimumEnclosingCircle(points.map(({ point }) => point));
  if (target === points.reduce((total, { population }) => total + population, 0))
    return all;
  const index = indexPopulation([...points]);
  let low = 0;
  let best = all;
  while (best.radius - low > 1) {
    const radius = (low + best.radius) / 2;
    const candidate = findCircle(index, target, radius);
    if (candidate) best = candidate;
    else low = radius;
  }
  return best;
}

/** Reuse the population index when testing different centers for the same quota. */
export function fixedCenterPopulationSearch(
  points: readonly PopulationPoint[],
  target: number,
): { readonly bounds: Bounds; readonly circleAt: (center: Coordinate) => Circle } {
  const index = indexPopulation([...points]);
  const { west, east, south, north } = index.bounds;
  return {
    bounds: index.bounds,
    circleAt(center) {
      const [x, y] = center;
      const point = { west: x, east: x, south: y, north: y };
      let low = 0;
      let high = Math.hypot(
        Math.max(Math.abs(x - west), Math.abs(x - east)),
        Math.max(Math.abs(y - south), Math.abs(y - north)),
      );
      while (high - low > 0.01) {
        const radius = (low + high) / 2;
        if (populationNear(index, point, radius ** 2) >= target) high = radius;
        else low = radius;
      }
      return { center, radius: high };
    },
  };
}
