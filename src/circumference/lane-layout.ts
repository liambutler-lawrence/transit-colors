import type { Coordinate } from '../domain.js';
import { distanceMeters, lineLengthMeters } from './graph.js';

const SHARED_TRACK_MINIMUM_SAMPLE_M = 60;
const SHARED_TRACK_TOLERANCE_M = 18;
const SHARED_TRACK_SAMPLE_STEP_M = 12;
const SHARED_TRACK_BASELINE_LIMIT_M = 300;
const SHARED_TRACK_DEPARTURE_M = 10;
const SHARED_TRACK_RETURN_M = 3;
const SHARED_TRACK_DEPARTURE_SAMPLES = 4;
const JUNCTION_TRANSITION_LENGTH_M = 180;
const JUNCTION_TRANSITION_STEP_M = 15;
const sharedTrackDistanceCache = new WeakMap<
  object,
  WeakMap<object, WeakMap<object, number | null>>
>();
const networkSegmentsByNodeCache = new WeakMap<
  object,
  ReadonlyMap<string, readonly NetworkLineLayoutSegment[]>
>();

export interface BoundaryLineLayoutSegment {
  readonly coordinates: readonly Coordinate[];
  readonly displayedLines: readonly string[];
  readonly fromId: string;
  readonly primaryLine: string;
  readonly toId: string;
}

export interface NetworkLineLayoutSegment {
  readonly coordinates: readonly Coordinate[];
  readonly fromId: string;
  readonly lines: readonly string[];
  readonly toId: string;
}

export interface JunctionContinuationLane {
  readonly index: number;
  readonly nodeId: string;
  readonly sharedCoordinates: readonly Coordinate[];
  readonly sharedDistanceMeters: number;
  readonly side: -1 | 1;
  readonly style: 'boundary-alternative' | 'network';
}

export interface JunctionContinuationSection {
  readonly continuationFraction: number;
  readonly coordinates: readonly Coordinate[];
}

function coordinateAtDistance(
  coordinates: readonly Coordinate[],
  targetDistanceMeters: number,
): Coordinate | null {
  let traversedDistanceMeters = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    const previous = coordinates[index - 1];
    const current = coordinates[index];
    if (!previous || !current) continue;
    const segmentLengthMeters = distanceMeters(previous, current);
    if (
      segmentLengthMeters > 0 &&
      traversedDistanceMeters + segmentLengthMeters >= targetDistanceMeters
    ) {
      const progress =
        (targetDistanceMeters - traversedDistanceMeters) / segmentLengthMeters;
      return [
        previous[0] + (current[0] - previous[0]) * progress,
        previous[1] + (current[1] - previous[1]) * progress,
      ];
    }
    traversedDistanceMeters += segmentLengthMeters;
  }
  const finalCoordinate = coordinates.at(-1);
  return finalCoordinate ? [finalCoordinate[0], finalCoordinate[1]] : null;
}

function coordinatesBetweenDistances(
  coordinates: readonly Coordinate[],
  startDistanceMeters: number,
  endDistanceMeters: number,
): readonly Coordinate[] {
  const start = coordinateAtDistance(coordinates, startDistanceMeters);
  const end = coordinateAtDistance(coordinates, endDistanceMeters);
  if (!start || !end) return [];

  const result: Coordinate[] = [start];
  let traversedDistanceMeters = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    const previous = coordinates[index - 1];
    const current = coordinates[index];
    if (!previous || !current) continue;
    traversedDistanceMeters += distanceMeters(previous, current);
    if (
      traversedDistanceMeters > startDistanceMeters &&
      traversedDistanceMeters < endDistanceMeters
    ) {
      result.push(current);
    }
  }
  if (distanceMeters(result.at(-1) ?? start, end) > 0.01) result.push(end);
  return result;
}

