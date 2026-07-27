import * as polygonClipping from 'polygon-clipping';
import type { MultiPolygon } from 'polygon-clipping';

import type { Coordinate, LandmassArea } from './domain.js';
import { polygonAreaSquareMeters } from './circumference.js';
import {
  geodesicPolygonAreaSquareMeters,
  localEqualAreaProjection,
} from './geodesy.js';

export interface LandmassCoverage {
  readonly area_m2: number;
  readonly id: string;
  readonly insideAreaSquareMeters: number;
  readonly label: string;
  readonly mask: Coordinate[][][] | null;
  readonly outsideAreaSquareMeters: number;
}

function projectedMultiPolygonAreaSquareMeters(
  multiPolygon: MultiPolygon,
  unproject: (coordinate: Coordinate) => Coordinate,
): number {
  return multiPolygon.reduce(
    (total, polygon) =>
      total +
      polygon.reduce(
        (polygonTotal, ring, ringIndex) =>
          polygonTotal +
          geodesicPolygonAreaSquareMeters(ring.map(unproject)) *
            (ringIndex === 0 ? 1 : -1),
        0,
      ),
    0,
  );
}

function routeCenter(coordinates: readonly Coordinate[]): Coordinate {
  const bounds = coordinates.reduce(
    (result, [longitude, latitude]) => ({
      east: Math.max(result.east, longitude),
      north: Math.max(result.north, latitude),
      south: Math.min(result.south, latitude),
      west: Math.min(result.west, longitude),
    }),
    {
      east: Number.NEGATIVE_INFINITY,
      north: Number.NEGATIVE_INFINITY,
      south: Number.POSITIVE_INFINITY,
      west: Number.POSITIVE_INFINITY,
    },
  );
  return [(bounds.west + bounds.east) / 2, (bounds.south + bounds.north) / 2];
}

function normalizedLandmasses(area: LandmassArea): LandmassArea['landmasses'] {
  return area.landmasses;
}

/**
 * Intersects the route polygon with every configured landmass in a local WGS84
 * equal-area coordinate system. The result keeps route-contained land and
 * coastward land separate for each touched landmass, instead of subtracting the
 * entire route area from one arbitrarily chosen mask.
 */
export function calculateLandmassCoverage(
  routeCoordinates: Coordinate[],
  area: LandmassArea,
  clipping: typeof polygonClipping = polygonClipping,
): LandmassCoverage[] {
  if (routeCoordinates.length < 4) {
    return [];
  }
  const { project, unproject } = localEqualAreaProjection(
    routeCenter(routeCoordinates),
  );
  const projectedRoute = routeCoordinates.map(project);

  return normalizedLandmasses(area).flatMap((landmass) => {
    let insideAreaSquareMeters: number;
    if (landmass.mask == null) {
      insideAreaSquareMeters = polygonAreaSquareMeters(routeCoordinates);
    } else {
      const projectedMask = landmass.mask.map((polygon) =>
        polygon.map((ring) => ring.map(project)),
      );
      const intersection = clipping.intersection([projectedRoute], projectedMask);
      insideAreaSquareMeters = projectedMultiPolygonAreaSquareMeters(
        intersection,
        unproject,
      );
    }

    if (insideAreaSquareMeters <= 1) return [];
    return [
      {
        ...landmass,
        insideAreaSquareMeters,
        outsideAreaSquareMeters: Math.max(0, landmass.area_m2 - insideAreaSquareMeters),
      },
    ];
  });
}

export function combinedLandmassArea(
  coverage: readonly LandmassCoverage[],
  field: 'insideAreaSquareMeters' | 'outsideAreaSquareMeters',
): number {
  return coverage.reduce((total, landmass) => total + (landmass[field] ?? 0), 0);
}
