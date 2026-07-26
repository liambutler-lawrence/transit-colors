const EARTH_RADIUS_M = 6_371_008.8;
const EDGE_KEY_SEPARATOR = '\u0000';
const MAX_SHAPE_SAMPLES = 64;
const TARGET_SAMPLE_SPACING_M = 80;

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
      continue;
    }

    if (character === '"') quoted = true;
    else if (character === ',') {
      row.push(value);
      value = '';
    } else if (character === '\n') {
      row.push(value.replace(/\r$/, ''));
      if (row.some(Boolean)) rows.push(row);
      row = [];
      value = '';
    } else value += character;
  }

  if (value || row.length > 0) {
    row.push(value.replace(/\r$/, ''));
    if (row.some(Boolean)) rows.push(row);
  }

  const [headers, ...records] = rows;
  if (!headers) return [];
  return records.map((record) =>
    Object.fromEntries(headers.map((header, index) => [header, record[index] ?? ''])),
  );
}

export function stationEdgeKey(firstId, secondId) {
  return [firstId, secondId].sort().join(EDGE_KEY_SEPARATOR);
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function distanceMeters([longitudeA, latitudeA], [longitudeB, latitudeB]) {
  const latitudeARadians = toRadians(latitudeA);
  const latitudeBRadians = toRadians(latitudeB);
  const latitudeDelta = latitudeBRadians - latitudeARadians;
  const longitudeDelta = toRadians(longitudeB - longitudeA);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitudeARadians) *
      Math.cos(latitudeBRadians) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(haversine));
}

function lineLengthMeters(coordinates) {
  let length = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    length += distanceMeters(coordinates[index - 1], coordinates[index]);
  }
  return length;
}

function projectOntoShape(coordinate, shape) {
  const latitudeScale = Math.cos(toRadians(coordinate[1]));
  let best = null;

  for (let index = 1; index < shape.length; index += 1) {
    const start = shape[index - 1];
    const end = shape[index];
    const segmentX = (end[0] - start[0]) * latitudeScale;
    const segmentY = end[1] - start[1];
    const pointX = (coordinate[0] - start[0]) * latitudeScale;
    const pointY = coordinate[1] - start[1];
    const denominator = segmentX ** 2 + segmentY ** 2;
    const fraction =
      denominator === 0
        ? 0
        : Math.max(
            0,
            Math.min(1, (pointX * segmentX + pointY * segmentY) / denominator),
          );
    const projected = [
      start[0] + (end[0] - start[0]) * fraction,
      start[1] + (end[1] - start[1]) * fraction,
    ];
    const meters = distanceMeters(coordinate, projected);
    if (!best || meters < best.meters) {
      best = {
        segmentIndex: index - 1,
        fraction,
        position: index - 1 + fraction,
        coordinate: projected,
        meters,
      };
    }
  }
  return best;
}

function dedupeCoordinates(coordinates) {
  const result = [];
  for (const coordinate of coordinates) {
    if (!result.length || distanceMeters(result.at(-1), coordinate) >= 0.75) {
      result.push(coordinate);
    }
  }
  return result;
}

export function extractShapeSection(shape, fromCoordinate, toCoordinate) {
  if (!Array.isArray(shape) || shape.length < 2) return null;
  const fromProjection = projectOntoShape(fromCoordinate, shape);
  const toProjection = projectOntoShape(toCoordinate, shape);
  if (
    !fromProjection ||
    !toProjection ||
    fromProjection.meters > 1_500 ||
    toProjection.meters > 1_500 ||
    Math.abs(fromProjection.position - toProjection.position) < 1e-6
  ) {
    return null;
  }

  const reverse = fromProjection.position > toProjection.position;
  const startProjection = reverse ? toProjection : fromProjection;
  const endProjection = reverse ? fromProjection : toProjection;
  const section = [startProjection.coordinate];
  for (
    let index = startProjection.segmentIndex + 1;
    index <= endProjection.segmentIndex;
    index += 1
  ) {
    section.push(shape[index]);
  }
  section.push(endProjection.coordinate);
  if (reverse) section.reverse();
  section.unshift(fromCoordinate);
  section.push(toCoordinate);

  const deduped = dedupeCoordinates(section);
  const directLength = distanceMeters(fromCoordinate, toCoordinate);
  const sectionLength = lineLengthMeters(deduped);
  if (
    deduped.length < 2 ||
    sectionLength < directLength * 0.95 ||
    sectionLength > Math.max(12_000, directLength * 8)
  ) {
    return null;
  }
  return deduped;
}