function orientedFromNode(
  coordinates: readonly Coordinate[],
  nodeCoordinate: Coordinate,
): readonly Coordinate[] {
  const first = coordinates[0];
  const last = coordinates.at(-1);
  if (!first || !last) return coordinates;
  return distanceMeters(first, nodeCoordinate) <= distanceMeters(last, nodeCoordinate)
    ? coordinates
    : [...coordinates].reverse();
}

function coordinatesStartAtNode(
  coordinates: readonly Coordinate[],
  nodeCoordinate: Coordinate,
): boolean {
  const first = coordinates[0];
  const last = coordinates.at(-1);
  if (!first || !last) return false;
  return distanceMeters(first, nodeCoordinate) <= distanceMeters(last, nodeCoordinate);
}

export function tracksShareFromNode(
  firstCoordinates: readonly Coordinate[],
  secondCoordinates: readonly Coordinate[],
  nodeCoordinate: Coordinate,
): boolean {
  return (
    sharedTrackDistanceFromNode(firstCoordinates, secondCoordinates, nodeCoordinate) !==
    null
  );
}

export function sharedTrackDistanceFromNode(
  firstCoordinates: readonly Coordinate[],
  secondCoordinates: readonly Coordinate[],
  nodeCoordinate: Coordinate,
): number | null {
  let secondCoordinatesCache = sharedTrackDistanceCache.get(firstCoordinates);
  if (!secondCoordinatesCache) {
    secondCoordinatesCache = new WeakMap();
    sharedTrackDistanceCache.set(firstCoordinates, secondCoordinatesCache);
  }
  let nodeCache = secondCoordinatesCache.get(secondCoordinates);
  if (!nodeCache) {
    nodeCache = new WeakMap();
    secondCoordinatesCache.set(secondCoordinates, nodeCache);
  }
  if (nodeCache.has(nodeCoordinate)) {
    return nodeCache.get(nodeCoordinate) ?? null;
  }
  const result = calculateSharedTrackDistanceFromNode(
    firstCoordinates,
    secondCoordinates,
    nodeCoordinate,
  );
  nodeCache.set(nodeCoordinate, result);

  let reverseCoordinatesCache = sharedTrackDistanceCache.get(secondCoordinates);
  if (!reverseCoordinatesCache) {
    reverseCoordinatesCache = new WeakMap();
    sharedTrackDistanceCache.set(secondCoordinates, reverseCoordinatesCache);
  }
  let reverseNodeCache = reverseCoordinatesCache.get(firstCoordinates);
  if (!reverseNodeCache) {
    reverseNodeCache = new WeakMap();
    reverseCoordinatesCache.set(firstCoordinates, reverseNodeCache);
  }
  reverseNodeCache.set(nodeCoordinate, result);
  return result;
}

