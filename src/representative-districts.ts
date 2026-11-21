import { z } from 'zod';

import {
  type Circle,
  circleContains,
  fixedCenterPopulationSearch,
  minimumEnclosingCircle,
  minimumPopulationCircle,
} from './district-circles.js';
import { coordinateSchema, type Coordinate } from './domain.js';
import { localEqualAreaProjection } from './geodesy.js';

const ringSchema = z.array(coordinateSchema).min(4);
const polygonSchema = z.array(ringSchema).min(1);
export const districtGeometrySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('Polygon'), coordinates: polygonSchema }),
  z.object({
    type: z.literal('MultiPolygon'),
    coordinates: z.array(polygonSchema).min(1),
  }),
]);
export const districtRequestSchema = z.object({
  method: z.enum(['knife', 'circles', 'reock-circles']),
  seats: z.int().min(2).max(8),
});

const districtPropertiesSchema = z.object({
  number: z.int().min(1).max(8),
  population: z.int().nonnegative(),
  urbanPopulation: z.int().nonnegative(),
  areaSquareMeters: z.number().nonnegative(),
  radiusMeters: z.number().nonnegative().nullable(),
  reock: z.number().min(0).max(1).nullable(),
});
export const districtPlanSchema = z.object({
  outline: districtGeometrySchema,
  districts: z.object({
    type: z.literal('FeatureCollection'),
    features: z
      .array(
        z.object({
          type: z.literal('Feature'),
          geometry: districtGeometrySchema,
          properties: districtPropertiesSchema,
        }),
      )
      .min(2)
      .max(8),
  }),
  target: z.number().positive(),
  totalPopulation: z.int().positive(),
  totalAreaSquareMeters: z.number().positive(),
});

type Geometry = z.infer<typeof districtGeometrySchema>;
export type DistrictRequest = z.infer<typeof districtRequestSchema>;
export type DistrictPlan = z.infer<typeof districtPlanSchema>;
type DistrictProperties = z.infer<typeof districtPropertiesSchema>;

export type DistrictResponse = { id: number } & (
  { plan: DistrictPlan } | { error: string }
);

interface Block {
  readonly center: Coordinate;
  readonly population: number;
  readonly urbanPopulation: number;
  readonly geometry: Geometry;
}

interface ProjectedBlock {
  readonly index: number;
  readonly point: Coordinate;
  readonly population: number;
  readonly urbanPopulation: number;
  readonly area: number;
  readonly vertices: readonly Coordinate[];
  readonly extremeVertices: readonly Coordinate[];
}

interface DistrictAssignment {
  readonly blocks: readonly number[];
  readonly properties: DistrictProperties;
}

const reockDirections: readonly Coordinate[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
];

function polygons(geometry: Geometry): Coordinate[][][] {
  return geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
}

function totalPopulation(blocks: readonly ProjectedBlock[]): number {
  return blocks.reduce((sum, block) => sum + block.population, 0);
}

function ringArea(ring: readonly Coordinate[]): number {
  let twiceArea = 0;
  for (let index = 1; index < ring.length; index += 1) {
    const from = ring[index - 1];
    const to = ring[index];
    if (from && to) twiceArea += from[0] * to[1] - to[0] * from[1];
  }
  return Math.abs(twiceArea) / 2;
}

