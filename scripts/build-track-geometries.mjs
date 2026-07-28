import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildGtfsShapeCenterlines,
  parseCsv,
  stationEdgeKey,
} from './gtfs-shape-centerlines.mjs';
import { metroLineRefsForStation } from './cdmx-platforms.mjs';
import { buildOsmRouteCenterlines } from './osm-route-centerlines.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const dataDir = resolve(rootDir, 'data');
const cacheDir = resolve(dataDir, '.gtfs-cache');
const osmRouteCacheDir = resolve(cacheDir, 'osm-route-relations');
const REFRESH_OSM_ROUTE_CACHE = process.env.REFRESH_OSM_ROUTE_CACHE === '1';
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

const OSM_ROUTE_RELATIONS = {
  singapore: [
    { lineName: 'EW', relationIds: [2312796, 445764] },
    { lineName: 'CG', relationIds: [7981690, 7981691] },
    { lineName: 'NS', relationIds: [2312797, 445768] },
    { lineName: 'NE', relationIds: [2293545, 7981648] },
    { lineName: 'CC', relationIds: [2076291, 7981669, 7981667] },
    { lineName: 'CE', relationIds: [2076291, 7981669, 7981667] },
    { lineName: 'DT', relationIds: [2313458, 7981642] },
    { lineName: 'TE', relationIds: [2383439, 9627856] },
    { lineName: 'BP', relationIds: [1159434, 9664084] },
    {
      lineName: 'SK',
      relationIds: [2312985, 9663107, 1146941, 9663108],
    },
    {
      lineName: 'PG',
      relationIds: [1146942, 9663919, 2312984, 9663920],
    },
  ],
  athens: [
    { lineName: 'M1', relationIds: [445858, 7963473] },
    { lineName: 'M2', relationIds: [7963539, 3095900] },
    {
      lineName: 'M3',
      relationIds: [3165353, 7927355, 445945, 2473157],
    },
  ],
};

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
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
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

