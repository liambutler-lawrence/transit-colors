import polygonClipping, { type MultiPolygon } from 'polygon-clipping';

import type { Coordinate } from '../domain.js';
import { localEqualAreaProjection } from '../geodesy.js';
import type { CircumferenceCandidate } from './types.js';

export const CIRCUMFERENCE_INTERIOR_OVERLAP_TOLERANCE_SQUARE_METERS = 1;

interface CoordinateBounds {
  readonly east: number;
  readonly north: number;
  readonly south: number;
  readonly west: number;
}

function coordinateBounds(coordinates: readonly Coordinate[]): CoordinateBounds {
  return coordinates.reduce(
    (bounds, [longitude, latitude]) => ({
      east: Math.max(bounds.east, longitude),
      north: Math.max(bounds.north, latitude),
      south: Math.min(bounds.south, latitude),
      west: Math.min(bounds.west, longitude),
    }),
    {
      east: Number.NEGATIVE_INFINITY,
      north: Number.NEGATIVE_INFINITY,
      south: Number.POSITIVE_INFINITY,
      west: Number.POSITIVE_INFINITY,
    },
  );
}

function boundsHaveInteriorOverlap(
  first: CoordinateBounds,
  second: CoordinateBounds,
): boolean {
  return (
    Math.min(first.east, second.east) > Math.max(first.west, second.west) &&
    Math.min(first.north, second.north) > Math.max(first.south, second.south)
  );
}

function ringAreaSquareMeters(ring: readonly (readonly number[])[]): number {
  let doubledArea = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    const currentX = current?.[0];
    const currentY = current?.[1];
    const nextX = next?.[0];
    const nextY = next?.[1];
    if (
      currentX !== undefined &&
      currentY !== undefined &&
      nextX !== undefined &&
      nextY !== undefined
    ) {
      doubledArea += currentX * nextY - nextX * currentY;
    }
  }
  return Math.abs(doubledArea) / 2;
}

function multiPolygonAreaSquareMeters(multiPolygon: MultiPolygon): number {
  return multiPolygon.reduce(
    (total, polygon) =>
      total +
      polygon.reduce(
        (polygonTotal, ring, ringIndex) =>
          polygonTotal + ringAreaSquareMeters(ring) * (ringIndex === 0 ? 1 : -1),
        0,
      ),
    0,
  );
}

/**
 * Measures shared polygon interior in a local WGS84 equal-area projection.
 * Boundary-only contact has zero area, so adjacent network faces may meet at
 * stations or share a perimeter without becoming overlapping results.
 */
export function circumferenceInteriorOverlapSquareMeters(
  first: Pick<CircumferenceCandidate, 'coordinates'>,
  second: Pick<CircumferenceCandidate, 'coordinates'>,
): number {
  const firstBounds = coordinateBounds(first.coordinates);
  const secondBounds = coordinateBounds(second.coordinates);
  if (!boundsHaveInteriorOverlap(firstBounds, secondBounds)) return 0;

  const center: Coordinate = [
    (Math.min(firstBounds.west, secondBounds.west) +
      Math.max(firstBounds.east, secondBounds.east)) /
      2,
    (Math.min(firstBounds.south, secondBounds.south) +
      Math.max(firstBounds.north, secondBounds.north)) /
      2,
  ];
  const { project } = localEqualAreaProjection(center);
  const intersection = polygonClipping.intersection(
    [first.coordinates.map(project)],
    [second.coordinates.map(project)],
  );
  return Math.max(0, multiPolygonAreaSquareMeters(intersection));
}

export function circumferenceCandidatesSpatiallyOverlap(
  first: Pick<CircumferenceCandidate, 'coordinates'>,
  second: Pick<CircumferenceCandidate, 'coordinates'>,
): boolean {
  return (
    circumferenceInteriorOverlapSquareMeters(first, second) >
    CIRCUMFERENCE_INTERIOR_OVERLAP_TOLERANCE_SQUARE_METERS
  );
}

export interface IndependentCircumferenceSelectionOptions {
  /**
   * Authoritative spatial geometry for each candidate ID. Candidate ranking
   * still uses the supplied candidates' areas, but overlap is measured with
   * these shapes. This lets the exact straight-edge optimization objective
   * publish topology that is spatially validated against real track paths.
   */
  readonly spatialCandidatesById?: ReadonlyMap<
    string,
    Pick<CircumferenceCandidate, 'coordinates'>
  >;
}

function candidatesSpatiallyOverlap(
  first: CircumferenceCandidate,
  second: CircumferenceCandidate,
  options: IndependentCircumferenceSelectionOptions,
): boolean {
  const firstSpatialCandidate = options.spatialCandidatesById?.get(first.id) ?? first;
  const secondSpatialCandidate =
    options.spatialCandidatesById?.get(second.id) ?? second;
  return circumferenceCandidatesSpatiallyOverlap(
    firstSpatialCandidate,
    secondSpatialCandidate,
  );
}

/**
 * Returns one maximum-area representative for each independent cyclic region.
 *
 * Results must have disjoint interiors and may not reuse a ride segment.
 * Circles may still meet at a station, share a boundary, or use the same
 * free-transfer complex. Sorting first makes the largest circle own an area
 * before any smaller alternate, nested, or concentric boundary is considered.
 * When authoritative spatial geometries are supplied, ranking and spatial
 * validation may use different representations without changing result IDs.
 */
export function selectIndependentCircumferenceCandidates(
  candidates: readonly CircumferenceCandidate[],
  options: IndependentCircumferenceSelectionOptions = {},
): CircumferenceCandidate[] {
  const selected: CircumferenceCandidate[] = [];
  const occupiedRideSegmentIds = new Set<string>();
  const ranked = [...candidates].sort(
    (first, second) =>
      second.areaSquareMeters - first.areaSquareMeters ||
      first.id.localeCompare(second.id),
  );

  for (const candidate of ranked) {
    const rideSegmentIds = candidate.segments
      .filter((segment) => segment.type === 'ride')
      .map((segment) => segment.id);
    if (
      rideSegmentIds.some((segmentId) => occupiedRideSegmentIds.has(segmentId)) ||
      selected.some((selectedCandidate) =>
        candidatesSpatiallyOverlap(selectedCandidate, candidate, options),
      )
    ) {
      continue;
    }
    selected.push(candidate);
    for (const segmentId of rideSegmentIds) {
      occupiedRideSegmentIds.add(segmentId);
    }
  }

  return selected;
}