function calculateSharedTrackDistanceFromNode(
  firstCoordinates: readonly Coordinate[],
  secondCoordinates: readonly Coordinate[],
  nodeCoordinate: Coordinate,
): number | null {
  const first = orientedFromNode(firstCoordinates, nodeCoordinate);
  const second = orientedFromNode(secondCoordinates, nodeCoordinate);
  const firstStart = first[0];
  const secondStart = second[0];
  if (
    !firstStart ||
    !secondStart ||
    distanceMeters(firstStart, nodeCoordinate) > SHARED_TRACK_TOLERANCE_M ||
    distanceMeters(secondStart, nodeCoordinate) > SHARED_TRACK_TOLERANCE_M
  ) {
    return null;
  }

  const maximumDistanceMeters = Math.min(
    lineLengthMeters(first),
    lineLengthMeters(second),
  );
  if (maximumDistanceMeters < SHARED_TRACK_MINIMUM_SAMPLE_M) return null;

  const samples: { readonly distance: number; readonly separation: number }[] = [];
  for (
    let sampleDistanceMeters = 0;
    sampleDistanceMeters < maximumDistanceMeters;
    sampleDistanceMeters += SHARED_TRACK_SAMPLE_STEP_M
  ) {
    const firstSample = coordinateAtDistance(first, sampleDistanceMeters);
    const secondSample = coordinateAtDistance(second, sampleDistanceMeters);
    if (!firstSample || !secondSample) continue;
    samples.push({
      distance: sampleDistanceMeters,
      separation: distanceMeters(firstSample, secondSample),
    });
  }
  const firstEnd = coordinateAtDistance(first, maximumDistanceMeters);
  const secondEnd = coordinateAtDistance(second, maximumDistanceMeters);
  if (firstEnd && secondEnd) {
    samples.push({
      distance: maximumDistanceMeters,
      separation: distanceMeters(firstEnd, secondEnd),
    });
  }

  const initialSamples = samples.filter(
    ({ distance }) => distance > 0 && distance <= SHARED_TRACK_MINIMUM_SAMPLE_M,
  );
  if (
    initialSamples.length === 0 ||
    initialSamples.some(({ separation }) => separation > SHARED_TRACK_TOLERANCE_M)
  ) {
    return null;
  }

  const baselineSeparations = samples
    .filter(
      ({ distance }) =>
        distance >= SHARED_TRACK_MINIMUM_SAMPLE_M &&
        distance <= Math.min(SHARED_TRACK_BASELINE_LIMIT_M, maximumDistanceMeters),
    )
    .map(({ separation }) => separation);
  const baselineSeparation = Math.min(...baselineSeparations);
  const departureThreshold = baselineSeparation + SHARED_TRACK_DEPARTURE_M;
  let departureRun = 0;

  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    if (!sample || sample.distance < SHARED_TRACK_MINIMUM_SAMPLE_M) continue;
    if (sample.separation > departureThreshold) {
      departureRun += 1;
    } else {
      departureRun = 0;
    }
    if (departureRun < SHARED_TRACK_DEPARTURE_SAMPLES) continue;

    const departureIndex = index - SHARED_TRACK_DEPARTURE_SAMPLES + 1;
    for (
      let backtrackIndex = departureIndex;
      backtrackIndex >= 0;
      backtrackIndex -= 1
    ) {
      const backtrackSample = samples[backtrackIndex];
      if (
        backtrackSample &&
        backtrackSample.separation <= baselineSeparation + SHARED_TRACK_RETURN_M
      ) {
        return Math.max(SHARED_TRACK_MINIMUM_SAMPLE_M, backtrackSample.distance);
      }
    }
    return SHARED_TRACK_MINIMUM_SAMPLE_M;
  }

  return maximumDistanceMeters;
}

function sharedNodeId(
  first: Pick<BoundaryLineLayoutSegment, 'fromId' | 'toId'>,
  second: Pick<NetworkLineLayoutSegment, 'fromId' | 'toId'>,
): string | null {
  if (first.fromId === second.fromId || first.fromId === second.toId) {
    return first.fromId;
  }
  if (first.toId === second.fromId || first.toId === second.toId) {
    return first.toId;
  }
  return null;
}

function segmentTouchesNode(
  segment: Pick<BoundaryLineLayoutSegment, 'fromId' | 'toId'>,
  nodeId: string,
): boolean {
  return segment.fromId === nodeId || segment.toId === nodeId;
}

function sourceLineIndex(
  segment: BoundaryLineLayoutSegment,
  lineName: string,
): number | null {
  if (lineName === segment.primaryLine) return null;
  const alternativeIndex = segment.displayedLines
    .filter((displayedLine) => displayedLine !== segment.primaryLine)
    .indexOf(lineName);
  return alternativeIndex === -1 ? null : alternativeIndex;
}

function segmentSortKey(segment: NetworkLineLayoutSegment): string {
  return [
    [...segment.lines].sort().join(','),
    ...[segment.fromId, segment.toId].sort(),
  ].join('\u0000');
}

function centeredLinePosition(index: number, count: number): number {
  return index - (count - 1) / 2;
}

