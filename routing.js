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
 * Adds the stable ID and distance of each street's nearest open station to
 * `properties.s` and `properties.d`. Existing precomputed distances are used
 * to keep the spatial search small.
 */
export async function assignNearestStations(
  streetFeatures,
  stationFeatures,
  { batchSize = 5_000, onProgress = () => {}, yieldControl = defaultYield } = {},
) {
  const openStations = stationFeatures
    .filter((feature) => feature.properties.status === 'open')
    .map((feature) => {
      const coordinates = feature.geometry.coordinates;
      return {
        id: feature.properties.id,
        coordinates,
        projected: projectCoordinate(coordinates, coordinates[1]),
      };
    });

  if (openStations.length === 0) {
    throw new Error('No open stations are available for street access calculations.');
  }

  const referenceLatitude =
    openStations.reduce((sum, station) => sum + station.coordinates[1], 0) /
    openStations.length;
  for (const station of openStations) {
    station.projected = projectCoordinate(station.coordinates, referenceLatitude);
  }

  const cellSize = 2_000;
  const grid = stationGrid(openStations, cellSize);

  for (let index = 0; index < streetFeatures.length; index += 1) {
    const feature = streetFeatures[index];
    const coordinates = feature.geometry?.coordinates ?? [];
    if (coordinates.length < 2) continue;

    const projectedLine = coordinates.map((coordinate) =>
      projectCoordinate(coordinate, referenceLatitude),
    );
    const bounds = lineBounds(projectedLine);
    let padding = Math.max(500, Number(feature.properties.d) + 500 || 5_500);
    let candidates = [];
    let bestStation = null;
    let bestDistanceSquared = Number.POSITIVE_INFINITY;

    // Distances over the data cap need a wider search. Once the best point is
    // inside the padding radius, a point outside the search bounds cannot win.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      candidates = grid.candidates(bounds, padding);
      bestStation = null;
      bestDistanceSquared = Number.POSITIVE_INFINITY;

      for (const station of candidates) {
        for (let segmentIndex = 0; segmentIndex < projectedLine.length - 1; segmentIndex += 1) {
          const distanceSquared = pointToSegmentDistanceSquared(
            station.projected,
            projectedLine[segmentIndex],
            projectedLine[segmentIndex + 1],
          );
          if (distanceSquared < bestDistanceSquared) {
            bestDistanceSquared = distanceSquared;
            bestStation = station;
          }
        }
      }

      if (bestStation && Math.sqrt(bestDistanceSquared) <= padding) break;
      padding *= 2;
    }

    if (bestStation) {
      feature.properties.s = bestStation.id;
      feature.properties.d = Math.round(Math.sqrt(bestDistanceSquared));
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
export function buildTransitGraph(stationFeatures) {
  const nodes = stationFeatures
    .filter((feature) => feature.properties.status === 'open')
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
  { waitMinutesByStation = new Map() } = {},
) {
  if (!graph.nodeById.has(destinationId)) {
    throw new Error(`Unknown destination station: ${destinationId}`);
  }

  const minutesByStation = new Map(
    graph.nodes.map((node) => [node.id, Number.POSITIVE_INFINITY]),
  );
  const queue = new MinHeap();
  minutesByStation.set(destinationId, 0);
  queue.push({ id: destinationId, minutes: 0 });

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

  const destination = graph.nodeById.get(destinationId);
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

    // Disconnected or incomplete OSM route membership falls back to a clearly
    // approximate cross-network trip instead of making the street uncolorable.
    const directMeters = distanceMeters(node.coordinates, destination.coordinates);
    const waitMinutes =
      waitMinutesByStation.get(node.id) ?? DEFAULT_ESTIMATED_WAIT_MINUTES;
    minutesByStation.set(node.id, 6 + waitMinutes + directMeters / 300);
  }

  return minutesByStation;
}

export function streetTravelTime(properties, transitTimes) {
  const walkingMinutes = Number(properties.d) / WALKING_METERS_PER_MINUTE;
  const transitMinutes = transitTimes.get(properties.s) ?? 90;

  return {
    walkingMinutes,
    transitMinutes,
    totalMinutes: walkingMinutes + transitMinutes,
  };
}
