export const WALKING_METERS_PER_MINUTE = 80;
export const DEFAULT_TIME_SCALE_MINUTES = 15;
export const DEFAULT_ESTIMATED_WAIT_MINUTES = 4;

const EARTH_RADIUS_M = 6_371_008.8;
const DEFAULT_TRANSFER_MINUTES = 3;

export function timeScaleStops(value = DEFAULT_TIME_SCALE_MINUTES) {
  const parsedValue = Number(value);
  const yellowMinutes = Number.isFinite(parsedValue)
    ? Math.min(120, Math.max(1, Math.round(parsedValue)))
    : DEFAULT_TIME_SCALE_MINUTES;

  return {
    yellowMinutes,
    orangeMinutes: yellowMinutes * 2,
    redMinutes: yellowMinutes * 4,
  };
}

function positiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

/**
 * Returns the expected wait at a station for a local weekday and time.
 * GTFS frequency windows may extend beyond midnight, so the previous service
 * day is included and the next week is searched when service has ended.
 */
export function scheduledWaitForStation(
  schedules,
  stationId,
  weekday,
  minuteOfDay,
  fallbackMinutes = DEFAULT_ESTIMATED_WAIT_MINUTES,
) {
  const profile = schedules?.stations?.[stationId];
  const normalizedWeekday = positiveModulo(Math.trunc(Number(weekday) || 0), 7);
  const normalizedMinute = Math.min(
    1_439.99,
    Math.max(0, Number(minuteOfDay) || 0),
  );

  if (!profile || !Array.isArray(profile.d)) {
    return {
      minutes: fallbackMinutes,
      scheduled: false,
      routeCount: 0,
    };
  }

  let bestWait = Number.POSITIVE_INFINITY;

  // Offset -1 captures service such as 24:00–29:00 from the previous day.
  // Eight following offsets are enough to find the next weekly service.
  for (let dayOffset = -1; dayOffset <= 7; dayOffset += 1) {
    const serviceWeekday = positiveModulo(normalizedWeekday + dayOffset, 7);
    const windows = profile.d[serviceWeekday] ?? [];

    for (const [startMinute, endMinute, headwayMinutes] of windows) {
      const absoluteStart = dayOffset * 1_440 + Number(startMinute);
      const absoluteEnd = dayOffset * 1_440 + Number(endMinute);
      const headway = Number(headwayMinutes);
      if (![absoluteStart, absoluteEnd, headway].every(Number.isFinite)) continue;
      if (absoluteEnd <= normalizedMinute || headway <= 0) continue;

      const wait =
        normalizedMinute < absoluteStart
          ? absoluteStart - normalizedMinute
          : Math.min(headway / 2, absoluteEnd - normalizedMinute);
      bestWait = Math.min(bestWait, Math.max(0, wait));
    }
  }

  if (!Number.isFinite(bestWait)) {
    return {
      minutes: fallbackMinutes,
      scheduled: false,
      routeCount: profile.r?.length ?? 0,
    };
  }

  return {
    minutes: bestWait,
    scheduled: true,
    routeCount: profile.r?.length ?? 0,
  };
}

/**
 * Returns the expected wait for one route and direction at a station. Newer
 * schedule files store these profiles in `p`; older files fall back to the
 * station-wide profile so deployments remain backwards compatible.
 */
export function scheduledWaitForService(
  schedules,
  stationId,
  serviceKey,
  weekday,
  minuteOfDay,
  fallbackMinutes = DEFAULT_ESTIMATED_WAIT_MINUTES,
) {
  const stationProfile = schedules?.stations?.[stationId];
  const serviceDays = stationProfile?.p?.[serviceKey];
  if (!Array.isArray(serviceDays)) {
    return scheduledWaitForStation(
      schedules,
      stationId,
      weekday,
      minuteOfDay,
      fallbackMinutes,
    );
  }

  return scheduledWaitForStation(
    {
      stations: {
        [stationId]: {
          r: [serviceKey],
          d: serviceDays,
        },
      },
    },
    stationId,
    weekday,
    minuteOfDay,
    fallbackMinutes,
  );
}

const MODE_SPEED_KMH = {
  subway: 32,
  brt: 20,
  light_rail: 24,
  cable_car: 16,
  commuter_rail: 45,
  regional_rail: 55,
  monorail: 25,
};

