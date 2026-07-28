import type { CircumferenceCandidate } from './types.js';

/**
 * Returns one maximum-area representative for each independent cyclic region.
 *
 * Composite circles are independent when they do not reuse a ride segment.
 * A line explicitly classified as circular is also an independent result,
 * even when a larger composite circumference follows part of it. Circles may
 * still meet at a station or use the same free-transfer complex: those shared
 * nodes connect the network without making one circle an alternate boundary
 * for the other. Sorting first keeps the selection deterministic.
 */
export function selectIndependentCircumferenceCandidates(
  candidates: readonly CircumferenceCandidate[],
): CircumferenceCandidate[] {
  const selected: CircumferenceCandidate[] = [];
  const occupiedCompositeRideSegmentIds = new Set<string>();
  const selectedCircularLines = new Set<string>();
  const ranked = [...candidates].sort(
    (first, second) =>
      second.areaSquareMeters - first.areaSquareMeters ||
      first.id.localeCompare(second.id),
  );

  for (const candidate of ranked) {
    const rideSegmentIds = candidate.segments
      .filter((segment) => segment.type === 'ride')
      .map((segment) => segment.id);
    const circularLine =
      candidate.independentCircleKind === 'native-line'
        ? candidate.lines[0]
        : undefined;
    if (circularLine !== undefined) {
      if (selectedCircularLines.has(circularLine)) continue;
      selectedCircularLines.add(circularLine);
      selected.push(candidate);
      continue;
    }
    if (
      rideSegmentIds.some((segmentId) => occupiedCompositeRideSegmentIds.has(segmentId))
    ) {
      continue;
    }
    selected.push(candidate);
    for (const segmentId of rideSegmentIds) {
      occupiedCompositeRideSegmentIds.add(segmentId);
    }
  }

  return selected;
}
