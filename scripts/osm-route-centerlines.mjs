import {
  averageShapeSections,
  extractClosedShapeSection,
  extractShapeSection,
  stationEdgeKey,
} from './gtfs-shape-centerlines.mjs';
import { geodesicDistanceMeters as distanceMeters } from './wgs84-geodesy.mjs';

const EDGE_KEY_SEPARATOR = '\u0000';
const MAX_UNNAMED_STOP_MATCH_METERS = 450;

function elementKey(type, id) {
  return `${type}/${id}`;
}

function copyCoordinate(coordinate) {
  return [coordinate[0], coordinate[1]];
}

function appendCoordinates(result, additions) {
  const coordinates = additions.map(copyCoordinate);
  if (result.length === 0) {
    result.push(...coordinates);
    return;
  }
  const currentEnd = result.at(-1);
  const forwardGap = distanceMeters(currentEnd, coordinates[0]);
  const reverseGap = distanceMeters(currentEnd, coordinates.at(-1));
  if (reverseGap < forwardGap) coordinates.reverse();
  if (distanceMeters(currentEnd, coordinates[0]) < 0.75) coordinates.shift();
  result.push(...coordinates);
}

function entityCoordinate(entity, elementByKey) {
  if (!entity) return null;
  if (entity.type === 'node') return [entity.lon, entity.lat];
  if (entity.type !== 'way') return null;
  const coordinates = entity.nodes
    .map((nodeId) => elementByKey.get(elementKey('node', nodeId)))
    .filter(Boolean)
    .map((node) => [node.lon, node.lat]);
  if (coordinates.length === 0) return null;
  return coordinates[Math.floor(coordinates.length / 2)];
}

function entityNames(entity) {
  const tags = entity?.tags ?? {};
  return [
    tags.name,
    tags['name:en'],
    tags['name:el'],
    tags.official_name,
    tags.alt_name,
  ].filter(Boolean);
}

export function osmRouteObservation(data, relationId) {
  const elementByKey = new Map(
    data.elements.map((element) => [elementKey(element.type, element.id), element]),
  );
  const relation = elementByKey.get(elementKey('relation', relationId));
  if (!relation) throw new Error(`OpenStreetMap relation ${relationId} is missing`);

  const coordinates = [];
  for (const member of relation.members.filter(({ type }) => type === 'way')) {
    const way = elementByKey.get(elementKey('way', member.ref));
    if (
      !way?.nodes?.length ||
      !['light_rail', 'monorail', 'rail', 'subway'].includes(way.tags?.railway)
    ) {
      continue;
    }
    const wayCoordinates = way.nodes
      .map((nodeId) => elementByKey.get(elementKey('node', nodeId)))
      .filter(Boolean)
      .map((node) => [node.lon, node.lat]);
    if (wayCoordinates.length >= 2) appendCoordinates(coordinates, wayCoordinates);
  }

  const stops = relation.members.flatMap((member) => {
    if (!String(member.role).startsWith('stop')) return [];
    const entity = elementByKey.get(elementKey(member.type, member.ref));
    const coordinate = entityCoordinate(entity, elementByKey);
    return coordinate
      ? [
          {
            coordinate,
            names: entityNames(entity),
          },
        ]
      : [];
  });
  return {
    coordinates,
    stops,
  };
}

function matchedStation(stop, candidates, namesMatch) {
  const namedCandidates = candidates.filter((candidate) =>
    stop.names.some((name) => namesMatch(candidate.name, name)),
  );
  const pool = namedCandidates.length > 0 ? namedCandidates : candidates;
  const match = pool
    .map((candidate) => ({
      candidate,
      distanceMeters: distanceMeters(stop.coordinate, candidate.coordinate),
    }))
    .sort((first, second) => first.distanceMeters - second.distanceMeters)[0];
  if (
    !match ||
    (namedCandidates.length === 0 &&
      match.distanceMeters > MAX_UNNAMED_STOP_MATCH_METERS)
  ) {
    return null;
  }
  return match.candidate;
}

/**
 * Turns ordered OpenStreetMap public-transport route relations into one
 * averaged station-to-station centerline. Each direction is a distinct
 * observation, so parallel track sides collapse to their physical midpoint.
 */
export function buildOsmRouteCenterlines({
  allowedEdgeKeys,
  namesMatch,
  relations,
  stationCandidatesByLine,
  stationCoordinateById,
}) {
  const sectionsByEdge = new Map();
  let matchedStopCount = 0;
  let routeObservationCount = 0;

  for (const { data, lineName, relationId } of relations) {
    const candidates = stationCandidatesByLine.get(lineName) ?? [];
    if (candidates.length === 0) continue;
    const observation = osmRouteObservation(data, relationId);
    if (observation.coordinates.length < 2) continue;

    const stationIds = [];
    for (const stop of observation.stops) {
      const station = matchedStation(stop, candidates, namesMatch);
      if (!station || stationIds.at(-1) === station.id) continue;
      stationIds.push(station.id);
      matchedStopCount += 1;
    }

    const isClosedRoute =
      observation.coordinates.length >= 4 &&
      distanceMeters(observation.coordinates[0], observation.coordinates.at(-1)) < 250;
    const orderedStationIds =
      isClosedRoute &&
      stationIds.length > 2 &&
      allowedEdgeKeys.has(stationEdgeKey(stationIds.at(-1), stationIds[0]))
        ? [...stationIds, stationIds[0]]
        : stationIds;
    let contributed = false;
    for (let index = 1; index < orderedStationIds.length; index += 1) {
      const previousId = orderedStationIds[index - 1];
      const currentId = orderedStationIds[index];
      const key = stationEdgeKey(previousId, currentId);
      if (!allowedEdgeKeys.has(key)) continue;
      const section = (isClosedRoute ? extractClosedShapeSection : extractShapeSection)(
        observation.coordinates,
        stationCoordinateById.get(previousId),
        stationCoordinateById.get(currentId),
      );
      if (!section) continue;
      const [canonicalFromId] = key.split(EDGE_KEY_SEPARATOR);
      const oriented =
        previousId === canonicalFromId ? section : [...section].reverse();
      const sections = sectionsByEdge.get(key) ?? [];
      sections.push(oriented);
      sectionsByEdge.set(key, sections);
      contributed = true;
    }
    if (contributed) routeObservationCount += 1;
  }

  const geometries = {};
  let shapeObservationCount = 0;
  for (const [key, sections] of [...sectionsByEdge].sort(([first], [second]) =>
    first.localeCompare(second),
  )) {
    const [fromId, toId] = key.split(EDGE_KEY_SEPARATOR);
    const centerline = averageShapeSections(
      sections,
      stationCoordinateById.get(fromId),
      stationCoordinateById.get(toId),
    );
    if (!centerline) continue;
    (geometries[fromId] ??= []).push([toId, centerline]);
    shapeObservationCount += sections.length;
  }

  return {
    geometries,
    edgeCount: sectionsByEdge.size,
    matchedStopCount,
    routeObservationCount,
    shapeObservationCount,
  };
}
