import geographicLib from 'geographiclib-geodesic';

import type { Coordinate } from './domain.js';

const { Geodesic } = geographicLib;
const WGS84 = Geodesic.WGS84;

export const WGS84_SEMIMAJOR_AXIS_M = 6_378_137;
export const WGS84_FLATTENING = 1 / 298.257_223_563;
export const WGS84_ECCENTRICITY_SQUARED = WGS84_FLATTENING * (2 - WGS84_FLATTENING);
const WGS84_ECCENTRICITY = Math.sqrt(WGS84_ECCENTRICITY_SQUARED);

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function normalizeLongitudeRadians(value: number): number {
  if (value > Math.PI) return value - Math.PI * 2;
  if (value < -Math.PI) return value + Math.PI * 2;
  return value;
}

function requiredResult(value: number | undefined, label: string): number {
  if (value === undefined || !Number.isFinite(value)) {
    throw new Error(`GeographicLib did not return a finite ${label}.`);
  }
  return value;
}

/**
 * WGS84 inverse geodesic distance. This follows the shortest path on the
 * reference ellipsoid instead of measuring in Web Mercator or on a mean-radius
 * sphere.
 */
export function geodesicDistanceMeters(
  [longitudeA, latitudeA]: Coordinate,
  [longitudeB, latitudeB]: Coordinate,
): number {
  return requiredResult(
    WGS84.Inverse(latitudeA, longitudeA, latitudeB, longitudeB, Geodesic.DISTANCE).s12,
    'geodesic distance',
  );
}

export function geodesicLineLengthMeters(coordinates: readonly Coordinate[]): number {
  let length = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    const previous = coordinates[index - 1];
    const current = coordinates[index];
    if (previous !== undefined && current !== undefined) {
      length += geodesicDistanceMeters(previous, current);
    }
  }
  return length;
}

/**
 * GeographicLib polygon area on the WGS84 ellipsoid. Polygon edges are
 * ellipsoidal geodesics and the result is independent of the rendered map
 * projection.
 */
export function geodesicPolygonAreaSquareMeters(
  coordinates: readonly Coordinate[],
): number {
  if (coordinates.length < 3) return 0;
  const polygon = WGS84.Polygon(false);
  for (const [longitude, latitude] of coordinates) {
    polygon.AddPoint(latitude, longitude);
  }
  return Math.abs(requiredResult(polygon.Compute(false, true).area, 'polygon area'));
}

/**
 * Signed ellipsoidal area contribution for an open coordinate chain. These
 * edge contributions are additive, so a closed cycle has the same signed WGS84
 * area used by GeographicLib's polygon accumulator.
 */
export function signedGeodesicAreaContributionSquareMeters(
  coordinates: readonly Coordinate[],
): number {
  let area = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    const previous = coordinates[index - 1];
    const current = coordinates[index];
    if (previous === undefined || current === undefined) continue;
    area += requiredResult(
      WGS84.Inverse(previous[1], previous[0], current[1], current[0], Geodesic.AREA)
        .S12,
      'signed geodesic area',
    );
  }
  return area;
}

function authalicQ(latitudeRadians: number): number {
  const sine = Math.sin(latitudeRadians);
  const eccentricitySine = WGS84_ECCENTRICITY * sine;
  return (
    (1 - WGS84_ECCENTRICITY_SQUARED) *
    (sine / (1 - WGS84_ECCENTRICITY_SQUARED * sine ** 2) -
      Math.log((1 - eccentricitySine) / (1 + eccentricitySine)) /
        (2 * WGS84_ECCENTRICITY))
  );
}

const AUTHALIC_Q_AT_POLE = authalicQ(Math.PI / 2);
const WGS84_AUTHALIC_RADIUS_M =
  WGS84_SEMIMAJOR_AXIS_M * Math.sqrt(AUTHALIC_Q_AT_POLE / 2);

function authalicLatitudeRadians(latitude: number): number {
  return Math.asin(
    Math.max(-1, Math.min(1, authalicQ(toRadians(latitude)) / AUTHALIC_Q_AT_POLE)),
  );
}

function geodeticLatitudeFromAuthalicRadians(authalicLatitudeRadians: number): number {
  const targetQ = AUTHALIC_Q_AT_POLE * Math.sin(authalicLatitudeRadians);
  let lower = -Math.PI / 2;
  let upper = Math.PI / 2;
  for (let iteration = 0; iteration < 52; iteration += 1) {
    const midpoint = (lower + upper) / 2;
    if (authalicQ(midpoint) < targetQ) {
      lower = midpoint;
    } else {
      upper = midpoint;
    }
  }
  return (lower + upper) / 2;
}

export interface LocalEqualAreaProjection {
  readonly project: (coordinate: Coordinate) => Coordinate;
  readonly unproject: (coordinate: Coordinate) => Coordinate;
}

/**
 * A local Lambert cylindrical equal-area projection defined on the WGS84
 * authalic sphere. It is used only to make robust polygon intersections;
 * clipped vertices are transformed back to WGS84 for final ellipsoidal area
 * measurement. Equal-area clipping avoids longitude/latitude and Web-Mercator
 * area distortion.
 */
export function localEqualAreaProjection([
  centralLongitude,
  centralLatitude,
]: Coordinate): LocalEqualAreaProjection {
  const referenceAuthalicLatitude = authalicLatitudeRadians(centralLatitude);
  const referenceCosine = Math.max(1e-9, Math.cos(referenceAuthalicLatitude));
  const referenceSine = Math.sin(referenceAuthalicLatitude);

  return {
    project: ([longitude, latitude]: Coordinate): Coordinate => {
      const longitudeDelta = normalizeLongitudeRadians(
        toRadians(longitude - centralLongitude),
      );
      const authalicLatitude = authalicLatitudeRadians(latitude);
      return [
        WGS84_AUTHALIC_RADIUS_M * longitudeDelta * referenceCosine,
        (WGS84_AUTHALIC_RADIUS_M * (Math.sin(authalicLatitude) - referenceSine)) /
          referenceCosine,
      ];
    },
    unproject: ([x, y]: Coordinate): Coordinate => {
      const authalicSine = Math.max(
        -1,
        Math.min(1, referenceSine + (y * referenceCosine) / WGS84_AUTHALIC_RADIUS_M),
      );
      const longitude =
        centralLongitude +
        ((x / (WGS84_AUTHALIC_RADIUS_M * referenceCosine)) * 180) / Math.PI;
      const latitude =
        (geodeticLatitudeFromAuthalicRadians(Math.asin(authalicSine)) * 180) / Math.PI;
      return [longitude, latitude];
    },
  };
}

/**
 * Local WGS84 curvature scales for fast visual and topology calculations.
 * Statistics and route optimization use the full geodesic functions above.
 */
export function metersPerDegreeAtLatitude(latitude: number): {
  readonly latitude: number;
  readonly longitude: number;
} {
  const latitudeRadians = toRadians(latitude);
  const sine = Math.sin(latitudeRadians);
  const denominator = Math.sqrt(1 - WGS84_ECCENTRICITY_SQUARED * sine ** 2);
  const primeVerticalRadius = WGS84_SEMIMAJOR_AXIS_M / denominator;
  const meridionalRadius =
    (WGS84_SEMIMAJOR_AXIS_M * (1 - WGS84_ECCENTRICITY_SQUARED)) / denominator ** 3;
  const radiansPerDegree = Math.PI / 180;
  return {
    latitude: meridionalRadius * radiansPerDegree,
    longitude: primeVerticalRadius * Math.cos(latitudeRadians) * radiansPerDegree,
  };
}
