import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildGtfsShapeCenterlines,
  parseCsv,
  stationEdgeKey,
} from './gtfs-shape-centerlines.mjs';
import { metroLineRefsForStation } from './cdmx-platforms.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const dataDir = resolve(rootDir, 'data');
const cacheDir = resolve(dataDir, '.gtfs-cache');
const NYC_GTFS_PATH = resolve(
  process.env.NYC_SUBWAY_GTFS_PATH ?? resolve(cacheDir, 'mta-subway.zip'),
);
const PATH_GTFS_PATH = resolve(
  process.env.PATH_GTFS_PATH ?? resolve(cacheDir, 'path.zip'),
);
const CDMX_GTFS_PATH = resolve(
  process.env.CDMX_GTFS_PATH ?? resolve(cacheDir, 'cdmx.zip'),
);
const SINGAPORE_SHAPES_GTFS_PATH = resolve(
  process.env.SINGAPORE_SHAPES_GTFS_PATH ?? resolve(cacheDir, 'singapore-shapes.zip'),
);
const ATLANTA_GTFS_PATH = resolve(
  process.env.ATLANTA_GTFS_PATH ?? resolve(cacheDir, 'atlanta.zip'),
);

function readZipCsv(zipPath, filename) {
  return parseCsv(
    execFileSync('unzip', ['-p', zipPath, filename], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    }),
  );
}

