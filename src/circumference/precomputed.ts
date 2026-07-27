import type { Coordinate } from '../domain.js';
import {
  assignPrimaryLines,
  serviceStopPriority,
  sortLineNames,
} from './candidates.js';
import {
  edgeKey,
  getRequired,
  joinSegmentCoordinates,
  lineLengthMeters,
  polygonAreaSquareMeters,
  stableCandidateId,
} from './graph.js';
import type {
  CircumferenceCandidate,
  CircumferenceNetwork,
  CircumferenceSegment,
  NodeId,
} from './types.js';

export function candidateFromNetworkPath(
  network: CircumferenceNetwork,
  path: readonly NodeId[],
  { useTrackGeometry = true }: { readonly useTrackGeometry?: boolean } = {},
): CircumferenceCandidate {
  const nodes = new Map(network.stations.map((station) => [station.id, station]));
  const segmentsByEdge = new Map(
    network.segments.map((segment) => [
      edgeKey(segment.from.id, segment.to.id),
      segment,
    ]),
  );
  const servicePriorityByLine = new Map<string, number>();
  for (const segment of network.segments) {
    for (const lineName of segment.lines) {
      servicePriorityByLine.set(lineName, serviceStopPriority(lineName));
    }
  }
  const segments = assignPrimaryLines(
    path.map((fromId, index) => {
      const toId = path[(index + 1) % path.length];
      if (!toId) throw new Error(`Open circumference path at ${fromId}`);
      const networkSegment = segmentsByEdge.get(edgeKey(fromId, toId));
      if (!networkSegment) {
        throw new Error(`Missing circumference network edge ${fromId} → ${toId}`);
      }
      const from = getRequired(nodes, fromId);
      const to = getRequired(nodes, toId);
      const coordinates: Coordinate[] = useTrackGeometry
        ? networkSegment.from.id === fromId
          ? [...networkSegment.coordinates]
          : [...networkSegment.coordinates].reverse()
        : [
            [from.coordinate[0], from.coordinate[1]],
            [to.coordinate[0], to.coordinate[1]],
          ];
      return {
        id: stableCandidateId([fromId, toId]).replace('route-', 'segment-'),
        from,
        to,
        type: networkSegment.type,
        lines: [...networkSegment.lines].sort(sortLineNames),
        primaryLine: null,
        coordinates,
        distanceMeters: lineLengthMeters(coordinates),
        transferSource: networkSegment.transferSource ?? null,
        transferMinutes: networkSegment.transferMinutes ?? null,
      } satisfies CircumferenceSegment;
    }),
    servicePriorityByLine,
  );
  const coordinates = joinSegmentCoordinates(segments);
  const lines = [
    ...new Set(
      segments.flatMap((segment) =>
        segment.primaryLine === null ? [] : [segment.primaryLine],
      ),
    ),
  ].sort(sortLineNames);
  const walkingLengthMeters = segments
    .filter((segment) => segment.type === 'transfer')
    .reduce((total, segment) => total + segment.distanceMeters, 0);
  return {
    id: stableCandidateId(path),
    nodeIds: [...path],
    stations: path.map((nodeId) => getRequired(nodes, nodeId)),
    coordinates,
    segments,
    lines,
    transferCount: segments.filter((segment) => segment.type === 'transfer').length,
    walkingLengthMeters,
    rideLengthMeters: segments
      .filter((segment) => segment.type === 'ride')
      .reduce((total, segment) => total + segment.distanceMeters, 0),
    areaSquareMeters: polygonAreaSquareMeters(coordinates),
    lengthMeters: segments.reduce(
      (total, segment) => total + segment.distanceMeters,
      0,
    ),
  };
}
