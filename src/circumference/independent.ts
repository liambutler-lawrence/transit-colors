import type { CircumferenceCandidate } from './types.js';

/**
 * Returns one maximum-area representative for each independent cyclic region.
 *
 * Two circles are independent when they do not reuse a ride segment. They may
 * still meet at a station or use the same free-transfer complex: those shared
 * nodes connect the network without making one circle an alternate boundary
 * for the other. Sorting first makes the selection deterministic and ensures
 * an overlapping variation can never displace the largest circle in its
 * region.
 */
export function selectIndependentCircumferenceCandidates(
  candidates: readonly CircumferenceCandidate[],
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
    if (rideSegmentIds.some((segmentId) => occupiedRideSegmentIds.has(segmentId))) {
      continue;
    }
    selected.push(candidate);
    for (const segmentId of rideSegmentIds) {
      occupiedRideSegmentIds.add(segmentId);
    }
  }

  return selected;
}
