import polygonClipping from 'polygon-clipping';
import type { FeatureCollection } from 'geojson';
import { z } from 'zod';

import {
  circleContains,
  minimumEnclosingCircle,
  minimumPopulationCircle,
} from './district-circles.js';
import { coordinateSchema, type Coordinate } from './domain.js';
import { localEqualAreaProjection } from './geodesy.js';

const ringSchema = z.array(coordinateSchema).min(4);
const polygonSchema = z.array(ringSchema).min(1);
const districtGeometrySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('Polygon'), coordinates: polygonSchema }),
  z.object({
    type: z.literal('MultiPolygon'),
    coordinates: z.array(polygonSchema).min(1),
  }),
]);
const tractSchema = z
  .object({
    center: coordinateSchema,
    population: z.int().nonnegative(),
    urbanPopulation: z.int().nonnegative(),
    geometry: districtGeometrySchema,
  })
  .refine((tract) => tract.urbanPopulation <= tract.population);
export const districtStudySchema = z.object({
  outline: districtGeometrySchema,
  tracts: z.array(tractSchema).min(2),
});
export const districtRequestSchema = z.object({
  method: z.enum(['knife', 'circles']),
  seats: z.int().min(2).max(8),
});

type Geometry = z.infer<typeof districtGeometrySchema>;
type Tract = z.infer<typeof tractSchema>;
type Study = z.infer<typeof districtStudySchema>;
export type DistrictRequest = z.infer<typeof districtRequestSchema>;

export interface DistrictProperties {
  readonly number: number;
  readonly population: number;
  readonly urbanPopulation: number;
  readonly areaSquareMeters: number;
  readonly radiusMeters: number | null;
  readonly reock: number | null;
}

export interface DistrictPlan {
  readonly outline: Geometry;
  readonly districts: FeatureCollection<Geometry, DistrictProperties>;
  readonly target: number;
  readonly totalPopulation: number;
  readonly totalAreaSquareMeters: number;
}

export type DistrictResponse = { id: number } & (
  { plan: DistrictPlan } | { error: string }
);

interface ProjectedTract extends Tract {
  readonly point: Coordinate;
  readonly area: number;
  readonly vertices: readonly Coordinate[];
}

const { project, unproject } = localEqualAreaProjection([-72.7, 41.6]);
const CIRCLE_SIDES = 180;

function polygons(geometry: Geometry): Coordinate[][][] {
  return geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
}

