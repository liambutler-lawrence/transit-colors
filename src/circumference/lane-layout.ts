import type { Coordinate } from '../domain.js';
import { distanceMeters, lineLengthMeters } from './graph.js';

const SHARED_TRACK_MINIMUM_SAMPLE_M = 60;
const SHARED_TRACK_MAXIMUM_SAMPLE_M = 180;
const SHARED_TRACK_TOLERANCE_M = 18;

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
  readonly side: -1 | 1;
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
    return false;
  }

  const sampleDistanceMeters = Math.min(
    SHARED_TRACK_MAXIMUM_SAMPLE_M,
    lineLengthMeters(first) * 0.6,
    lineLengthMeters(second) * 0.6,
  );
  if (sampleDistanceMeters < SHARED_TRACK_MINIMUM_SAMPLE_M) return false;

  return [0.25, 0.5, 0.75, 1].every((fraction) => {
    const firstSample = coordinateAtDistance(first, sampleDistanceMeters * fraction);
    const secondSample = coordinateAtDistance(second, sampleDistanceMeters * fraction);
    return (
      firstSample !== null &&
      secondSample !== null &&
      distanceMeters(firstSample, secondSample) <= SHARED_TRACK_TOLERANCE_M
    );
  });
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

export function junctionContinuationLineLanes(
  networkSegment: NetworkLineLayoutSegment,
  boundarySegments: readonly BoundaryLineLayoutSegment[],
  coordinatesByNodeId: ReadonlyMap<string, Coordinate>,
): ReadonlyMap<string, JunctionContinuationLane> {
  // A stop-to-stop branch can initially use the same physical track as the
  // boundary before reaching its turnout. Preserve the incoming lane slots on
  // that outgoing edge so MapLibre does not recenter the branch at the station.
  for (const overlappingBoundary of boundarySegments) {
    const nodeId = sharedNodeId(overlappingBoundary, networkSegment);
    if (!nodeId) continue;
    const nodeCoordinate = coordinatesByNodeId.get(nodeId);
    if (
      !nodeCoordinate ||
      !tracksShareFromNode(
        overlappingBoundary.coordinates,
        networkSegment.coordinates,
        nodeCoordinate,
      )
    ) {
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
        side: reversesAtNode ? -1 : 1,
      });
    }

    if (lanes.size > 0) return lanes;
  }
  return new Map();
}