function normalizeName(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(
      /\b(estacion|metrobus|metro|anden|platforma|plataforma|linea|line|l)\b/g,
      ' ',
    )
    .replace(/\b(norte|sur|oriente|poniente)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function namesMatch(first, second) {
  const normalizedFirst = normalizeName(first);
  const normalizedSecond = normalizeName(second);
  if (!normalizedFirst || !normalizedSecond) return false;
  if (normalizedFirst === normalizedSecond) return true;
  if (
    normalizedFirst.length >= 5 &&
    (normalizedFirst.includes(normalizedSecond) ||
      normalizedSecond.includes(normalizedFirst))
  ) {
    return true;
  }
  const firstTokens = new Set(
    normalizedFirst.split(' ').filter((token) => token.length > 2),
  );
  const secondTokens = new Set(
    normalizedSecond.split(' ').filter((token) => token.length > 2),
  );
  let shared = 0;
  for (const token of firstTokens) {
    if (secondTokens.has(token)) shared += 1;
  }
  return (
    firstTokens.size > 0 &&
    secondTokens.size > 0 &&
    shared / Math.min(firstTokens.size, secondTokens.size) >= 0.6
  );
}

function distanceSquared(first, second) {
  const latitudeScale = Math.cos((((first[1] + second[1]) / 2) * Math.PI) / 180);
  return ((first[0] - second[0]) * latitudeScale) ** 2 + (first[1] - second[1]) ** 2;
}

function allowedSubwayEdges(schedules) {
  const result = new Set();
  for (const [fromId, edges] of Object.entries(schedules.graph?.e ?? {})) {
    for (const [toId, , serviceKey] of edges) {
      const routeId = String(serviceKey).slice(0, String(serviceKey).lastIndexOf('/'));
      if (schedules.routes?.[routeId]?.mode === 'subway') {
        result.add(stationEdgeKey(fromId, toId));
      }
    }
  }
  return result;
}

async function buildArea({ areaKey, feeds, geometrySource }) {
  const schedulePath = resolve(dataDir, `${areaKey}-schedules.json`);
  const stationPath = resolve(dataDir, `${areaKey}-stations.geojson`);
  const schedules = JSON.parse(await readFile(schedulePath, 'utf8'));
  const stationGeoJson = JSON.parse(await readFile(stationPath, 'utf8'));
  const stationFeatures = stationGeoJson.features.filter(
    (feature) =>
      feature.properties.mode === 'subway' &&
      feature.properties.status === 'open' &&
      schedules.stations?.[feature.properties.id],
  );
  const stationCoordinateById = new Map(
    stationFeatures.map((feature) => [
      feature.properties.id,
      feature.geometry.coordinates,
    ]),
  );
  const stationFeatureById = new Map(
    stationFeatures.map((feature) => [feature.properties.id, feature]),
  );

  const candidatesByRoute = new Map();
  for (const feature of stationFeatures) {
    for (const routeId of schedules.stations[feature.properties.id]?.r ?? []) {
      const candidates = candidatesByRoute.get(routeId) ?? [];
      candidates.push(feature);
      candidatesByRoute.set(routeId, candidates);
    }
  }
  const allowedEdgeKeys = allowedSubwayEdges(schedules);
  const mergedGeometries = {};
  let edgeCount = 0;
  let observationCount = 0;
  for (const {
    zipPath,
    routePrefix = '',
    gtfsIdPrefix = null,
    useRouteLongName = false,
  } of feeds) {
    const stops = readZipCsv(zipPath, 'stops.txt');
    const routes = readZipCsv(zipPath, 'routes.txt');
    const trips = readZipCsv(zipPath, 'trips.txt');
    const stopTimes = readZipCsv(zipPath, 'stop_times.txt');
    const shapes = readZipCsv(zipPath, 'shapes.txt');
    const stopById = new Map(stops.map((stop) => [stop.stop_id, stop]));
    const parentStopIdByStopId = new Map(
      stops.map((stop) => [
        stop.stop_id,
        stop.parent_station || stop.stop_id.replace(/[NS]$/, ''),
      ]),
    );
    if (useRouteLongName) {
      for (const route of routes) {
        const scheduleRoute = schedules.routes?.[`${routePrefix}${route.route_id}`];
        if (!scheduleRoute) continue;
        scheduleRoute.name = `${route.route_short_name} · ${route.route_long_name}`;
        scheduleRoute.color = route.route_color
          ? `#${route.route_color.toUpperCase()}`
          : null;
      }
    }
    const stationIdCache = new Map();
    const stationIdForStop = (stopId, trip) => {
      const routeId = `${routePrefix}${trip.route_id}`;
      const cacheKey = `${stopId}\u0000${routeId}`;
      if (stationIdCache.has(cacheKey)) return stationIdCache.get(cacheKey);

      const parentStopId = parentStopIdByStopId.get(stopId) ?? stopId;
      const exactId = gtfsIdPrefix ? `gtfs/${gtfsIdPrefix}/${parentStopId}` : null;
      if (exactId && stationCoordinateById.has(exactId)) {
        stationIdCache.set(cacheKey, exactId);
        return exactId;
      }

      const stop = stopById.get(stopId) ?? stopById.get(parentStopId);
      const stopCoordinate = [Number(stop?.stop_lon), Number(stop?.stop_lat)];
      const candidates = candidatesByRoute.get(routeId) ?? [];
      const match = candidates
        .filter(
          (feature) =>
            stopCoordinate.every(Number.isFinite) &&
            (namesMatch(feature.properties.name, stop?.stop_name) ||
              distanceSquared(feature.geometry.coordinates, stopCoordinate) <
                0.0015 ** 2),
        )
        .sort(
          (first, second) =>
            (areaKey === 'cdmx'
              ? Number(metroLineRefsForStation(first.properties).size === 0) -
                Number(metroLineRefsForStation(second.properties).size === 0)
              : 0) ||
            distanceSquared(first.geometry.coordinates, stopCoordinate) -
              distanceSquared(second.geometry.coordinates, stopCoordinate),
        )[0];
      const stationId = match?.properties.id ?? null;
      stationIdCache.set(cacheKey, stationId);
      return stationId;
    };

    const result = buildGtfsShapeCenterlines({
      shapes,
      trips,
      stopTimes,
      stationCoordinateById,
      stationIdForStop,
      allowedEdgeKeys,
    });
    for (const [fromId, entries] of Object.entries(result.geometries)) {
      (mergedGeometries[fromId] ??= []).push(...entries);
    }
    edgeCount += result.edgeCount;
    observationCount += result.observationCount;
  }
  schedules.graph.g = mergedGeometries;
  schedules.track_geometry = {
    source: geometrySource,
    method:
      'Station-to-station centerlines averaged from distinct official GTFS trip shapes',
    edge_count: edgeCount,
    shape_observation_count: observationCount,
    endpoint_model: 'Exact line-platform coordinates',
  };
  await writeFile(schedulePath, `${JSON.stringify(schedules)}\n`, 'utf8');

  const missing = [...allowedSubwayEdges(schedules)].filter((key) => {
    const [fromId, toId] = key.split('\u0000');
    return !(
      schedules.graph.g?.[fromId]?.some(([targetId]) => targetId === toId) ||
      schedules.graph.g?.[toId]?.some(([targetId]) => targetId === fromId)
    );
  });
  console.log(
    `${areaKey}: wrote ${edgeCount.toLocaleString()} centerlines from ${observationCount.toLocaleString()} distinct shape observations; ${missing.length.toLocaleString()} subway edges retain straight fallback geometry.`,
  );
  if (missing.length) {
    console.log(
      `  Missing examples: ${missing
        .slice(0, 8)
        .map((key) =>
          key
            .split('\u0000')
            .map((stationId) => stationFeatureById.get(stationId)?.properties.name)
            .join(' → '),
        )
        .join('; ')}`,
    );
  }
}

await buildArea({
  areaKey: 'cdmx',
  geometrySource: 'Secretaría de Movilidad de la Ciudad de México (SEMOVI)',
  feeds: [{ zipPath: CDMX_GTFS_PATH }],
});
await buildArea({
  areaKey: 'nyc',
  geometrySource: 'MTA New York City Transit and Port Authority Trans-Hudson',
  feeds: [
    {
      zipPath: NYC_GTFS_PATH,
      routePrefix: 'mta-subway/',
      gtfsIdPrefix: 'mta-subway',
    },
    {
      zipPath: PATH_GTFS_PATH,
      routePrefix: 'path/',
      gtfsIdPrefix: 'path',
      useRouteLongName: true,
    },
  ],
});
await buildArea({
  areaKey: 'singapore',
  geometrySource:
    'LTA-derived Singapore GTFS route shapes; newer segments retain straight fallback geometry',
  feeds: [
    {
      zipPath: SINGAPORE_SHAPES_GTFS_PATH,
      routePrefix: 'singapore-rail/',
    },
  ],
});
await buildArea({
  areaKey: 'atlanta',
  geometrySource: 'Metropolitan Atlanta Rapid Transit Authority static GTFS',
  feeds: [
    {
      zipPath: ATLANTA_GTFS_PATH,
      routePrefix: 'marta-rail/',
    },
  ],
});
await buildArea({
  areaKey: 'athens',
  geometrySource:
    'OASA / STASY platform coordinates; straight fallback where no published GTFS shapes exist',
  feeds: [],
});