function overlappingLineCount(
  firstLines: readonly string[],
  secondLines: ReadonlySet<string>,
): number {
  return firstLines.filter((lineName) => secondLines.has(lineName)).length;
}

function networkSegmentsByNode(
  networkSegments: readonly NetworkLineLayoutSegment[],
): ReadonlyMap<string, readonly NetworkLineLayoutSegment[]> {
  const cached = networkSegmentsByNodeCache.get(networkSegments);
  if (cached) return cached;
  const index = new Map<string, NetworkLineLayoutSegment[]>();
  for (const segment of networkSegments) {
    for (const nodeId of new Set([segment.fromId, segment.toId])) {
      const incidentSegments = index.get(nodeId) ?? [];
      incidentSegments.push(segment);
      index.set(nodeId, incidentSegments);
    }
  }
  networkSegmentsByNodeCache.set(networkSegments, index);
  return index;
}

export function junctionContinuationLineLanes(
  networkSegment: NetworkLineLayoutSegment,
  boundarySegments: readonly BoundaryLineLayoutSegment[],
  coordinatesByNodeId: ReadonlyMap<string, Coordinate>,
  networkSegments: readonly NetworkLineLayoutSegment[] = [],
): ReadonlyMap<string, JunctionContinuationLane> {
  // A stop-to-stop branch can initially use the same physical track as the
  // boundary before reaching its turnout. Preserve the incoming lane slots on
  // that outgoing edge so MapLibre does not recenter the branch at the station.
  for (const overlappingBoundary of boundarySegments) {
    const nodeId = sharedNodeId(overlappingBoundary, networkSegment);
    if (!nodeId) continue;
    const nodeCoordinate = coordinatesByNodeId.get(nodeId);
    const sharedDistanceMeters = nodeCoordinate
      ? sharedTrackDistanceFromNode(
          overlappingBoundary.coordinates,
          networkSegment.coordinates,
          nodeCoordinate,
        )
      : null;
    if (!nodeCoordinate || sharedDistanceMeters === null) {
      continue;
    }

    const incidentBoundaries = boundarySegments.filter((segment) =>
      segmentTouchesNode(segment, nodeId),
    );
    const junctionAlternativeLines = [
      ...new Set([
        ...incidentBoundaries.flatMap((segment) => segment.displayedLines),
        ...networkSegment.lines,
      ]),
    ]
      .filter((lineName) => lineName !== overlappingBoundary.primaryLine)
      .sort((first, second) =>
        first.localeCompare(second, 'en', {
          numeric: true,
          sensitivity: 'base',
        }),
      );
    const lanes = new Map<string, JunctionContinuationLane>();

    for (const lineName of networkSegment.lines) {
      const sourceBoundary =
        incidentBoundaries.find(
          (segment) =>
            segment !== overlappingBoundary &&
            segment.displayedLines.includes(lineName),
        ) ??
        incidentBoundaries.find((segment) => segment.displayedLines.includes(lineName));
      let lineIndex = sourceBoundary ? sourceLineIndex(sourceBoundary, lineName) : null;
      if (lineIndex === null) {
        const junctionIndex = junctionAlternativeLines.indexOf(lineName);
        if (junctionIndex === -1) continue;
        lineIndex = junctionIndex;
      }
      const reversesAtNode =
        sourceBoundary !== undefined &&
        coordinatesStartAtNode(sourceBoundary.coordinates, nodeCoordinate) ===
          coordinatesStartAtNode(networkSegment.coordinates, nodeCoordinate);
      lanes.set(lineName, {
        index: lineIndex,
        nodeId,
        sharedCoordinates: orientedFromNode(
          overlappingBoundary.coordinates,
          nodeCoordinate,
        ),
        sharedDistanceMeters,
        side: reversesAtNode ? -1 : 1,
        style: 'boundary-alternative',
      });
    }

    if (lanes.size > 0) return lanes;
  }

  // Apply the same continuation model to the ordinary network, including
  // networks without a boundary candidate (such as Atlanta). Two branches
  // that initially share track inherit their lane ordering from the
  // multi-line trunk on the opposite side of the junction. When there is no
  // trunk, use a deterministic ordering across the branch group.
  const incidentNetworkSegments = networkSegmentsByNode(networkSegments);
  for (const nodeId of [networkSegment.fromId, networkSegment.toId]) {
    const nodeCoordinate = coordinatesByNodeId.get(nodeId);
    if (!nodeCoordinate) continue;
    const incidentSegments = (incidentNetworkSegments.get(nodeId) ?? []).filter(
      (segment) => segment !== networkSegment,
    );
    const siblingEntries = incidentSegments
      .map((segment) => ({
        segment,
        sharedDistanceMeters: sharedTrackDistanceFromNode(
          networkSegment.coordinates,
          segment.coordinates,
          nodeCoordinate,
        ),
      }))
      .filter(
        (
          entry,
        ): entry is {
          readonly segment: NetworkLineLayoutSegment;
          readonly sharedDistanceMeters: number;
        } =>
          entry.sharedDistanceMeters !== null &&
          entry.segment.lines.some(
            (lineName) => !networkSegment.lines.includes(lineName),
          ),
      );
    if (siblingEntries.length === 0) continue;

    const branchSegments = [
      networkSegment,
      ...siblingEntries.map(({ segment }) => segment),
    ];
    const branchLines = [
      ...new Set(branchSegments.flatMap(({ lines }) => lines)),
    ].sort();
    if (branchLines.length < 2) continue;
    const branchLineSet = new Set(branchLines);
    const sourceSegment = incidentSegments
      .filter((segment) => !branchSegments.includes(segment))
      .map((segment) => ({
        overlap: overlappingLineCount(segment.lines, branchLineSet),
        segment,
      }))
      .filter(({ overlap }) => overlap >= 2)
      .sort(
        (first, second) =>
          second.overlap - first.overlap ||
          second.segment.lines.length - first.segment.lines.length ||
          segmentSortKey(first.segment).localeCompare(segmentSortKey(second.segment)),
      )[0]?.segment;
    const canonicalSegment = [...branchSegments].sort((first, second) =>
      segmentSortKey(first).localeCompare(segmentSortKey(second)),
    )[0];
    if (!canonicalSegment) continue;

    const sharedDistanceMeters = Math.min(
      ...siblingEntries.map((entry) => entry.sharedDistanceMeters),
    );
    const lanes = new Map<string, JunctionContinuationLane>();
    const targetStartsAtNode = coordinatesStartAtNode(
      networkSegment.coordinates,
      nodeCoordinate,
    );
    const sourceLines = sourceSegment ? [...sourceSegment.lines].sort() : branchLines;

    for (const lineName of networkSegment.lines) {
      const sourceIndex = sourceLines.indexOf(lineName);
      if (sourceIndex === -1) continue;
      const sourcePosition = centeredLinePosition(sourceIndex, sourceLines.length);
      const side = sourceSegment
        ? coordinatesStartAtNode(sourceSegment.coordinates, nodeCoordinate) ===
          targetStartsAtNode
          ? -1
          : 1
        : targetStartsAtNode
          ? 1
          : -1;
      lanes.set(lineName, {
        index: sourcePosition,
        nodeId,
        sharedCoordinates: orientedFromNode(
          canonicalSegment.coordinates,
          nodeCoordinate,
        ),
        sharedDistanceMeters,
        side,
        style: 'network',
      });
    }
    if (lanes.size > 0) return lanes;
  }

  return new Map();
}

