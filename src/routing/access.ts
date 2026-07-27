import type {
  Coordinate,
  Mode,
  Schedule,
  StationFeature,
  StreetFeature,
} from '../domain.js';
import { geodesicDistanceMeters, metersPerDegreeAtLatitude } from '../geodesy.js';
import type {
  AssignNearestOptions,
  Bounds,
  CreateScorerOptions,
  Grid,
  IndexedStation,
  NearestStation,
  Point,
  ScoreOptions,
  StationIndex,
  StreetAccessScorer,
  WaitResult,
} from './types.js';

export const WALKING_METERS_PER_MINUTE = 80;
export const DEFAULT_TIME_SCALE_MINUTES = 15;
export const DEFAULT_ESTIMATED_WAIT_MINUTES = 4;

export const DEFAULT_TRANSFER_MINUTES = 3;

export function timeScaleStops(value: number | string = DEFAULT_TIME_SCALE_MINUTES): {
  readonly orangeMinutes: number;
  readonly redMinutes: number;
  readonly yellowMinutes: number;
} {
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

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

/**
 * Returns the expected wait at a station for a local weekday and time.
 * GTFS frequency windows may extend beyond midnight, so the previous service
 * day is included and the next week is searched when service has ended.
 */
export function scheduledWaitForStation(
  schedules: Schedule | null,
  stationId: string,
  weekday: number,
  minuteOfDay: number,
  fallbackMinutes: number = DEFAULT_ESTIMATED_WAIT_MINUTES,
): WaitResult {
  if (schedules === null) {
    return {
      minutes: fallbackMinutes,
      scheduled: false,
      routeCount: 0,
    };
  }
  const profile = schedules.stations[stationId];
  const normalizedWeekday = positiveModulo(Math.trunc(weekday), 7);
  const normalizedMinute = Math.min(1_439.99, Math.max(0, minuteOfDay));

  if (!profile) {
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
      routeCount: profile.r.length,
    };
  }

  return {
    minutes: bestWait,
    scheduled: true,
    routeCount: profile.r.length,
  };
}

/**
 * Returns the expected wait for one route and direction at a station. Newer
 * schedule files store these profiles in `p`; older files fall back to the
 * station-wide profile so deployments remain backwards compatible.
 */
