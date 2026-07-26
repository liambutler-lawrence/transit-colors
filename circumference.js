const EARTH_RADIUS_M = 6_371_008.8;
const NAME_TRANSFER_DISTANCE_M = 350;
const EDGE_KEY_SEPARATOR = '\u0000';

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function normalizeLongitudeDelta(delta) {
  if (delta > Math.PI) return delta - Math.PI * 2;
  if (delta < -Math.PI) return delta + Math.PI * 2;
  return delta;
}

function normalizeStationName(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(?:linea|line|l)\s*(?:\d+|[a-z])\b/gi, ' ')
    .replace(/[-/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function distanceMeters([lonA, latA], [lonB, latB]) {
  const latARadians = toRadians(latA);
  const latBRadians = toRadians(latB);
  const latitudeDelta = latBRadians - latARadians;
  const longitudeDelta = toRadians(lonB - lonA);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latARadians) *
      Math.cos(latBRadians) *
      Math.sin(longitudeDelta / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(haversine));
}

function signedProjectedArea(coordinates) {
  const referenceLatitude =
    coordinates.reduce((total, coordinate) => total + coordinate[1], 0) /
    coordinates.length;
  const longitudeScale = Math.cos(toRadians(referenceLatitude));
  let twiceArea = 0;

  for (let index = 0; index < coordinates.length; index += 1) {
    const current = coordinates[index];
    const next = coordinates[(index + 1) % coordinates.length];
    const currentX = toRadians(current[0]) * longitudeScale * EARTH_RADIUS_M;
    const currentY = toRadians(current[1]) * EARTH_RADIUS_M;
    const nextX = toRadians(next[0]) * longitudeScale * EARTH_RADIUS_M;
    const nextY = toRadians(next[1]) * EARTH_RADIUS_M;
    twiceArea += currentX * nextY - nextX * currentY;
  }

  return twiceArea / 2;
}

/**
 * Chamberlain-Duquette spherical polygon area. At metro scale this avoids the
 * latitude distortion of ordinary degree-based shoelace calculations while
 * keeping route and landmass measurements in one consistent model.
 */
export function polygonAreaSquareMeters(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 3) return 0;

  const ring =
    coordinates.length > 3 &&
    coordinates[0][0] === coordinates.at(-1)[0] &&
    coordinates[0][1] === coordinates.at(-1)[1]
      ? coordinates.slice(0, -1)
      : coordinates;
  let areaAccumulator = 0;

  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    const longitudeDelta = normalizeLongitudeDelta(
      toRadians(next[0]) - toRadians(current[0]),
    );
    areaAccumulator +=
      longitudeDelta *
      (2 + Math.sin(toRadians(current[1])) + Math.sin(toRadians(next[1])));
  }

  return Math.abs((areaAccumulator * EARTH_RADIUS_M ** 2) / 2);
}

export function lineLengthMeters(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return 0;
  let length = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    length += distanceMeters(coordinates[index - 1], coordinates[index]);
  }
  return length;
}

class UnionFind {
  constructor(ids) {
    this.parent = new Map(ids.map((id) => [id, id]));
  }

  has(id) {
    return this.parent.has(id);
  }

  find(id) {
    const parent = this.parent.get(id);
    if (parent === id) return id;
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }

  union(firstId, secondId) {
    if (!this.has(firstId) || !this.has(secondId)) return false;
    const firstRoot = this.find(firstId);
    const secondRoot = this.find(secondId);
    if (firstRoot === secondRoot) return false;
    this.parent.set(secondRoot, firstRoot);
    return true;
  }
}

function edgeKey(firstId, secondId) {
  return [firstId, secondId].sort().join(EDGE_KEY_SEPARATOR);
}

function routeIdForService(serviceKey) {
  const separatorIndex = String(serviceKey).lastIndexOf('/');
  return separatorIndex === -1
    ? String(serviceKey)
    : String(serviceKey).slice(0, separatorIndex);
}

function removeBranches(adjacency) {
  const activeNodes = new Set(adjacency.keys());
  const pending = [...adjacency]
    .filter(([, neighbors]) => neighbors.size < 2)
    .map(([nodeId]) => nodeId);

  while (pending.length > 0) {
    const nodeId = pending.pop();
    if (!activeNodes.delete(nodeId)) continue;

    for (const neighborId of adjacency.get(nodeId) ?? []) {
      if (!activeNodes.has(neighborId)) continue;
      adjacency.get(neighborId).delete(nodeId);
      if (adjacency.get(neighborId).size < 2) pending.push(neighborId);
    }
  }

  for (const nodeId of [...adjacency.keys()]) {
    if (!activeNodes.has(nodeId)) {
      adjacency.delete(nodeId);
      continue;
    }
    for (const neighborId of [...adjacency.get(nodeId)]) {
      if (!activeNodes.has(neighborId)) adjacency.get(nodeId).delete(neighborId);
    }
  }
}