function smoothstep(progress: number): number {
  const clampedProgress = Math.max(0, Math.min(1, progress));
  return clampedProgress * clampedProgress * (3 - 2 * clampedProgress);
}

function blendedCoordinate(
  first: Coordinate,
  second: Coordinate,
  progress: number,
): Coordinate {
  return [
    first[0] + (second[0] - first[0]) * progress,
    first[1] + (second[1] - first[1]) * progress,
  ];
}

/**
 * Splits a line at its physical turnout and tapers an inherited lane offset
 * back to the line's normal position. Fractions are consumed by the map style,
 * keeping the curve smooth and zoom-responsive instead of jumping sideways at
 * either station.
 */
export function junctionContinuationSections(
  coordinates: readonly Coordinate[],
  nodeCoordinate: Coordinate,
  lane: JunctionContinuationLane,
): readonly JunctionContinuationSection[] {
  const target = orientedFromNode(coordinates, nodeCoordinate);
  const targetLengthMeters = lineLengthMeters(target);
  if (targetLengthMeters <= 0) return [];
  const sharedDistanceMeters = Math.min(lane.sharedDistanceMeters, targetLengthMeters);
  const transitionEndMeters = Math.min(
    targetLengthMeters,
    sharedDistanceMeters + JUNCTION_TRANSITION_LENGTH_M,
  );
  const reference = lane.sharedCoordinates;
  const referenceLengthMeters = lineLengthMeters(reference);
  const sections: JunctionContinuationSection[] = [];

  if (sharedDistanceMeters > 0) {
    const sharedCoordinates = coordinatesBetweenDistances(
      reference,
      0,
      Math.min(sharedDistanceMeters, referenceLengthMeters),
    );
    if (sharedCoordinates.length >= 2) {
      sections.push({
        continuationFraction: 1,
        coordinates: sharedCoordinates,
      });
    }
  }

  for (
    let startDistanceMeters = sharedDistanceMeters;
    startDistanceMeters < transitionEndMeters - 0.01;
    startDistanceMeters += JUNCTION_TRANSITION_STEP_M
  ) {
    const endDistanceMeters = Math.min(
      transitionEndMeters,
      startDistanceMeters + JUNCTION_TRANSITION_STEP_M,
    );
    const transitionCoordinates: Coordinate[] = [];
    for (const distance of [
      startDistanceMeters,
      (startDistanceMeters + endDistanceMeters) / 2,
      endDistanceMeters,
    ]) {
      const targetCoordinate = coordinateAtDistance(target, distance);
      if (!targetCoordinate) continue;
      const referenceCoordinate =
        distance <= referenceLengthMeters
          ? coordinateAtDistance(reference, distance)
          : targetCoordinate;
      const transitionProgress =
        transitionEndMeters === sharedDistanceMeters
          ? 1
          : (distance - sharedDistanceMeters) /
            (transitionEndMeters - sharedDistanceMeters);
      transitionCoordinates.push(
        referenceCoordinate
          ? blendedCoordinate(
              referenceCoordinate,
              targetCoordinate,
              smoothstep(transitionProgress),
            )
          : targetCoordinate,
      );
    }
    if (transitionCoordinates.length >= 2) {
      const midpointProgress =
        transitionEndMeters === sharedDistanceMeters
          ? 1
          : ((startDistanceMeters + endDistanceMeters) / 2 - sharedDistanceMeters) /
            (transitionEndMeters - sharedDistanceMeters);
      sections.push({
        continuationFraction: 1 - smoothstep(midpointProgress),
        coordinates: transitionCoordinates,
      });
    }
  }

  if (transitionEndMeters < targetLengthMeters - 0.01) {
    const remainingCoordinates = coordinatesBetweenDistances(
      target,
      transitionEndMeters,
      targetLengthMeters,
    );
    if (remainingCoordinates.length >= 2) {
      sections.push({
        continuationFraction: 0,
        coordinates: remainingCoordinates,
      });
    }
  }

  if (sections.length === 0) {
    sections.push({
      continuationFraction: 1,
      coordinates: target,
    });
  }
  if (coordinatesStartAtNode(coordinates, nodeCoordinate)) return sections;
  return [...sections].reverse().map((section) => ({
    continuationFraction: section.continuationFraction,
    coordinates: [...section.coordinates].reverse(),
  }));
}