async function readOsmRouteRelation(relationId) {
  await mkdir(osmRouteCacheDir, { recursive: true });
  const cachePath = resolve(osmRouteCacheDir, `${relationId}.json`);
  if (!REFRESH_OSM_ROUTE_CACHE) {
    try {
      return JSON.parse(await readFile(cachePath, 'utf8'));
    } catch {
      // Cache miss; download the current relation below.
    }
  }
  const response = await fetch(
    `https://api.openstreetmap.org/api/0.6/relation/${relationId}/full.json`,
    {
      headers: {
        'User-Agent':
          'transit-colors-poc/0.1 (https://github.com/liambutler-lawrence/transit-colors)',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(120_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `OpenStreetMap relation ${relationId} download failed: ${response.status}`,
    );
  }
  const text = await response.text();
  await writeFile(cachePath, text, 'utf8');
  return JSON.parse(text);
}

function replaceGeometries(target, replacements) {
  for (const [fromId, entries] of Object.entries(replacements)) {
    const existing = target[fromId] ?? [];
    const replacementTargets = new Set(entries.map(([toId]) => toId));
    target[fromId] = [
      ...existing.filter(([toId]) => !replacementTargets.has(toId)),
      ...entries,
    ];
  }
}

function geometryEdgeCount(geometries) {
  return Object.values(geometries).reduce(
    (total, entries) => total + entries.length,
    0,
  );
}

function alignGeometryEndpoints(geometries, stationCoordinateById) {
  for (const [fromId, entries] of Object.entries(geometries)) {
    const fromCoordinate = stationCoordinateById.get(fromId);
    for (const [toId, coordinates] of entries) {
      const toCoordinate = stationCoordinateById.get(toId);
      if (!fromCoordinate || !toCoordinate || coordinates.length < 2) continue;
      coordinates[0] = [...fromCoordinate];
      coordinates[coordinates.length - 1] = [...toCoordinate];
    }
  }
}

async function buildArea({ areaKey, feeds, geometrySource, osmRouteRelations = [] }) {
  const schedulePath = resolve(dataDir, `${areaKey}-schedules.json`);
  const stationPath = resolve(dataDir, `${areaKey}-stations.geojson`);
  const metadataPath = resolve(dataDir, `${areaKey}-metadata.json`);
  const [schedules, stationGeoJson, metadata] = await Promise.all([
    readFile(schedulePath, 'utf8').then(JSON.parse),
    readFile(stationPath, 'utf8').then(JSON.parse),
    readFile(metadataPath, 'utf8').then(JSON.parse),
  ]);
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
    observationCount += result.observationCount;
  }

  let osmGeometry = null;
  if (osmRouteRelations.length > 0) {
    const stationCandidatesByLine = new Map();
    for (const feature of stationFeatures) {
      for (const routeId of schedules.stations[feature.properties.id]?.r ?? []) {
        const lineName = schedules.routes?.[routeId]?.name;
        if (!lineName) continue;
        const candidates = stationCandidatesByLine.get(lineName) ?? [];
        candidates.push({
          coordinate: feature.geometry.coordinates,
          id: feature.properties.id,
          name: feature.properties.name,
        });
        stationCandidatesByLine.set(lineName, candidates);
      }
    }
    const relations = (
      await Promise.all(
        osmRouteRelations.flatMap(({ lineName, relationIds }) =>
          relationIds.map(async (relationId) => ({
            data: await readOsmRouteRelation(relationId),
            lineName,
            relationId,
          })),
        ),
      )
    ).flat();
    osmGeometry = buildOsmRouteCenterlines({
      allowedEdgeKeys,
      namesMatch,
      relations,
      stationCandidatesByLine,
      stationCoordinateById,
    });
    replaceGeometries(mergedGeometries, osmGeometry.geometries);
    for (const [stationId, coordinate] of osmGeometry.platformCoordinateById) {
      stationCoordinateById.set(stationId, coordinate);
      const feature = stationFeatureById.get(stationId);
      if (!feature) continue;
      feature.geometry.coordinates = coordinate;
      feature.properties.platform_model =
        'Line-specific physical platform corridor from OSM route stop positions';
    }
    observationCount += osmGeometry.shapeObservationCount;
  }

  if (osmGeometry !== null) {
    alignGeometryEndpoints(mergedGeometries, stationCoordinateById);
  }
  const edgeCount = geometryEdgeCount(mergedGeometries);
  schedules.graph.g = mergedGeometries;
  schedules.track_geometry = {
    source: geometrySource,
    method:
      osmGeometry === null
        ? 'Station-to-station centerlines averaged from distinct official GTFS trip shapes'
        : 'Station-to-station centerlines averaged between directional OpenStreetMap route relations; official GTFS shapes retained as fallback',
    edge_count: edgeCount,
    shape_observation_count: observationCount,
    endpoint_model:
      osmGeometry === null
        ? 'Exact line-platform coordinates'
        : 'Exact line-specific physical platform coordinates from OpenStreetMap route stop positions',
    ...(osmGeometry === null
      ? {}
      : {
          osm_matched_stop_count: osmGeometry.matchedStopCount,
          osm_platform_node_count: osmGeometry.platformCoordinateById.size,
          osm_route_observation_count: osmGeometry.routeObservationCount,
        }),
  };
  if (osmGeometry !== null) {
    metadata.platform_model =
      'One node per line-specific physical platform corridor, positioned from OpenStreetMap route stop positions; opposite track sides are averaged';
  }
  await Promise.all([
    writeFile(schedulePath, `${JSON.stringify(schedules)}\n`, 'utf8'),
    writeFile(stationPath, `${JSON.stringify(stationGeoJson)}\n`, 'utf8'),
    writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, 'utf8'),
  ]);

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

const areas = [
  {
    areaKey: 'cdmx',
    geometrySource: 'Secretaría de Movilidad de la Ciudad de México (SEMOVI)',
    feeds: [{ zipPath: CDMX_GTFS_PATH }],
  },
  {
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
  },
  {
    areaKey: 'singapore',
    geometrySource:
      'OpenStreetMap MRT/LRT route relations and LTA-derived Singapore GTFS route shapes',
    feeds: [
      {
        zipPath: SINGAPORE_SHAPES_GTFS_PATH,
        routePrefix: 'singapore-rail/',
      },
    ],
    osmRouteRelations: OSM_ROUTE_RELATIONS.singapore,
  },
  {
    areaKey: 'atlanta',
    geometrySource: 'Metropolitan Atlanta Rapid Transit Authority static GTFS',
    feeds: [
      {
        zipPath: ATLANTA_GTFS_PATH,
        routePrefix: 'marta-rail/',
      },
    ],
  },
  {
    areaKey: 'athens',
    geometrySource:
      'OpenStreetMap Athens Metro route relations matched to OASA / STASY platform coordinates',
    feeds: [],
    osmRouteRelations: OSM_ROUTE_RELATIONS.athens,
  },
];
const requestedAreas = new Set(process.argv.slice(2));
for (const area of areas) {
  if (requestedAreas.size === 0 || requestedAreas.has(area.areaKey)) {
    await buildArea(area);
  }
}