function totalPopulation(tracts: readonly Tract[]): number {
  return tracts.reduce((sum, tract) => sum + tract.population, 0);
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

function projectTract(tract: Tract): ProjectedTract {
  const vertices: Coordinate[] = [];
  let area = 0;
  for (const polygon of polygons(tract.geometry)) {
    for (const [index, ring] of polygon.entries()) {
      const projected = ring.map(project);
      const size = ringArea(projected);
      if (index === 0) {
        vertices.push(...projected.slice(0, -1));
        area += size;
      } else {
        area -= size;
      }
    }
  }
  return { ...tract, point: project(tract.center), vertices, area };
}

function knifeCut(
  remaining: readonly ProjectedTract[],
  target: number,
  seatsLeft: number,
): ProjectedTract[] {
  let bestScore = -1;
  let best: ProjectedTract[] = [];
  const populated = remaining.filter(({ population }) => population > 0).length;
  for (let angle = 0; angle < 360; angle += 10) {
    const radians = (angle * Math.PI) / 180;
    const east = Math.sin(radians);
    const north = Math.cos(radians);
    const ordered = remaining
      .map((tract) => ({
        tract,
        projection: tract.point[0] * east + tract.point[1] * north,
      }))
      .sort((a, b) => b.projection - a.projection);
    const slice: ProjectedTract[] = [];
    let population = 0;
    let populatedLeft = populated;
    for (const { tract } of ordered) {
      if (
        tract.population > 0 &&
        population > 0 &&
        (populatedLeft === seatsLeft - 1 ||
          Math.abs(population + tract.population - target) >
            Math.abs(population - target))
      )
        break;
      slice.push(tract);
      population += tract.population;
      if (tract.population > 0) populatedLeft -= 1;
      if (population >= target) break;
    }
    const score = reockScore(slice);
    if (score > bestScore) {
      bestScore = score;
      best = slice;
    }
  }
  return best;
}

function knifeArea(tracts: readonly ProjectedTract[]): number {
  return tracts.reduce((sum, tract) => sum + tract.area, 0);
}

function reockScore(tracts: readonly ProjectedTract[]): number {
  const { radius } = minimumEnclosingCircle(tracts.flatMap((tract) => tract.vertices));
  return Math.min(1, knifeArea(tracts) / (Math.PI * radius ** 2));
}

function knifeDistricts(
  tracts: readonly Tract[],
  seats: number,
  target: number,
): DistrictPlan['districts'] {
  let remaining = tracts.map(projectTract);
  const features: DistrictPlan['districts']['features'] = [];
  for (let number = 1; number <= seats; number += 1) {
    const assigned =
      number === seats ? remaining : knifeCut(remaining, target, seats - number + 1);
    const [first, ...rest] = assigned;
    if (!first) throw new Error('The moving knife returned an empty district');
    const coordinates = polygonClipping.union(
      first.geometry.coordinates,
      ...rest.map((tract) => tract.geometry.coordinates),
    );
    features.push({
      type: 'Feature',
      geometry: { type: 'MultiPolygon', coordinates },
      properties: {
        number,
        population: totalPopulation(assigned),
        urbanPopulation: assigned.reduce(
          (sum, tract) => sum + tract.urbanPopulation,
          0,
        ),
        areaSquareMeters: knifeArea(assigned),
        radiusMeters: null,
        reock: reockScore(assigned),
      },
    });
    const assignedTracts = new Set(assigned);
    remaining = remaining.filter((tract) => !assignedTracts.has(tract));
  }
  return { type: 'FeatureCollection', features };
}

function circleDistricts(
  tracts: readonly Tract[],
  seats: number,
  target: number,
): DistrictPlan['districts'] {
  let remaining = tracts
    .filter(({ population }) => population > 0)
    .map((tract) => ({ ...tract, point: project(tract.center) }));
  const features: DistrictPlan['districts']['features'] = [];
  for (let number = 1; number <= seats; number += 1) {
    const quota = number === seats ? totalPopulation(remaining) : Math.ceil(target);
    const circle = minimumPopulationCircle(remaining, quota);
    const assigned = remaining.filter(({ point }) => circleContains(circle, point));
    const population = totalPopulation(assigned);
    if (population < quota)
      throw new Error('The circle did not reach its population target');
    const ring = Array.from({ length: CIRCLE_SIDES + 1 }, (_, index) => {
      const angle = ((index % CIRCLE_SIDES) * 2 * Math.PI) / CIRCLE_SIDES;
      return unproject([
        circle.center[0] + circle.radius * Math.cos(angle),
        circle.center[1] + circle.radius * Math.sin(angle),
      ]);
    });
    features.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: {
        number,
        population,
        urbanPopulation: assigned.reduce(
          (sum, tract) => sum + tract.urbanPopulation,
          0,
        ),
        areaSquareMeters: Math.PI * circle.radius ** 2,
        radiusMeters: circle.radius,
        reock: null,
      },
    });
    const assignedTracts = new Set(assigned);
    remaining = remaining.filter((tract) => !assignedTracts.has(tract));
  }
  return { type: 'FeatureCollection', features };
}

export function calculateDistrictPlan(
  study: Study,
  { method, seats }: DistrictRequest,
): DistrictPlan {
  const population = totalPopulation(study.tracts);
  const target = population / seats;
  const districts =
    method === 'knife'
      ? knifeDistricts(study.tracts, seats, target)
      : circleDistricts(study.tracts, seats, target);
  return {
    outline: study.outline,
    districts,
    target,
    totalPopulation: population,
    totalAreaSquareMeters: districts.features.reduce(
      (total, { properties }) => total + properties.areaSquareMeters,
      0,
    ),
  };
}