const MODE_MAX_LINK_M = {
  subway: 3_500,
  brt: 2_500,
  light_rail: 3_500,
  cable_car: 4_000,
  commuter_rail: 12_000,
  regional_rail: 16_000,
  monorail: 4_000,
};

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function normalize(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

export function distanceMeters([lonA, latA], [lonB, latB]) {
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

function streetCoordinateKey([lon, lat]) {
  return `${lon},${lat}`;
}

function isCoordinate(coordinate) {
  return (
    Array.isArray(coordinate) &&
    coordinate.length >= 2 &&
    Number.isFinite(coordinate[0]) &&
    Number.isFinite(coordinate[1])
  );
}

/**
 * Returns coordinates used by more than one road feature. In OSM-derived
 * street data these shared vertices are the block boundaries at junctions.
 */
export function streetJunctionKeys(streetFeatures) {
  const ownerCounts = new Map();

  for (const feature of streetFeatures) {
    const featureCoordinates = new Set();
    for (const coordinate of feature.geometry?.coordinates ?? []) {
      if (isCoordinate(coordinate)) {
        featureCoordinates.add(streetCoordinateKey(coordinate));
      }
    }
    for (const key of featureCoordinates) {
      ownerCounts.set(key, (ownerCounts.get(key) ?? 0) + 1);
    }
  }

  const junctionKeys = new Set();
  for (const [key, ownerCount] of ownerCounts) {
    if (ownerCount > 1) junctionKeys.add(key);
  }
  return junctionKeys;
}

function interpolateCoordinate(start, end, ratio) {
  return [
    start[0] + (end[0] - start[0]) * ratio,
    start[1] + (end[1] - start[1]) * ratio,
  ];
}

function streetSegmentFeature(feature, coordinates) {
  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates },
    properties: { ...(feature.properties ?? {}) },
  };
}

/**
 * Splits one road into block-like scoring units. Shared junctions end a unit,
 * while the length cap keeps unusually long, unsplit roads locally accurate.
 */
export function splitStreetFeature(
  feature,
  junctionKeys = new Set(),
  { maxLengthMeters = 200 } = {},
) {
  const sourceCoordinates = feature.geometry?.coordinates ?? [];
  const coordinates = [];
  for (const coordinate of sourceCoordinates) {
    if (!isCoordinate(coordinate)) continue;
    const previous = coordinates.at(-1);
    if (
      !previous ||
      previous[0] !== coordinate[0] ||
      previous[1] !== coordinate[1]
    ) {
      coordinates.push(coordinate);
    }
  }
  if (coordinates.length < 2) return [];

  const lengthCap =
    Number.isFinite(maxLengthMeters) && maxLengthMeters > 0
      ? maxLengthMeters
      : Number.POSITIVE_INFINITY;
  const segments = [];
  let segmentCoordinates = [coordinates[0]];
  let segmentLength = 0;

  const finishSegment = () => {
    if (segmentCoordinates.length < 2) return;
    segments.push(streetSegmentFeature(feature, segmentCoordinates));
    segmentCoordinates = [segmentCoordinates.at(-1)];
    segmentLength = 0;
  };

  for (let coordinateIndex = 1; coordinateIndex < coordinates.length; coordinateIndex += 1) {
    let edgeStart = coordinates[coordinateIndex - 1];
    const edgeEnd = coordinates[coordinateIndex];
    let edgeLength = distanceMeters(edgeStart, edgeEnd);

    while (segmentLength + edgeLength > lengthCap + 1e-6) {
      const availableLength = lengthCap - segmentLength;
      if (availableLength <= 1e-6) {
        finishSegment();
        continue;
      }

      const splitCoordinate = interpolateCoordinate(
        edgeStart,
        edgeEnd,
        availableLength / edgeLength,
      );
      segmentCoordinates.push(splitCoordinate);
      finishSegment();
      edgeStart = splitCoordinate;
      edgeLength = distanceMeters(edgeStart, edgeEnd);
    }

    segmentCoordinates.push(edgeEnd);
    segmentLength += edgeLength;

    const isInteriorJunction =
      coordinateIndex < coordinates.length - 1 &&
      junctionKeys.has(streetCoordinateKey(edgeEnd));
    if (isInteriorJunction) finishSegment();
  }

  finishSegment();
  return segments;
}

/** Splits a road collection into independently scored block segments. */
export function splitStreetFeatures(streetFeatures, options = {}) {
  const junctionKeys = streetJunctionKeys(streetFeatures);
  return streetFeatures.flatMap((feature) =>
    splitStreetFeature(feature, junctionKeys, options),
  );
}

function projectCoordinate([lon, lat], referenceLatitude) {
  return {
    x:
      EARTH_RADIUS_M *
      toRadians(lon) *
      Math.cos(toRadians(referenceLatitude)),
    y: EARTH_RADIUS_M * toRadians(lat),
  };
}