function stableCandidateId(nodeIds) {
  const sequences = [];
  for (const sequence of [nodeIds, [...nodeIds].reverse()]) {
    for (let offset = 0; offset < sequence.length; offset += 1) {
      sequences.push([...sequence.slice(offset), ...sequence.slice(0, offset)].join('|'));
    }
  }
  const canonical = sequences.sort()[0];
  let hash = 2_166_136_261;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `route-${(hash >>> 0).toString(36)}`;
}

function traceFaces(adjacency, nodes) {
  const sortedNeighbors = new Map();
  for (const [nodeId, neighbors] of adjacency) {
    const [originLongitude, originLatitude] = nodes.get(nodeId).coordinate;
    sortedNeighbors.set(
      nodeId,
      [...neighbors].sort((firstId, secondId) => {
        const first = nodes.get(firstId).coordinate;
        const second = nodes.get(secondId).coordinate;
        return (
          Math.atan2(first[1] - originLatitude, first[0] - originLongitude) -
          Math.atan2(second[1] - originLatitude, second[0] - originLongitude)
        );
      }),
    );
  }

  const visitedDirections = new Set();
  const faces = [];

  for (const [startId, neighbors] of sortedNeighbors) {
    for (const nextId of neighbors) {
      const startingDirection = `${startId}${EDGE_KEY_SEPARATOR}${nextId}`;
      if (visitedDirections.has(startingDirection)) continue;

      const path = [];
      let previousId = startId;
      let currentId = nextId;
      let guard = 0;

      while (guard < adjacency.size * 4) {
        guard += 1;
        const direction = `${previousId}${EDGE_KEY_SEPARATOR}${currentId}`;
        if (visitedDirections.has(direction)) break;
        visitedDirections.add(direction);
        path.push(previousId);

        const currentNeighbors = sortedNeighbors.get(currentId);
        const incomingIndex = currentNeighbors.indexOf(previousId);
        if (incomingIndex === -1) break;
        const followingId =
          currentNeighbors[
            (incomingIndex - 1 + currentNeighbors.length) %
              currentNeighbors.length
          ];
        previousId = currentId;
        currentId = followingId;

        if (previousId === startId && currentId === nextId) break;
      }

      const closed = previousId === startId && currentId === nextId;
      const isSimple = new Set(path).size === path.length;
      if (!closed || !isSimple || path.length < 3) continue;

      const coordinates = path.map((nodeId) => nodes.get(nodeId).coordinate);
      if (signedProjectedArea(coordinates) <= 0) continue;
      faces.push(path);
    }
  }

  return faces;
}

function representativeName(features) {
  return (
    features
      .map((feature) => feature.properties.name)
      .filter(Boolean)
      .sort((first, second) => first.length - second.length)[0] ||
    'Unnamed interchange'
  );
}

function sortLineNames(first, second) {
  return String(first).localeCompare(String(second), 'en', {
    numeric: true,
    sensitivity: 'base',
  });
}

/**
 * Builds closed metro loops from route edges and zero-fare interchanges.
 * Candidate faces are derived from the planar network and ranked on the
 * largest contained area. Returning several ranked candidates provides a
 * stable manual override without changing the source feed.
 */
