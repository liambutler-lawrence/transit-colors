import { polygonAreaSquareMeters } from './circumference.js';

function multiPolygonAreaSquareMeters(multiPolygon) {
  return multiPolygon.reduce(
    (total, polygon) =>
      total +
      polygon.reduce(
        (polygonTotal, ring, ringIndex) =>
          polygonTotal +
          polygonAreaSquareMeters(ring) * (ringIndex === 0 ? 1 : -1),
        0,
      ),
    0,
  );
}

function normalizedLandmasses(area) {
  if (Array.isArray(area?.landmasses)) return area.landmasses;
  if (!area) return [];
  return [
    {
      id: 'landmass',
      label: area.label,
      area_m2: area.area_m2,
      mask: area.mask,
    },
  ];
}

/**
 * Intersects the route polygon with every configured landmass. The result keeps
 * route-contained land and coastward land separate for each touched landmass,
 * instead of subtracting the entire route area from one arbitrarily chosen mask.
 */
export function calculateLandmassCoverage(
  routeCoordinates,
  area,
  clipping = globalThis.polygonClipping,
) {
  if (!Array.isArray(routeCoordinates) || routeCoordinates.length < 4) {
    return [];
  }

  return normalizedLandmasses(area).flatMap((landmass) => {
    let insideAreaSquareMeters;
    if (landmass.mask == null) {
      insideAreaSquareMeters = polygonAreaSquareMeters(routeCoordinates);
    } else {
      if (!clipping?.intersection) {
        throw new Error('Polygon clipping is unavailable.');
      }
      const intersection = clipping.intersection(
        [routeCoordinates],
        [landmass.mask],
      );
      insideAreaSquareMeters = multiPolygonAreaSquareMeters(intersection);
    }

    if (insideAreaSquareMeters <= 1) return [];
    return [
      {
        ...landmass,
        insideAreaSquareMeters,
        outsideAreaSquareMeters: Math.max(
          0,
          landmass.area_m2 - insideAreaSquareMeters,
        ),
      },
    ];
  });
}

export function combinedLandmassArea(coverage, field) {
  return coverage.reduce(
    (total, landmass) => total + (landmass[field] ?? 0),
    0,
  );
}