function pointToSegmentDistanceSquared(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;

  if (dx === 0 && dy === 0) {
    return (point.x - start.x) ** 2 + (point.y - start.y) ** 2;
  }

  const position = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * dx + (point.y - start.y) * dy) /
        (dx * dx + dy * dy),
    ),
  );
  const closestX = start.x + position * dx;
  const closestY = start.y + position * dy;

  return (point.x - closestX) ** 2 + (point.y - closestY) ** 2;
}

function lineBounds(points) {
  return points.reduce(
    (bounds, point) => ({
      minX: Math.min(bounds.minX, point.x),
      minY: Math.min(bounds.minY, point.y),
      maxX: Math.max(bounds.maxX, point.x),
      maxY: Math.max(bounds.maxY, point.y),
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    },
  );
}

function stationGrid(stations, cellSize) {
  const cells = new Map();

  for (const station of stations) {
    const cellX = Math.floor(station.projected.x / cellSize);
    const cellY = Math.floor(station.projected.y / cellSize);
    const key = `${cellX},${cellY}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(station);
  }

  return {
    candidates(bounds, padding) {
      const result = [];
      const minCellX = Math.floor((bounds.minX - padding) / cellSize);
      const minCellY = Math.floor((bounds.minY - padding) / cellSize);
      const maxCellX = Math.floor((bounds.maxX + padding) / cellSize);
      const maxCellY = Math.floor((bounds.maxY + padding) / cellSize);

      for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
        for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
          const stationsInCell = cells.get(`${cellX},${cellY}`);
          if (stationsInCell) result.push(...stationsInCell);
        }
      }

      return result;
    },
  };
}

function insertNearestStation(nearestStations, candidate, candidateCount) {
  let insertIndex = nearestStations.length;
  while (
    insertIndex > 0 &&
    nearestStations[insertIndex - 1].distanceSquared > candidate.distanceSquared
  ) {
    insertIndex -= 1;
  }
  if (insertIndex >= candidateCount) return;
  nearestStations.splice(insertIndex, 0, candidate);
  if (nearestStations.length > candidateCount) nearestStations.pop();
}

function nearestStationsForLine(
  projectedLine,
  bounds,
  stationIndex,
  candidateCount,
  initialPadding,
  requiredModes = [],
) {
  const requiredCount = Math.min(candidateCount, stationIndex.stations.length);
  let padding = initialPadding;
  let nearestStations = [];
  let nearestByMode = new Map();

  for (let attempt = 0; attempt < 12; attempt += 1) {
    nearestStations = [];
    nearestByMode = new Map();
    const candidates = stationIndex.exhaustive
      ? stationIndex.stations
      : stationIndex.grid.candidates(bounds, padding);
    for (const station of candidates) {
      let distanceSquared = Number.POSITIVE_INFINITY;
      for (let segmentIndex = 0; segmentIndex < projectedLine.length - 1; segmentIndex += 1) {
        distanceSquared = Math.min(
          distanceSquared,
          pointToSegmentDistanceSquared(
            station.projected,
            projectedLine[segmentIndex],
            projectedLine[segmentIndex + 1],
          ),
        );
      }
      insertNearestStation(
        nearestStations,
        { station, distanceSquared },
        candidateCount,
      );
      const nearestForMode = nearestByMode.get(station.mode);
      if (!nearestForMode || distanceSquared < nearestForMode.distanceSquared) {
        nearestByMode.set(station.mode, { station, distanceSquared });
      }
    }

    const lastRequired = nearestStations[requiredCount - 1];
    const directCandidatesComplete =
      requiredCount === 0 ||
      (nearestStations.length >= requiredCount &&
        lastRequired &&
        Math.sqrt(lastRequired.distanceSquared) <= padding);
    const modeCandidatesComplete = requiredModes.every((mode) => {
      const candidate = nearestByMode.get(mode);
      return candidate && Math.sqrt(candidate.distanceSquared) <= padding;
    });
    if (stationIndex.exhaustive || (directCandidatesComplete && modeCandidatesComplete)) {
      break;
    }
    padding *= 2;
  }

  return { nearestByMode, nearestStations };
}

/**
 * Builds a reusable spatial scorer for large batches of short street segments.
 * Each geometry is projected once, then queried for its direct and per-mode
 * candidates without repeatedly sorting the full nearby station pool.
 */
export function createStreetAccessScorer(
  stationFeatures,
  {
    exhaustive = false,
    stationFilter = (feature) => feature.properties.status === 'open',
    modeForStation = (feature) => feature.properties.mode,
  } = {},
) {
  const matchingFeatures = stationFeatures.filter(stationFilter);
  if (matchingFeatures.length === 0) {
    throw new Error('No stations are available for street access calculations.');
  }

  const referenceLatitude =
    matchingFeatures.reduce(
      (sum, feature) => sum + feature.geometry.coordinates[1],
      0,
    ) / matchingFeatures.length;
  const stations = matchingFeatures.map((feature) => ({
    id: feature.properties.id,
    mode: modeForStation(feature),
    projected: projectCoordinate(feature.geometry.coordinates, referenceLatitude),
  }));
  const cellSize = 2_000;
  const indexForStations = (indexedStations) => ({
    stations: indexedStations,
    grid: stationGrid(indexedStations, cellSize),
    exhaustive: exhaustive || indexedStations.length <= 100,
  });
  const allStations = indexForStations(stations);
  const stationModes = new Set();
  for (const station of stations) {
    stationModes.add(station.mode);
  }

  const scoreFeature = (
    feature,
    {
      candidateCount,
      directStationProperty,
      directDistanceProperty,
      modeProperties,
    },
  ) => {
    const coordinates = feature.geometry?.coordinates ?? [];
    if (coordinates.length < 2) return;

    const projectedLine = coordinates.map((coordinate) =>
      projectCoordinate(coordinate, referenceLatitude),
    );
    const bounds = lineBounds(projectedLine);
    const initialPadding = Math.max(
      500,
      Number(feature.properties[directDistanceProperty]) + 500 || 5_500,
    );
    const requestedModes = Object.keys(modeProperties).filter((mode) =>
      stationModes.has(mode),
    );
    const { nearestByMode, nearestStations } = nearestStationsForLine(
      projectedLine,
      bounds,
      allStations,
      candidateCount,
      initialPadding,
      requestedModes,
    );

    if (candidateCount > 0) {
      for (
        let candidateIndex = 0;
        candidateIndex < candidateCount;
        candidateIndex += 1
      ) {
        const suffix = candidateIndex === 0 ? '' : String(candidateIndex + 1);
        const candidate = nearestStations[candidateIndex];
        if (candidate) {
          feature.properties[`${directStationProperty}${suffix}`] =
            candidate.station.id;
          feature.properties[`${directDistanceProperty}${suffix}`] = Math.round(
            Math.sqrt(candidate.distanceSquared),
          );
        }
      }
    }

    for (const [mode, properties] of Object.entries(modeProperties)) {
      const candidate = nearestByMode.get(mode);
      if (!candidate) continue;
      if (properties.station) {
        feature.properties[properties.station] = candidate.station.id;
      }
      if (properties.distance) {
        feature.properties[properties.distance] = Math.round(
          Math.sqrt(candidate.distanceSquared),
        );
      }
    }
  };

  const scoringOptions = (options = {}) => ({
    candidateCount: options.candidateCount ?? 0,
    directStationProperty: options.directStationProperty ?? 's',
    directDistanceProperty: options.directDistanceProperty ?? 'd',
    modeProperties: options.modeProperties ?? {},
  });

  return {
    score(streetFeatures, options = {}) {
      const resolvedOptions = scoringOptions(options);
      for (const feature of streetFeatures) {
        scoreFeature(feature, resolvedOptions);
      }
      return streetFeatures;
    },
    async scoreAsync(
      streetFeatures,
      { batchSize = 2_000, yieldControl = defaultYield, ...options } = {},
    ) {
      const resolvedOptions = scoringOptions(options);
      for (let index = 0; index < streetFeatures.length; index += 1) {
        scoreFeature(streetFeatures[index], resolvedOptions);
        if ((index + 1) % batchSize === 0) await yieldControl();
      }
      return streetFeatures;
    },
  };
}

function defaultYield() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(resolve);
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/**
 * Adds stable IDs and optional distances for the nearest matching stations.
 * Multiple candidates let destination routing choose the quickest walk +
 * transit combination; custom property/filter options also support per-mode
 * and future-station access indexes.
 */
export async function assignNearestStations(
  streetFeatures,
  stationFeatures,
  {
    batchSize = 5_000,
    candidateCount = 1,
    distanceForFeature = (feature) => feature.properties.d,
    onProgress = () => {},
    propertyKey = 's',
    distancePropertyKey = propertyKey === 's' ? 'd' : null,
    stationFilter = (feature) => feature.properties.status === 'open',
    yieldControl = defaultYield,
  } = {},
) {
  const matchingStations = stationFeatures
    .filter(stationFilter)
    .map((feature) => {
      const coordinates = feature.geometry.coordinates;
      return {
        id: feature.properties.id,
        coordinates,
        projected: projectCoordinate(coordinates, coordinates[1]),
      };
    });

  if (matchingStations.length === 0) {
    throw new Error('No stations are available for street access calculations.');
  }

  const referenceLatitude =
    matchingStations.reduce((sum, station) => sum + station.coordinates[1], 0) /
    matchingStations.length;
  for (const station of matchingStations) {
    station.projected = projectCoordinate(station.coordinates, referenceLatitude);
  }

  const cellSize = 2_000;
  const grid = stationGrid(matchingStations, cellSize);

  for (let index = 0; index < streetFeatures.length; index += 1) {
    const feature = streetFeatures[index];
    const coordinates = feature.geometry?.coordinates ?? [];
    if (coordinates.length < 2) continue;

    const projectedLine = coordinates.map((coordinate) =>
      projectCoordinate(coordinate, referenceLatitude),
    );
    const bounds = lineBounds(projectedLine);
    let padding = Math.max(
      500,
      Number(distanceForFeature(feature, index)) + 500 || 5_500,
    );
    let candidates = [];
    let nearestStations = [];

    // Distances over the data cap need a wider search. Once the best point is
    // inside the padding radius, a point outside the search bounds cannot win.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      candidates = grid.candidates(bounds, padding);
      nearestStations = candidates
        .map((station) => {
          let distanceSquared = Number.POSITIVE_INFINITY;
          for (
            let segmentIndex = 0;
            segmentIndex < projectedLine.length - 1;
            segmentIndex += 1
          ) {
            distanceSquared = Math.min(
              distanceSquared,
              pointToSegmentDistanceSquared(
                station.projected,
                projectedLine[segmentIndex],
                projectedLine[segmentIndex + 1],
              ),
            );
          }
          return { station, distanceSquared };
        })
        .sort((first, second) => first.distanceSquared - second.distanceSquared);

      const lastRequired =
        nearestStations[Math.min(candidateCount, nearestStations.length) - 1];
      if (
        nearestStations.length >= Math.min(candidateCount, matchingStations.length) &&
        lastRequired &&
        Math.sqrt(lastRequired.distanceSquared) <= padding
      ) break;
      padding *= 2;
    }

    for (let candidateIndex = 0; candidateIndex < candidateCount; candidateIndex += 1) {
      const suffix = candidateIndex === 0 ? '' : String(candidateIndex + 1);
      const candidate = nearestStations[candidateIndex];
      const stationProperty = `${propertyKey}${suffix}`;
      const distanceProperty = distancePropertyKey
        ? `${distancePropertyKey}${suffix}`
        : null;
      if (candidate) {
        feature.properties[stationProperty] = candidate.station.id;
        if (distanceProperty) {
          feature.properties[distanceProperty] = Math.round(
            Math.sqrt(candidate.distanceSquared),
          );
        }
      } else {
        delete feature.properties[stationProperty];
        if (distanceProperty) delete feature.properties[distanceProperty];
      }
    }

    if ((index + 1) % batchSize === 0) {
      onProgress(index + 1, streetFeatures.length);
      await yieldControl();
    }
  }

  onProgress(streetFeatures.length, streetFeatures.length);
  return streetFeatures;
}

function routeGroups(properties) {
  const groups = new Set();
  const values = [properties.route_ref, properties.route_name];
  const normalizedNetwork = normalize(properties.network);

  if (
    normalizedNetwork &&
    !/^(metrobus|stc metro|metro cdmx|mexibus|cablebus)$/.test(normalizedNetwork)
  ) {
    values.push(properties.network);
  }

  for (const value of values) {
    for (const part of String(value ?? '').split(';')) {
      const normalizedPart = normalize(part);
      if (normalizedPart) groups.add(normalizedPart);
    }
  }

  return groups;
}

function groupsOverlap(first, second) {
  for (const group of first) {
    if (second.has(group)) return true;
  }
  return false;
}

function rideMinutes(mode, meters) {
  const speedKmh = MODE_SPEED_KMH[mode] ?? 22;
  return meters / ((speedKmh * 1_000) / 60) + 0.55;
}

function addUndirectedEdge(adjacency, from, to, minutes) {
  const addOneWay = (start, end) => {
    const existing = adjacency.get(start).get(end);
    if (existing === undefined || minutes < existing) {
      adjacency.get(start).set(end, minutes);
    }
  };

  addOneWay(from, to);
  addOneWay(to, from);
}

/**
 * Builds a lightweight transit graph from station mode, route metadata, and
 * geography. Ride times are estimates because the source does not contain a
 * published timetable.
 */
export function buildTransitGraph(stationFeatures, { includeFuture = false } = {}) {
  const nodes = stationFeatures
    .filter(
      (feature) =>
        feature.properties.status === 'open' || includeFuture,
    )
    .map((feature) => ({
      id: feature.properties.id,
      name: feature.properties.name,
      normalizedName: normalize(feature.properties.name),
      mode: feature.properties.mode,
      coordinates: feature.geometry.coordinates,
      groups: routeGroups(feature.properties),
    }));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const adjacency = new Map(nodes.map((node) => [node.id, new Map()]));
  const rideCandidates = new Map(nodes.map((node) => [node.id, []]));

  for (let firstIndex = 0; firstIndex < nodes.length; firstIndex += 1) {
    const first = nodes[firstIndex];

    for (let secondIndex = firstIndex + 1; secondIndex < nodes.length; secondIndex += 1) {
      const second = nodes[secondIndex];
      const meters = distanceMeters(first.coordinates, second.coordinates);
      const sameNamedPlace =
        first.normalizedName &&
        first.normalizedName === second.normalizedName &&
        meters <= 900;

      if (sameNamedPlace) {
        addUndirectedEdge(
          adjacency,
          first.id,
          second.id,
          Math.max(0.35, meters / WALKING_METERS_PER_MINUTE),
        );
      } else if (meters <= 300) {
        addUndirectedEdge(
          adjacency,
          first.id,
          second.id,
          DEFAULT_TRANSFER_MINUTES + meters / WALKING_METERS_PER_MINUTE,
        );
      }

      if (first.mode !== second.mode) continue;
      const maxLink = MODE_MAX_LINK_M[first.mode] ?? 3_000;
      if (meters > maxLink) continue;

      const bothHaveGroups = first.groups.size > 0 && second.groups.size > 0;
      if (bothHaveGroups && !groupsOverlap(first.groups, second.groups)) continue;

      rideCandidates.get(first.id).push({ id: second.id, meters });
      rideCandidates.get(second.id).push({ id: first.id, meters });
    }
  }

  for (const node of nodes) {
    let candidates = rideCandidates
      .get(node.id)
      // Co-located OSM station/platform records are already joined as a
      // transfer. Do not let those duplicates consume every onward ride link.
      .filter((candidate) => candidate.meters > 300);

    // Some OSM station points lack route membership. Connect those points to
    // nearby stations of the same mode so they still participate in routing.
    if (candidates.length === 0) {
      const maxLink = MODE_MAX_LINK_M[node.mode] ?? 3_000;
      candidates = nodes
        .filter((candidate) => candidate.id !== node.id && candidate.mode === node.mode)
        .map((candidate) => ({
          id: candidate.id,
          meters: distanceMeters(node.coordinates, candidate.coordinates),
        }))
        .filter(
          (candidate) =>
            candidate.meters > 300 && candidate.meters <= maxLink,
        );
    }

    candidates
      .sort((first, second) => first.meters - second.meters)
      .slice(0, 3)
      .forEach((candidate) => {
        addUndirectedEdge(
          adjacency,
          node.id,
          candidate.id,
          rideMinutes(node.mode, candidate.meters),
        );
      });
  }

  return { nodes, nodeById, adjacency };
}

function routeStateKey(stationId, serviceKey) {
  return `${stationId}\u0000${serviceKey}`;
}

function addReverseTransfer(reverseTransfers, from, to, minutes) {
  if (!reverseTransfers.has(to)) reverseTransfers.set(to, new Map());
  const existing = reverseTransfers.get(to).get(from);
  if (existing === undefined || minutes < existing) {
    reverseTransfers.get(to).set(from, minutes);
  }
}

/**
 * Attaches GTFS-derived ride and transfer edges to the station graph. Ride
 * edges preserve route + direction, which is required to charge a fresh wait
 * only when a passenger actually boards or changes service.
 */
export function attachScheduleGraph(graph, schedules) {
  const ridePredecessors = new Map();
  const servicesByStation = new Map(graph.nodes.map((node) => [node.id, new Set()]));
  const reverseTransfers = new Map(
    graph.nodes.map((node) => [node.id, new Map()]),
  );
  const stationIds = new Set(graph.nodes.map((node) => node.id));

  for (const [fromStationId, edges] of Object.entries(schedules?.graph?.e ?? {})) {
    if (!stationIds.has(fromStationId)) continue;
    for (const [toStationId, rawMinutes, serviceKey] of edges ?? []) {
      const minutes = Number(rawMinutes);
      if (
        !stationIds.has(toStationId) ||
        !serviceKey ||
        !Number.isFinite(minutes) ||
        minutes <= 0
      ) continue;
      servicesByStation.get(fromStationId).add(serviceKey);
      servicesByStation.get(toStationId).add(serviceKey);
      const destinationState = routeStateKey(toStationId, serviceKey);
      const predecessors = ridePredecessors.get(destinationState) ?? [];
      predecessors.push([fromStationId, minutes]);
      ridePredecessors.set(destinationState, predecessors);
    }
  }

  for (const [fromStationId, edges] of Object.entries(schedules?.graph?.t ?? {})) {
    if (!stationIds.has(fromStationId)) continue;
    for (const [toStationId, rawMinutes] of edges ?? []) {
      const minutes = Number(rawMinutes);
      if (!stationIds.has(toStationId) || !Number.isFinite(minutes) || minutes < 0) {
        continue;
      }
      addReverseTransfer(reverseTransfers, fromStationId, toStationId, minutes);
    }
  }

  // Cross-feed complexes (for example subway ↔ commuter rail) do not always
  // publish transfers in one GTFS archive. Add only plausible pedestrian
  // links here; route geometry is never inferred from proximity.
  for (let firstIndex = 0; firstIndex < graph.nodes.length; firstIndex += 1) {
    const first = graph.nodes[firstIndex];
    for (let secondIndex = firstIndex + 1; secondIndex < graph.nodes.length; secondIndex += 1) {
      const second = graph.nodes[secondIndex];
      const meters = distanceMeters(first.coordinates, second.coordinates);
      const sameNamedPlace =
        first.normalizedName &&
        first.normalizedName === second.normalizedName &&
        meters <= 900;
      if (!sameNamedPlace && meters > 250) continue;
      const minutes = sameNamedPlace
        ? Math.max(0.35, meters / WALKING_METERS_PER_MINUTE)
        : DEFAULT_TRANSFER_MINUTES + meters / WALKING_METERS_PER_MINUTE;
      addReverseTransfer(reverseTransfers, first.id, second.id, minutes);
      addReverseTransfer(reverseTransfers, second.id, first.id, minutes);
    }
  }

  return {
    ...graph,
    scheduleGraph: {
      ridePredecessors,
      reverseTransfers,
      servicesByStation,
    },
  };
}

class MinHeap {
  constructor() {
    this.items = [];
  }

  push(item) {
    this.items.push(item);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent].minutes <= item.minutes) break;
      this.items[index] = this.items[parent];
      index = parent;
    }
    this.items[index] = item;
  }

  pop() {
    if (this.items.length === 0) return null;
    const first = this.items[0];
    const last = this.items.pop();
    if (this.items.length === 0) return first;

    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.items.length) break;
      const smaller =
        right < this.items.length &&
        this.items[right].minutes < this.items[left].minutes
          ? right
          : left;
      if (this.items[smaller].minutes >= last.minutes) break;
      this.items[index] = this.items[smaller];
      index = smaller;
    }
    this.items[index] = last;
    return first;
  }
}

export function calculateTransitTimes(
  graph,
  destinationId,
  { waitMinutesByStation = new Map(), waitMinutesByService = new Map() } = {},
) {
  const destinationIds = Array.isArray(destinationId) ? destinationId : [destinationId];
  const validDestinationIds = destinationIds.filter((id) => graph.nodeById.has(id));
  if (validDestinationIds.length === 0) {
    throw new Error(`Unknown destination station: ${destinationIds.join(', ')}`);
  }

  if (graph.scheduleGraph) {
    return calculateScheduledTransitTimes(graph, validDestinationIds, {
      waitMinutesByStation,
      waitMinutesByService,
    });
  }

  const minutesByStation = new Map(
    graph.nodes.map((node) => [node.id, Number.POSITIVE_INFINITY]),
  );
  const queue = new MinHeap();
  for (const id of validDestinationIds) {
    minutesByStation.set(id, 0);
    queue.push({ id, minutes: 0 });
  }

  while (queue.items.length > 0) {
    const current = queue.pop();
    if (current.minutes !== minutesByStation.get(current.id)) continue;

    for (const [neighborId, edgeMinutes] of graph.adjacency.get(current.id)) {
      const nextMinutes = current.minutes + edgeMinutes;
      if (nextMinutes >= minutesByStation.get(neighborId)) continue;
      minutesByStation.set(neighborId, nextMinutes);
      queue.push({ id: neighborId, minutes: nextMinutes });
    }
  }

  for (const node of graph.nodes) {
    const minutes = minutesByStation.get(node.id);
    if (Number.isFinite(minutes)) {
      if (minutes > 0) {
        const waitMinutes =
          waitMinutesByStation.get(node.id) ?? DEFAULT_ESTIMATED_WAIT_MINUTES;
        minutesByStation.set(node.id, minutes + waitMinutes);
      }
      continue;
    }

    minutesByStation.set(node.id, 90);
  }

  return minutesByStation;
}

function calculateScheduledTransitTimes(
  graph,
  destinationIds,
  { waitMinutesByStation, waitMinutesByService },
) {
  const { ridePredecessors, reverseTransfers, servicesByStation } =
    graph.scheduleGraph;
  const baseMinutes = new Map(
    graph.nodes.map((node) => [node.id, Number.POSITIVE_INFINITY]),
  );
  const routeMinutes = new Map();
  const serviceByStation = new Map();
  const queue = new MinHeap();

  const relaxBase = (stationId, minutes, serviceKey = null) => {
    if (minutes >= (baseMinutes.get(stationId) ?? Number.POSITIVE_INFINITY)) return;
    baseMinutes.set(stationId, minutes);
    if (serviceKey) serviceByStation.set(stationId, serviceKey);
    queue.push({ id: stationId, kind: 'base', minutes });
  };
  const relaxRoute = (stationId, serviceKey, minutes) => {
    const key = routeStateKey(stationId, serviceKey);
    if (minutes >= (routeMinutes.get(key) ?? Number.POSITIVE_INFINITY)) return;
    routeMinutes.set(key, minutes);
    queue.push({ id: stationId, serviceKey, kind: 'route', minutes });
  };

  for (const stationId of destinationIds) relaxBase(stationId, 0);

  while (queue.items.length > 0) {
    const current = queue.pop();
    if (current.kind === 'base') {
      if (current.minutes !== baseMinutes.get(current.id)) continue;

      // Reverse of alighting: reaching a platform from the destination-side
      // station concourse is free.
      for (const serviceKey of servicesByStation.get(current.id) ?? []) {
        relaxRoute(current.id, serviceKey, current.minutes);
      }
      for (const [fromStationId, transferMinutes] of
        reverseTransfers.get(current.id) ?? []) {
        relaxBase(fromStationId, current.minutes + transferMinutes);
      }
      continue;
    }

    const currentKey = routeStateKey(current.id, current.serviceKey);
    if (current.minutes !== routeMinutes.get(currentKey)) continue;

    // Reverse of boarding. This is evaluated once at every actual boarding,
    // including after a transfer to another service.
    const serviceWait =
      waitMinutesByService.get(currentKey) ??
      waitMinutesByStation.get(current.id) ??
      DEFAULT_ESTIMATED_WAIT_MINUTES;
    relaxBase(current.id, current.minutes + serviceWait, current.serviceKey);

    for (const [fromStationId, rideMinutes] of
      ridePredecessors.get(currentKey) ?? []) {
      relaxRoute(fromStationId, current.serviceKey, current.minutes + rideMinutes);
    }
  }

  for (const [stationId, minutes] of baseMinutes) {
    if (!Number.isFinite(minutes)) baseMinutes.set(stationId, 90);
  }
  baseMinutes.serviceByStation = serviceByStation;
  return baseMinutes;
}

export function streetTravelTime(properties, transitTimes, candidateCount = 5) {
  let best = null;

  for (let candidateIndex = 0; candidateIndex < candidateCount; candidateIndex += 1) {
    const suffix = candidateIndex === 0 ? '' : String(candidateIndex + 1);
    const stationId = properties[`s${suffix}`];
    const distance = Number(properties[`d${suffix}`]);
    if (!stationId || !Number.isFinite(distance)) continue;
    const walkingMinutes = distance / WALKING_METERS_PER_MINUTE;
    const transitMinutes = transitTimes.get(stationId) ?? 90;
    const candidate = {
      stationId,
      distance,
      walkingMinutes,
      transitMinutes,
      totalMinutes: walkingMinutes + transitMinutes,
    };
    if (!best || candidate.totalMinutes < best.totalMinutes) best = candidate;
  }

  return best ?? {
    stationId: null,
    distance: Number.POSITIVE_INFINITY,
    walkingMinutes: Number.POSITIVE_INFINITY,
    transitMinutes: 90,
    totalMinutes: Number.POSITIVE_INFINITY,
  };
}

export function bestStreetTravelTime(accessCandidates, transitTimes) {
  let best = null;

  for (const candidate of accessCandidates) {
    const distanceMeters = Number(candidate.distanceMeters);
    if (!Number.isFinite(distanceMeters) || !candidate.stationId) continue;

    const walkingMinutes = distanceMeters / WALKING_METERS_PER_MINUTE;
    const transitMinutes = transitTimes.get(candidate.stationId) ?? 90;
    const travel = {
      ...candidate,
      walkingMinutes,
      transitMinutes,
      totalMinutes: walkingMinutes + transitMinutes,
    };

    if (!best || travel.totalMinutes < best.totalMinutes) best = travel;
  }

  return best;
}