export function scheduledWaitForService(
  schedules: Schedule | null,
  stationId: string,
  serviceKey: string,
  weekday: number,
  minuteOfDay: number,
  fallbackMinutes: number = DEFAULT_ESTIMATED_WAIT_MINUTES,
): WaitResult {
  if (schedules === null) {
    return scheduledWaitForStation(
      null,
      stationId,
      weekday,
      minuteOfDay,
      fallbackMinutes,
    );
  }
  const stationProfile = schedules.stations[stationId];
  const serviceDays = stationProfile?.p?.[serviceKey];
  if (!serviceDays) {
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
      graph: { e: {}, t: {} },
      routes: {},
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

export const MODE_SPEED_KMH = {
  subway: 32,
  brt: 20,
  light_rail: 24,
  cable_car: 16,
  commuter_rail: 45,
  regional_rail: 55,
  monorail: 25,
} satisfies Record<Mode, number>;

export const MODE_MAX_LINK_M = {
  subway: 3_500,
  brt: 2_500,
  light_rail: 3_500,
  cable_car: 4_000,
  commuter_rail: 12_000,
  regional_rail: 16_000,
  monorail: 4_000,
} satisfies Record<Mode, number>;

export function normalize(value: string = ''): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

export const distanceMeters = geodesicDistanceMeters;

function streetCoordinateKey([lon, lat]: Coordinate): string {
  return `${lon},${lat}`;
}

function isCoordinate(coordinate: unknown): coordinate is Coordinate {
  return (
    Array.isArray(coordinate) &&
    coordinate.length >= 2 &&
    typeof coordinate[0] === 'number' &&
    Number.isFinite(coordinate[0]) &&
    typeof coordinate[1] === 'number' &&
    Number.isFinite(coordinate[1])
  );
}

/**
 * Returns coordinates used by more than one road feature. In OSM-derived
 * street data these shared vertices are the block boundaries at junctions.
 */
export function streetJunctionKeys(
  streetFeatures: readonly StreetFeature[],
): Set<string> {
  const ownerCounts = new Map<string, number>();

  for (const feature of streetFeatures) {
    const featureCoordinates = new Set<string>();
    for (const coordinate of feature.geometry.coordinates) {
      if (isCoordinate(coordinate)) {
        featureCoordinates.add(streetCoordinateKey(coordinate));
      }
    }
    for (const key of featureCoordinates) {
      ownerCounts.set(key, (ownerCounts.get(key) ?? 0) + 1);
    }
  }

  const junctionKeys = new Set<string>();
  for (const [key, ownerCount] of ownerCounts) {
    if (ownerCount > 1) junctionKeys.add(key);
  }
  return junctionKeys;
}

function interpolateCoordinate(
  start: Coordinate,
  end: Coordinate,
  ratio: number,
): Coordinate {
  return [
    start[0] + (end[0] - start[0]) * ratio,
    start[1] + (end[1] - start[1]) * ratio,
  ];
}

function streetSegmentFeature(
  feature: StreetFeature,
  coordinates: Coordinate[],
): StreetFeature {
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
  feature: StreetFeature,
  junctionKeys: ReadonlySet<string> = new Set(),
  { maxLengthMeters = 200 }: { readonly maxLengthMeters?: number } = {},
): StreetFeature[] {
  const sourceCoordinates = feature.geometry.coordinates;
  const coordinates: Coordinate[] = [];
  for (const coordinate of sourceCoordinates) {
    if (!isCoordinate(coordinate)) continue;
    const previous = coordinates.at(-1);
    if (!previous || previous[0] !== coordinate[0] || previous[1] !== coordinate[1]) {
      coordinates.push(coordinate);
    }
  }
  if (coordinates.length < 2) return [];

  const lengthCap =
    Number.isFinite(maxLengthMeters) && maxLengthMeters > 0
      ? maxLengthMeters
      : Number.POSITIVE_INFINITY;
  const segments: StreetFeature[] = [];
  const firstCoordinate = coordinates[0];
  if (!firstCoordinate) return [];
  let segmentCoordinates: Coordinate[] = [firstCoordinate];
  let segmentLength = 0;

  const finishSegment = (): void => {
    if (segmentCoordinates.length < 2) return;
    segments.push(streetSegmentFeature(feature, segmentCoordinates));
    const finalCoordinate = segmentCoordinates.at(-1);
    if (!finalCoordinate) return;
    segmentCoordinates = [finalCoordinate];
    segmentLength = 0;
  };

  for (
    let coordinateIndex = 1;
    coordinateIndex < coordinates.length;
    coordinateIndex += 1
  ) {
    const previousCoordinate = coordinates[coordinateIndex - 1];
    const edgeEnd = coordinates[coordinateIndex];
    if (!previousCoordinate || !edgeEnd) continue;
    let edgeStart = previousCoordinate;
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
export function splitStreetFeatures(
  streetFeatures: readonly StreetFeature[],
  options: { readonly maxLengthMeters?: number } = {},
): StreetFeature[] {
  const junctionKeys = streetJunctionKeys(streetFeatures);
  return streetFeatures.flatMap((feature) =>
    splitStreetFeature(feature, junctionKeys, options),
  );
}

function projectCoordinate([lon, lat]: Coordinate, referenceLatitude: number): Point {
  const scale = metersPerDegreeAtLatitude(referenceLatitude);
  return {
    x: lon * scale.longitude,
    y: lat * scale.latitude,
  };
}

function pointToSegmentDistanceSquared(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;

  if (dx === 0 && dy === 0) {
    return (point.x - start.x) ** 2 + (point.y - start.y) ** 2;
  }

  const position = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy),
    ),
  );
  const closestX = start.x + position * dx;
  const closestY = start.y + position * dy;

  return (point.x - closestX) ** 2 + (point.y - closestY) ** 2;
}

function lineBounds(points: readonly Point[]): Bounds {
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

function stationGrid<T extends { readonly projected: Point }>(
  stations: readonly T[],
  cellSize: number,
): Grid<T> {
  const cells = new Map<string, T[]>();

  for (const station of stations) {
    const cellX = Math.floor(station.projected.x / cellSize);
    const cellY = Math.floor(station.projected.y / cellSize);
    const key = `${cellX},${cellY}`;
    const cell = cells.get(key) ?? [];
    cell.push(station);
    cells.set(key, cell);
  }

  return {
    candidates(bounds: Bounds, padding: number): T[] {
      const result: T[] = [];
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

function insertNearestStation<T>(
  nearestStations: NearestStation<T>[],
  candidate: NearestStation<T>,
  candidateCount: number,
): void {
  let insertIndex = nearestStations.length;
  while (
    insertIndex > 0 &&
    (nearestStations[insertIndex - 1]?.distanceSquared ?? 0) > candidate.distanceSquared
  ) {
    insertIndex -= 1;
  }
  if (insertIndex >= candidateCount) return;
  nearestStations.splice(insertIndex, 0, candidate);
  if (nearestStations.length > candidateCount) nearestStations.pop();
}

function nearestStationsForLine(
  projectedLine: readonly Point[],
  bounds: Bounds,
  stationIndex: StationIndex,
  candidateCount: number,
  initialPadding: number,
  requiredModes: readonly Mode[] = [],
): {
  readonly nearestByMode: ReadonlyMap<Mode, NearestStation<IndexedStation>>;
  readonly nearestStations: NearestStation<IndexedStation>[];
} {
  const requiredCount = Math.min(candidateCount, stationIndex.stations.length);
  let padding = initialPadding;
  let nearestStations: NearestStation<IndexedStation>[] = [];
  let nearestByMode = new Map<Mode, NearestStation<IndexedStation>>();

  for (let attempt = 0; attempt < 12; attempt += 1) {
    nearestStations = [];
    nearestByMode = new Map();
    const candidates = stationIndex.exhaustive
      ? stationIndex.stations
      : stationIndex.grid.candidates(bounds, padding);
    for (const station of candidates) {
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
            projectedLine[segmentIndex] ?? station.projected,
            projectedLine[segmentIndex + 1] ?? station.projected,
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
    const modeCandidatesComplete = requiredModes.every((mode): boolean => {
      const candidate = nearestByMode.get(mode);
      return candidate !== undefined && Math.sqrt(candidate.distanceSquared) <= padding;
    });
    if (
      stationIndex.exhaustive ||
      (directCandidatesComplete && modeCandidatesComplete)
    ) {
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
  stationFeatures: readonly StationFeature[],
  {
    exhaustive = false,
    stationFilter = (feature) => feature.properties.status === 'open',
    modeForStation = (feature) => feature.properties.mode,
  }: CreateScorerOptions = {},
): StreetAccessScorer {
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
  const indexForStations = (
    indexedStations: readonly IndexedStation[],
  ): StationIndex => ({
    stations: indexedStations,
    grid: stationGrid(indexedStations, cellSize),
    exhaustive: exhaustive || indexedStations.length <= 100,
  });
  const allStations = indexForStations(stations);
  const stationModes = new Set<Mode>();
  for (const station of stations) {
    stationModes.add(station.mode);
  }

  const scoreFeature = (
    feature: StreetFeature,
    {
      candidateCount,
      directStationProperty,
      directDistanceProperty,
      modeProperties,
    }: Required<ScoreOptions>,
  ): void => {
    const coordinates = feature.geometry.coordinates;
    if (coordinates.length < 2) return;

    const projectedLine = coordinates.map((coordinate) =>
      projectCoordinate(coordinate, referenceLatitude),
    );
    const bounds = lineBounds(projectedLine);
    const initialPadding = Math.max(
      500,
      Number(feature.properties[directDistanceProperty]) + 500 || 5_500,
    );
    const requestedModes = [...stationModes].filter(
      (mode) => modeProperties[mode] !== undefined,
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

    for (const mode of requestedModes) {
      const properties = modeProperties[mode];
      if (!properties) continue;
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

  const scoringOptions = (options: ScoreOptions = {}): Required<ScoreOptions> => ({
    candidateCount: options.candidateCount ?? 0,
    directStationProperty: options.directStationProperty ?? 's',
    directDistanceProperty: options.directDistanceProperty ?? 'd',
    modeProperties: options.modeProperties ?? {},
  });

  return {
    score(streetFeatures: StreetFeature[], options: ScoreOptions = {}) {
      const resolvedOptions = scoringOptions(options);
      for (const feature of streetFeatures) {
        scoreFeature(feature, resolvedOptions);
      }
      return streetFeatures;
    },
    async scoreAsync(
      streetFeatures: StreetFeature[],
      { batchSize = 2_000, yieldControl = defaultYield, ...options } = {},
    ): Promise<StreetFeature[]> {
      const resolvedOptions = scoringOptions(options);
      for (let index = 0; index < streetFeatures.length; index += 1) {
        const feature = streetFeatures[index];
        if (feature) scoreFeature(feature, resolvedOptions);
        if ((index + 1) % batchSize === 0) await yieldControl();
      }
      return streetFeatures;
    },
  };
}

function defaultYield(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        resolve();
      });
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
  streetFeatures: StreetFeature[],
  stationFeatures: readonly StationFeature[],
  {
    batchSize = 5_000,
    candidateCount = 1,
    distanceForFeature = (feature) => feature.properties.d,
    onProgress = () => undefined,
    propertyKey = 's',
    distancePropertyKey = propertyKey === 's' ? 'd' : null,
    stationFilter = (feature) => feature.properties.status === 'open',
    yieldControl = defaultYield,
  }: AssignNearestOptions = {},
): Promise<StreetFeature[]> {
  const matchingStations = stationFeatures.filter(stationFilter).map((feature) => {
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
    if (!feature) continue;
    const coordinates = feature.geometry.coordinates;
    if (coordinates.length < 2) continue;

    const projectedLine = coordinates.map((coordinate) =>
      projectCoordinate(coordinate, referenceLatitude),
    );
    const bounds = lineBounds(projectedLine);
    let padding = Math.max(
      500,
      Number(distanceForFeature(feature, index)) + 500 || 5_500,
    );
    let nearestStations: NearestStation<{
      readonly coordinates: Coordinate;
      readonly id: string;
      projected: Point;
    }>[] = [];

    // Distances over the data cap need a wider search. Once the best point is
    // inside the padding radius, a point outside the search bounds cannot win.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      nearestStations = grid
        .candidates(bounds, padding)
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
                projectedLine[segmentIndex] ?? station.projected,
                projectedLine[segmentIndex + 1] ?? station.projected,
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
      )
        break;
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
        Reflect.deleteProperty(feature.properties, stationProperty);
        if (distanceProperty) {
          Reflect.deleteProperty(feature.properties, distanceProperty);
        }
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
