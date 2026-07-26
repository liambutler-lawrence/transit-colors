import * as polygonClipping from 'polygon-clipping';
import type { MultiPolygon } from 'polygon-clipping';

import type { Coordinate, LandmassArea } from './domain.js';
import { polygonAreaSquareMeters } from './circumference.js';

export interface LandmassCoverage {
  readonly area_m2: number;
  readonly id: string;
  readonly insideAreaSquareMeters: number;
  readonly label: string;
  readonly mask: Coordinate[][][] | null;
  readonly outsideAreaSquareMeters: number;
}

function multiPolygonAreaSquareMeters(multiPolygon: MultiPolygon): number {
  return multiPolygon.reduce(
    (total, polygon) =>
      total +
      polygon.reduce(
        (polygonTotal, ring, ringIndex) =>
          polygonTotal + polygonAreaSquareMeters(ring) * (ringIndex === 0 ? 1 : -1),
        0,
      ),
    0,
  );
}

function normalizedLandmasses(area: LandmassArea): LandmassArea['landmasses'] {
  return area.landmasses;
}

/**
 * Intersects the route polygon with every configured landmass. The result keeps
 * route-contained land and coastward land separate for each touched landmass,
 * instead of subtracting the entire route area from one arbitrarily chosen mask.
 */
export function calculateLandmassCoverage(
  routeCoordinates: Coordinate[],
  area: LandmassArea,
  clipping: typeof polygonClipping = polygonClipping,
): LandmassCoverage[] {
  if (routeCoordinates.length < 4) {
    return [];
  }

  return normalizedLandmasses(area).flatMap((landmass) => {
    let insideAreaSquareMeters: number;
    if (landmass.mask == null) {
      insideAreaSquareMeters = polygonAreaSquareMeters(routeCoordinates);
    } else {
      const intersection = clipping.intersection([routeCoordinates], landmass.mask);
      insideAreaSquareMeters = multiPolygonAreaSquareMeters(intersection);
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