export function buildCircumferenceCandidates(
  stationFeatures,
  schedules,
  { maxCandidates = 12, minimumAreaSquareMeters = 250_000 } = {},
) {
  const eligibleStations = stationFeatures.filter(
    (feature) =>
      feature.properties?.mode === 'subway' &&
      feature.properties?.status === 'open',
  );
  const stationById = new Map(
    eligibleStations.map((feature) => [feature.properties.id, feature]),
  );
  const unions = new UnionFind([...stationById.keys()]);
  let publishedTransferCount = 0;
  let inferredTransferCount = 0;

  for (const [fromStationId, transfers] of Object.entries(
    schedules?.graph?.t ?? {},
  )) {
    for (const [toStationId] of transfers) {
      if (unions.union(fromStationId, toStationId)) publishedTransferCount += 1;
    }
  }

  const stationsByName = new Map();
  for (const feature of eligibleStations) {
    const normalizedName = normalizeStationName(feature.properties.name);
    if (!normalizedName) continue;
    const bucket = stationsByName.get(normalizedName) ?? [];
    bucket.push(feature);
    stationsByName.set(normalizedName, bucket);
  }

  for (const bucket of stationsByName.values()) {
    for (let firstIndex = 0; firstIndex < bucket.length; firstIndex += 1) {
      for (
        let secondIndex = firstIndex + 1;
        secondIndex < bucket.length;
        secondIndex += 1
      ) {
        const first = bucket[firstIndex];
        const second = bucket[secondIndex];
        if (
          distanceMeters(
            first.geometry.coordinates,
            second.geometry.coordinates,
          ) <= NAME_TRANSFER_DISTANCE_M &&
          unions.union(first.properties.id, second.properties.id)
        ) {
          inferredTransferCount += 1;
        }
      }
    }
  }

  const featuresByComplex = new Map();
  for (const feature of eligibleStations) {
    const complexId = unions.find(feature.properties.id);
    const members = featuresByComplex.get(complexId) ?? [];
    members.push(feature);
    featuresByComplex.set(complexId, members);
  }

  const nodes = new Map();
  for (const [complexId, features] of featuresByComplex) {
    nodes.set(complexId, {
      id: complexId,
      coordinate: [
        features.reduce(
          (total, feature) => total + feature.geometry.coordinates[0],
          0,
        ) / features.length,
        features.reduce(
          (total, feature) => total + feature.geometry.coordinates[1],
          0,
        ) / features.length,
      ],
      name: representativeName(features),
      stationIds: features.map((feature) => feature.properties.id),
    });
  }

  const adjacency = new Map([...nodes.keys()].map((nodeId) => [nodeId, new Set()]));
  const linesByEdge = new Map();

  for (const [fromStationId, edges] of Object.entries(
    schedules?.graph?.e ?? {},
  )) {
    if (!stationById.has(fromStationId)) continue;

    for (const [toStationId, , serviceKey] of edges) {
      if (!stationById.has(toStationId)) continue;
      const routeId = routeIdForService(serviceKey);
      const route = schedules?.routes?.[routeId];
      if (route?.mode !== 'subway') continue;

      const fromComplexId = unions.find(fromStationId);
      const toComplexId = unions.find(toStationId);
      if (fromComplexId === toComplexId) continue;

      adjacency.get(fromComplexId).add(toComplexId);
      adjacency.get(toComplexId).add(fromComplexId);
      const key = edgeKey(fromComplexId, toComplexId);
      const lines = linesByEdge.get(key) ?? new Set();
      lines.add(route.name || routeId);
      linesByEdge.set(key, lines);
    }
  }

  removeBranches(adjacency);
  const candidates = traceFaces(adjacency, nodes)
    .map((path) => {
      const openCoordinates = path.map((nodeId) => nodes.get(nodeId).coordinate);
      const coordinates = [...openCoordinates, openCoordinates[0]];
      const segments = path.map((nodeId, index) => {
        const nextId = path[(index + 1) % path.length];
        return {
          id: stableCandidateId([nodeId, nextId]).replace('route-', 'segment-'),
          from: nodes.get(nodeId),
          to: nodes.get(nextId),
          lines: [...(linesByEdge.get(edgeKey(nodeId, nextId)) ?? [])].sort(
            sortLineNames,
          ),
        };
      });
      const lines = [...new Set(segments.flatMap((segment) => segment.lines))].sort(
        sortLineNames,
      );

      return {
        id: stableCandidateId(path),
        nodeIds: path,
        stations: path.map((nodeId) => nodes.get(nodeId)),
        coordinates,
        segments,
        lines,
        areaSquareMeters: polygonAreaSquareMeters(coordinates),
        lengthMeters: lineLengthMeters(coordinates),
      };
    })
    .filter((candidate) => candidate.areaSquareMeters >= minimumAreaSquareMeters)
    .sort((first, second) => second.areaSquareMeters - first.areaSquareMeters)
    .slice(0, maxCandidates);

  return {
    candidates,
    methodology: {
      eligibleStationCount: eligibleStations.length,
      complexCount: nodes.size,
      coreComplexCount: adjacency.size,
      publishedTransferCount,
      inferredTransferCount,
    },
  };
}

export function selectCircumferenceCandidate(
  candidates,
  overrideId = '',
  { requiredSegmentIds = [], avoidedSegmentIds = [] } = {},
) {
  const requiredSegments = new Set(requiredSegmentIds);
  const avoidedSegments = new Set(avoidedSegmentIds);
  const matchingCandidates = candidates.filter((candidate) => {
    const candidateSegments = new Set(
      candidate.segments.map((segment) => segment.id),
    );
    return (
      [...requiredSegments].every((segmentId) =>
        candidateSegments.has(segmentId),
      ) &&
      [...avoidedSegments].every(
        (segmentId) => !candidateSegments.has(segmentId),
      )
    );
  });

  return (
    candidates.find((candidate) => candidate.id === overrideId) ??
    matchingCandidates[0] ??
    null
  );
}