// Interior vertices of a block's convex hull cannot affect the Reock circle.
function hullVertices(points: Coordinate[]): Coordinate[] {
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  function chain(ordered: Iterable<Coordinate>): Coordinate[] {
    const result: Coordinate[] = [];
    for (const point of ordered) {
      let previous = result.at(-1);
      let before = result.at(-2);
      while (
        before &&
        previous &&
        (previous[0] - before[0]) * (point[1] - before[1]) <=
          (previous[1] - before[1]) * (point[0] - before[0])
      ) {
        result.pop();
        previous = result.at(-1);
        before = result.at(-2);
      }
      result.push(point);
    }
    return result;
  }
  const lower = chain(points);
  const upper = chain(points.reverse());
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function extremeVertex(points: Iterable<Coordinate>, [dx, dy]: Coordinate): Coordinate {
  let furthest: Coordinate | undefined;
  let maximum = -Infinity;
  for (const point of points) {
    const distance = point[0] * dx + point[1] * dy;
    if (distance > maximum) {
      furthest = point;
      maximum = distance;
    }
  }
  if (!furthest) throw new Error('A district must contain at least one vertex');
  return furthest;
}

export function prepareDistrictBlocks(
  blocks: Iterable<Block>,
  origin: Coordinate = [-72.7, 41.6],
): ProjectedBlock[] {
  const { project } = localEqualAreaProjection(origin);
  const prepared: ProjectedBlock[] = [];
  for (const { center, population, urbanPopulation, geometry } of blocks) {
    const vertices: Coordinate[] = [];
    let area = 0;
    for (const polygon of polygons(geometry)) {
      for (const [ringIndex, ring] of polygon.entries()) {
        const projected = ring.map(project);
        const size = ringArea(projected);
        if (ringIndex === 0) {
          for (let index = 0; index < projected.length - 1; index += 1) {
            const vertex = projected[index];
            if (vertex) vertices.push(vertex);
          }
          area += size;
        } else {
          area -= size;
        }
      }
    }
    const hull = hullVertices(vertices);
    prepared.push({
      index: prepared.length,
      point: project(center),
      population,
      urbanPopulation,
      vertices: hull,
      extremeVertices: reockDirections.map((direction) =>
        extremeVertex(hull, direction),
      ),
      area,
    });
  }
  return prepared;
}

export function prepareKnifeOrders(blocks: readonly ProjectedBlock[]): Uint32Array[] {
  const orders: Uint32Array[] = [];
  const projections = new Float64Array(blocks.length);
  for (let angle = 0; angle < 360; angle += 10) {
    const radians = (angle * Math.PI) / 180;
    const east = Math.sin(radians);
    const north = Math.cos(radians);
    for (const block of blocks) {
      projections[block.index] = block.point[0] * east + block.point[1] * north;
    }
    orders.push(
      Uint32Array.from(blocks, ({ index }) => index).sort(
        (a, b) => (projections[b] ?? 0) - (projections[a] ?? 0),
      ),
    );
  }
  return orders;
}

function knifeCut(
  blocks: readonly ProjectedBlock[],
  remaining: readonly ProjectedBlock[],
  orders: readonly Uint32Array[],
  assigned: Uint8Array,
  target: number,
  seatsLeft: number,
): ProjectedBlock[] {
  let bestScore = 0;
  let best: ProjectedBlock[] = [];
  const populated = remaining.filter(({ population }) => population > 0).length;
  for (const ordered of orders) {
    const slice: ProjectedBlock[] = [];
    let population = 0;
    let populatedLeft = populated;
    for (const index of ordered) {
      const block = blocks[index];
      if (!block || assigned[index]) continue;
      if (
        block.population > 0 &&
        population > 0 &&
        (populatedLeft === seatsLeft - 1 ||
          Math.abs(population + block.population - target) >
            Math.abs(population - target))
      )
        break;
      slice.push(block);
      population += block.population;
      if (block.population > 0) populatedLeft -= 1;
      if (population >= target) break;
    }
    const score = candidateReockScore(slice, bestScore);
    if (score !== undefined && (!best.length || score > bestScore)) {
      bestScore = score;
      best = slice;
    }
  }
  return best;
}

function districtArea(blocks: readonly ProjectedBlock[]): number {
  return blocks.reduce((sum, block) => sum + block.area, 0);
}

function reockScore(blocks: readonly ProjectedBlock[]): number {
  const score = candidateReockScore(blocks, 0);
  if (score === undefined) throw new Error('Could not compute a district Reock score');
  return score;
}

function candidateReockScore(
  blocks: readonly ProjectedBlock[],
  scoreToBeat: number,
): number | undefined {
  const area = districtArea(blocks);
  const maximumRadius =
    scoreToBeat > 0 ? Math.sqrt(area / (Math.PI * scoreToBeat)) : Infinity;
  const seeds = reockDirections.map((direction, index) => {
    function* vertices(): Iterable<Coordinate> {
      for (const block of blocks) {
        const vertex = block.extremeVertices[index];
        if (vertex) yield vertex;
      }
    }
    return extremeVertex(vertices(), direction);
  });
  // Each circle encloses a subset of real district vertices and therefore
  // bounds the best possible score. Add constraints only where needed.
  let enclosing = minimumEnclosingCircle(seeds);
  while (enclosing.radius <= maximumRadius + 1e-6) {
    let farthest: Coordinate | undefined;
    let farthestSquared = (enclosing.radius + 1e-6) ** 2;
    const [x, y] = enclosing.center;
    for (const { vertices } of blocks) {
      for (const vertex of vertices) {
        const distance = (vertex[0] - x) ** 2 + (vertex[1] - y) ** 2;
        if (distance > farthestSquared) {
          farthest = vertex;
          farthestSquared = distance;
        }
      }
    }
    if (!farthest) {
      return enclosing.radius
        ? Math.min(1, area / (Math.PI * enclosing.radius ** 2))
        : 0;
    }
    seeds.push(farthest);
    enclosing = minimumEnclosingCircle(seeds);
  }
  return undefined;
}

interface CircleCut {
  readonly circle: Circle;
  readonly blocks: ProjectedBlock[];
  readonly score: number;
}

function reockCircleCut(
  remaining: readonly ProjectedBlock[],
  populated: readonly ProjectedBlock[],
  quota: number,
  smallest: Circle,
): CircleCut {
  const { bounds, circleAt } = fixedCenterPopulationSearch(populated, quota);
  const divisions = 12;
  let stepX = (bounds.east - bounds.west) / divisions;
  let stepY = (bounds.north - bounds.south) / divisions;
  const blocks = remaining.filter(({ point }) => circleContains(smallest, point));
  let best: CircleCut = { circle: smallest, blocks, score: reockScore(blocks) };

  function consider(center: Coordinate): void {
    const circle = circleAt(center);
    const assigned = remaining.filter(({ point }) => circleContains(circle, point));
    const score = candidateReockScore(assigned, best.score);
    if (score === undefined) return;
    if (
      score > best.score ||
      (score === best.score && circle.radius < best.circle.radius)
    ) {
      best = { circle, blocks: assigned, score };
    }
  }

  // Include centers just outside the populated bounds to test cuts along the edges.
  for (let column = -1; column <= divisions + 1; column += 1) {
    for (let row = -1; row <= divisions + 1; row += 1) {
      consider([bounds.west + column * stepX, bounds.south + row * stepY]);
    }
  }
  for (let level = 0; level < 4; level += 1) {
    stepX /= 2;
    stepY /= 2;
    const [x, y] = best.circle.center;
    for (let column = -1; column <= 1; column += 1) {
      for (let row = -1; row <= 1; row += 1) {
        if (column || row) consider([x + column * stepX, y + row * stepY]);
      }
    }
  }
  return best;
}

function knifeDistricts(
  blocks: readonly ProjectedBlock[],
  orders: readonly Uint32Array[],
  seats: number,
  target: number,
): DistrictAssignment[] {
  let remaining = [...blocks];
  const assignment = new Uint8Array(blocks.length);
  const districts: DistrictAssignment[] = [];
  for (let number = 1; number <= seats; number += 1) {
    const assigned =
      number === seats
        ? remaining
        : knifeCut(blocks, remaining, orders, assignment, target, seats - number + 1);
    districts.push({
      blocks: assigned.map(({ index }) => index),
      properties: {
        number,
        population: totalPopulation(assigned),
        urbanPopulation: assigned.reduce(
          (sum, block) => sum + block.urbanPopulation,
          0,
        ),
        areaSquareMeters: districtArea(assigned),
        radiusMeters: null,
        reock: reockScore(assigned),
      },
    });
    for (const { index } of assigned) assignment[index] = 1;
    remaining = remaining.filter(({ index }) => !assignment[index]);
  }
  return districts;
}

function circleDistricts(
  blocks: readonly ProjectedBlock[],
  seats: number,
  target: number,
  useReock: boolean,
): DistrictAssignment[] {
  let remaining = [...blocks];
  const districts: DistrictAssignment[] = [];
  for (let number = 1; number <= seats; number += 1) {
    const isLast = number === seats;
    const quota = isLast ? totalPopulation(remaining) : Math.ceil(target);
    const populated = remaining.filter(({ population }) => population > 0);
    const smallest = minimumPopulationCircle(populated, quota);
    const compact =
      useReock && !isLast
        ? reockCircleCut(remaining, populated, quota, smallest)
        : undefined;
    const circle = compact?.circle ?? smallest;
    const assigned = isLast
      ? remaining
      : (compact?.blocks ??
        remaining.filter(({ point }) => circleContains(circle, point)));
    const population = totalPopulation(assigned);
    if (population < quota)
      throw new Error('The circle did not reach its population target');
    districts.push({
      blocks: assigned.map(({ index }) => index),
      properties: {
        number,
        population,
        urbanPopulation: assigned.reduce(
          (sum, block) => sum + block.urbanPopulation,
          0,
        ),
        areaSquareMeters: Math.PI * circle.radius ** 2,
        radiusMeters: circle.radius,
        reock: useReock ? (compact?.score ?? reockScore(assigned)) : null,
      },
    });
    const assignedBlocks = new Set(assigned);
    remaining = remaining.filter((block) => !assignedBlocks.has(block));
  }
  return districts;
}

export function calculateDistrictAssignments(
  blocks: readonly ProjectedBlock[],
  { method, seats }: DistrictRequest,
  knifeOrders?: readonly Uint32Array[],
): DistrictAssignment[] {
  const target = totalPopulation(blocks) / seats;
  return method === 'knife'
    ? knifeDistricts(blocks, knifeOrders ?? prepareKnifeOrders(blocks), seats, target)
    : circleDistricts(blocks, seats, target, method === 'reock-circles');
}