export function resampleLine(coordinates, sampleCount) {
  if (coordinates.length === 0 || sampleCount <= 0) return [];
  if (coordinates.length === 1 || sampleCount === 1) return [coordinates[0]];

  const cumulative = [0];
  for (let index = 1; index < coordinates.length; index += 1) {
    cumulative.push(
      cumulative.at(-1) + distanceMeters(coordinates[index - 1], coordinates[index]),
    );
  }
  const totalLength = cumulative.at(-1);
  if (totalLength === 0) {
    return Array.from({ length: sampleCount }, () => coordinates[0]);
  }

  const result = [];
  let segmentIndex = 1;
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const targetDistance = (totalLength * sampleIndex) / Math.max(1, sampleCount - 1);
    while (
      segmentIndex < cumulative.length - 1 &&
      cumulative[segmentIndex] < targetDistance
    ) {
      segmentIndex += 1;
    }
    const startDistance = cumulative[segmentIndex - 1];
    const endDistance = cumulative[segmentIndex];
    const fraction =
      endDistance === startDistance
        ? 0
        : (targetDistance - startDistance) / (endDistance - startDistance);
    const start = coordinates[segmentIndex - 1];
    const end = coordinates[segmentIndex];
    result.push([
      start[0] + (end[0] - start[0]) * fraction,
      start[1] + (end[1] - start[1]) * fraction,
    ]);
  }
  return result;
}

export function averageShapeSections(
  sections,
  fromCoordinate = sections[0]?.[0],
  toCoordinate = sections[0]?.at(-1),
) {
  if (!sections.length || !fromCoordinate || !toCoordinate) return null;
  const maximumLength = Math.max(...sections.map(lineLengthMeters));
  const sampleCount = Math.max(
    3,
    Math.min(MAX_SHAPE_SAMPLES, Math.ceil(maximumLength / TARGET_SAMPLE_SPACING_M) + 1),
  );
  const sampled = sections.map((section) => resampleLine(section, sampleCount));
  const average = Array.from({ length: sampleCount }, (_, sampleIndex) => {
    const total = sampled.reduce(
      (sum, line) => [sum[0] + line[sampleIndex][0], sum[1] + line[sampleIndex][1]],
      [0, 0],
    );
    return [
      Number((total[0] / sampled.length).toFixed(6)),
      Number((total[1] / sampled.length).toFixed(6)),
    ];
  });
  average[0] = [...fromCoordinate];
  average[average.length - 1] = [...toCoordinate];
  return dedupeCoordinates(average);
}

export function buildGtfsShapeCenterlines({
  shapes,
  trips,
  stopTimes,
  stationCoordinateById,
  stationIdForStop,
  allowedEdgeKeys = null,
}) {
  const shapeById = new Map();
  for (const point of shapes) {
    const coordinate = [Number(point.shape_pt_lon), Number(point.shape_pt_lat)];
    if (!coordinate.every(Number.isFinite)) continue;
    const points = shapeById.get(point.shape_id) ?? [];
    points.push({
      sequence: Number(point.shape_pt_sequence),
      coordinate,
    });
    shapeById.set(point.shape_id, points);
  }
  for (const [shapeId, points] of shapeById) {
    shapeById.set(
      shapeId,
      points
        .sort((first, second) => first.sequence - second.sequence)
        .map((point) => point.coordinate),
    );
  }

  const tripById = new Map(
    trips
      .filter((trip) => shapeById.has(trip.shape_id))
      .map((trip) => [trip.trip_id, trip]),
  );
  const stopsByTrip = new Map();
  for (const stopTime of stopTimes) {
    if (!tripById.has(stopTime.trip_id)) continue;
    const entries = stopsByTrip.get(stopTime.trip_id) ?? [];
    entries.push(stopTime);
    stopsByTrip.set(stopTime.trip_id, entries);
  }

  const sectionsByEdge = new Map();
  const observedShapeEdges = new Set();
  for (const [tripId, entries] of stopsByTrip) {
    const trip = tripById.get(tripId);
    const shape = shapeById.get(trip.shape_id);
    entries.sort(
      (first, second) => Number(first.stop_sequence) - Number(second.stop_sequence),
    );
    let previous = null;
    for (const entry of entries) {
      const stationId = stationIdForStop(entry.stop_id, trip);
      if (!stationCoordinateById.has(stationId)) continue;
      const current = { stationId };
      if (!previous) {
        previous = current;
        continue;
      }
      if (previous.stationId === current.stationId) {
        previous = current;
        continue;
      }

      const key = stationEdgeKey(previous.stationId, current.stationId);
      if (allowedEdgeKeys && !allowedEdgeKeys.has(key)) {
        previous = current;
        continue;
      }
      const observationKey = `${key}\u0000${trip.shape_id}`;
      if (observedShapeEdges.has(observationKey)) {
        previous = current;
        continue;
      }
      observedShapeEdges.add(observationKey);

      const section = extractShapeSection(
        shape,
        stationCoordinateById.get(previous.stationId),
        stationCoordinateById.get(current.stationId),
      );
      if (section) {
        const [canonicalFromId] = key.split(EDGE_KEY_SEPARATOR);
        const oriented =
          previous.stationId === canonicalFromId ? section : [...section].reverse();
        const sections = sectionsByEdge.get(key) ?? [];
        sections.push(oriented);
        sectionsByEdge.set(key, sections);
      }
      previous = current;
    }
  }

  const geometries = {};
  let observationCount = 0;
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
    observationCount += sections.length;
  }

  return {
    geometries,
    edgeCount: sectionsByEdge.size,
    observationCount,
  };
}
