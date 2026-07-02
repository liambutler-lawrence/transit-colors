import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const dataDir = resolve(rootDir, 'data');
const cacheDir = resolve(dataDir, '.overpass-cache');

const OVERPASS_URL = process.env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter';
const MAX_DISTANCE_M = Number.parseInt(process.env.MAX_DISTANCE_M ?? '5000', 10);
const STATION_BBOX_PADDING_M = Number.parseInt(
  process.env.STATION_BBOX_PADDING_M ?? '5000',
  10,
);
const COORD_DECIMALS = Number.parseInt(process.env.COORD_DECIMALS ?? '4', 10);
const STREET_TILE_ROWS = Number.parseInt(process.env.STREET_TILE_ROWS ?? '4', 10);
const STREET_TILE_COLS = Number.parseInt(process.env.STREET_TILE_COLS ?? '4', 10);
const STREET_TILE_DELAY_MS = Number.parseInt(
  process.env.STREET_TILE_DELAY_MS ?? '5000',
  10,
);
const OVERPASS_REQUEST_TIMEOUT_MS = Number.parseInt(
  process.env.OVERPASS_REQUEST_TIMEOUT_MS ?? '120000',
  10,
);
const OVERPASS_MAX_RETRIES = Number.parseInt(
  process.env.OVERPASS_MAX_RETRIES ?? '5',
  10,
);
const OVERPASS_RETRY_DELAY_MS = Number.parseInt(
  process.env.OVERPASS_RETRY_DELAY_MS ?? '30000',
  10,
);
const REFRESH_OVERPASS_CACHE = process.env.REFRESH_OVERPASS_CACHE === '1';
const STATUS_DATE = new Date(process.env.STATUS_DATE ?? new Date());
const CDMX_CENTER = {
  lat: 19.4326,
  lon: -99.1332,
};
let projectionCenter = CDMX_CENTER;
const STATION_SEARCH_AREAS = [
  { label: 'Ciudad de México', wikidata: 'Q1489' },
  { label: 'Estado de México', wikidata: 'Q82112' },
];

const STREET_TYPES_TO_SKIP =
  '^(footway|path|cycleway|steps|bridleway|corridor|elevator|escalator|platform|construction|proposed|abandoned)$';

const RAPID_TRANSIT_QUERY_PATTERN = [
  'stc metro',
  'metro cdmx',
  'sistema de transporte colectivo',
  'tren ligero',
  'metrobus',
  'metrobús',
  'mexibus',
  'mexibús',
  'cablebus',
  'cablebús',
  'mexicable',
  'fc suburbano',
  'suburbano',
  'tren interurbano',
  'el insurgente',
  'monorail',
].join('|');
const BRT_QUERY_PATTERN = [
  'metrobus',
  'metrobús',
  'mexibus',
  'mexibús',
  'trolebus elevado',
  'trolebús elevado',
  'trolebus linea 10',
  'trolebús linea 10',
  'trolebus línea 10',
  'trolebús línea 10',
  'trolebus linea 11',
  'trolebús linea 11',
  'trolebus línea 11',
  'trolebús línea 11',
  'linea 10',
  'línea 10',
  'linea 11',
  'línea 11',
  'chalco',
  'santa marta',
].join('|');
const BRT_OPERATOR_QUERY_PATTERN = [
  'metrobus',
  'metrobús',
  'mexibus',
  'mexibús',
  'servicio de transportes electricos',
  'servicio de transportes eléctricos',
  '\\bste\\b',
].join('|');

const MODE_LABELS = {
  subway: 'Metro',
  brt: 'BRT',
  light_rail: 'Light rail',
  cable_car: 'Cable car',
  commuter_rail: 'Commuter rail',
  regional_rail: 'Regional rail',
  monorail: 'Monorail',
};

const FUTURE_NETWORK_RULES = [
  {
    pattern: /mexicable linea 3|mexicable línea 3/,
    status: 'future',
    status_detail: 'Under construction',
    reason: 'Mexicable Line 3 is not yet open',
  },
  {
    pattern: /tren ligero texcoco-la paz/,
    status: 'future',
    status_detail: 'Planned',
    reason: 'Tagged as proposed in OSM',
  },
];

function stationQuery() {
  const stationAreaQuery = STATION_SEARCH_AREAS.map(
    (area, index) => `area["wikidata"="${area.wikidata}"]->.searchArea${index};`,
  ).join('\n');
  const stationAreaSet = `(${STATION_SEARCH_AREAS.map(
    (_, index) => `.searchArea${index};`,
  ).join(' ')})->.stationSearchArea;`;

  return `
[out:json][timeout:180];
${stationAreaQuery}
${stationAreaSet}
(
  nwr(area.stationSearchArea)["railway"~"^(station|halt|tram_stop)$"];
  nwr(area.stationSearchArea)["public_transport"="station"];
  nwr(area.stationSearchArea)["amenity"="bus_station"];
  nwr(area.stationSearchArea)["public_transport"~"^(platform|stop_position)$"]["network"~"${RAPID_TRANSIT_QUERY_PATTERN}|${BRT_QUERY_PATTERN}",i];
  nwr(area.stationSearchArea)["public_transport"~"^(platform|stop_position)$"]["operator"~"${RAPID_TRANSIT_QUERY_PATTERN}|${BRT_OPERATOR_QUERY_PATTERN}",i];
  nwr(area.stationSearchArea)["public_transport"~"^(platform|stop_position)$"]["brand"~"${RAPID_TRANSIT_QUERY_PATTERN}|${BRT_QUERY_PATTERN}",i];
  nwr(area.stationSearchArea)["highway"="bus_stop"]["network"~"${BRT_QUERY_PATTERN}",i];
  nwr(area.stationSearchArea)["highway"="bus_stop"]["operator"~"${BRT_OPERATOR_QUERY_PATTERN}",i];
  nwr(area.stationSearchArea)["highway"="bus_stop"]["brand"~"${BRT_QUERY_PATTERN}",i];
  nwr(area.stationSearchArea)["trolleybus"="yes"]["network"~"${BRT_QUERY_PATTERN}",i];
  nwr(area.stationSearchArea)["trolleybus"="yes"]["operator"~"${BRT_OPERATOR_QUERY_PATTERN}",i];
);
out center tags;
`;
}

function routeMemberQuery() {
  const stationAreaQuery = STATION_SEARCH_AREAS.map(
    (area, index) => `area["wikidata"="${area.wikidata}"]->.searchArea${index};`,
  ).join('\n');
  const stationAreaSet = `(${STATION_SEARCH_AREAS.map(
    (_, index) => `.searchArea${index};`,
  ).join(' ')})->.stationSearchArea;`;

  return `
[out:json][timeout:180];
${stationAreaQuery}
${stationAreaSet}
(
  relation(area.stationSearchArea)["type"="route"]["route"~"^(bus|trolleybus)$"]["network"~"${BRT_QUERY_PATTERN}",i];
  relation(area.stationSearchArea)["type"="route"]["route"~"^(bus|trolleybus)$"]["operator"~"${BRT_OPERATOR_QUERY_PATTERN}",i];
  relation(area.stationSearchArea)["type"="route"]["route"~"^(bus|trolleybus)$"]["name"~"${BRT_QUERY_PATTERN}",i];
  relation(area.stationSearchArea)["type"="route"]["route"~"^(bus|trolleybus)$"]["ref"~"${BRT_QUERY_PATTERN}",i];
)->.brtRoutes;
.brtRoutes out body;
.brtRoutes >;
out center tags;
`;
}

function streetQuery(tileBbox) {
  return `
[out:json][timeout:180];
(
  way["highway"]["highway"!~"${STREET_TYPES_TO_SKIP}"](${formatBbox(tileBbox)});
);
out tags geom;
`;
}

function formatBbox(bounds) {
  return `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`;
}

function roundCoordinate(value) {
  return Number(value.toFixed(COORD_DECIMALS));
}

function normalizeTag(value = '') {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function parseOpeningDate(value) {
  if (!value) return null;

  const trimmed = String(value).trim();
  const yearMatch = trimmed.match(/^(\d{4})$/);
  if (yearMatch) {
    return { date: new Date(`${yearMatch[1]}-01-01T00:00:00Z`), precision: 'year' };
  }

  const monthMatch = trimmed.match(/^(\d{4})-(\d{2})$/);
  if (monthMatch) {
    return {
      date: new Date(`${monthMatch[1]}-${monthMatch[2]}-01T00:00:00Z`),
      precision: 'month',
    };
  }

  const dayMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dayMatch) {
    return { date: new Date(`${trimmed}T00:00:00Z`), precision: 'day' };
  }

  return null;
}

function openingDateIsFuture(value) {
  const parsed = parseOpeningDate(value);
  if (!parsed || Number.isNaN(parsed.date.getTime())) return false;

  const statusYear = STATUS_DATE.getUTCFullYear();
  const statusMonth = STATUS_DATE.getUTCMonth();

  if (parsed.precision === 'year') {
    return parsed.date.getUTCFullYear() > statusYear;
  }

  if (parsed.precision === 'month') {
    return (
      parsed.date.getUTCFullYear() > statusYear ||
      (parsed.date.getUTCFullYear() === statusYear &&
        parsed.date.getUTCMonth() > statusMonth)
    );
  }

  return parsed.date > STATUS_DATE;
}

function openingDateIsPastOrPresent(value) {
  const parsed = parseOpeningDate(value);
  if (!parsed || Number.isNaN(parsed.date.getTime())) return false;

  return !openingDateIsFuture(value);
}

function hasTagPrefix(tags, prefix) {
  return Object.keys(tags).some((key) => key.startsWith(prefix));
}

function stationStatus(tags = {}) {
  const transitContext = transitContextForTags(tags);
  const openingFuture = openingDateIsFuture(tags.opening_date);
  const openingPastOrPresent = openingDateIsPastOrPresent(tags.opening_date);

  for (const rule of FUTURE_NETWORK_RULES) {
    if (rule.pattern.test(transitContext)) {
      return {
        status: rule.status,
        status_detail: tags.opening_date
          ? `${rule.status_detail}; opening ${tags.opening_date}`
          : rule.status_detail,
        status_source: rule.reason,
      };
    }
  }

  if (openingFuture) {
    return {
      status: 'future',
      status_detail: `Opening ${tags.opening_date}`,
      status_source: 'OSM opening_date is in the future',
    };
  }

  if (openingPastOrPresent) {
    return {
      status: 'open',
      status_detail: 'Open',
      status_source: 'OSM opening_date is not in the future',
    };
  }

  const railway = normalizeTag(tags.railway);
  const construction = normalizeTag(tags.construction);
  const proposed = normalizeTag(tags.proposed);
  const hasProposedTag = proposed === 'yes' || hasTagPrefix(tags, 'proposed:');

  if (hasProposedTag || railway === 'proposed' || railway === 'prpopsed') {
    return {
      status: 'future',
      status_detail: 'Planned',
      status_source: 'OSM proposed lifecycle tags',
    };
  }

  if (
    railway === 'construction' ||
    construction === 'yes' ||
    construction === 'construction'
  ) {
    return {
      status: 'future',
      status_detail: 'Under construction',
      status_source: 'OSM construction lifecycle tags',
    };
  }

  return {
    status: 'open',
    status_detail: 'Open',
    status_source: 'No future/construction lifecycle tags',
  };
}

function transitContextForTags(tags = {}) {
  return [
    tags.network,
    tags.operator,
    tags.brand,
    tags['network:short'],
    tags['operator:short'],
    tags.local_ref,
    tags.route_ref,
    tags.ref,
    tags.name,
  ]
    .map((value) => normalizeTag(value))
    .filter(Boolean)
    .join(' ');
}

function isBrtTrolleybus(tags = {}, transitContext = transitContextForTags(tags)) {
  const trolleybus = normalizeTag(tags.trolleybus);
  const hasTrolleybusContext =
    trolleybus === 'yes' || /trolebus|trolebus elevado/.test(transitContext);
  const hasBrtCorridorContext =
    /trolebus elevado|linea\s*10|linea\s*11|\bl10\b|\bl11\b|chalco|santa marta|teotongo|\bxico\b/.test(
      transitContext,
    );

  return hasTrolleybusContext && hasBrtCorridorContext;
}

function classifyStation(tags = {}) {
  const station = normalizeTag(tags.station);
  const railway = normalizeTag(tags.railway);
  const operator = normalizeTag(tags.operator);
  const transitContext = transitContextForTags(tags);

  if (
    station === 'subway' ||
    /\bstc metro\b|\bmetro cdmx\b|sistema de transporte colectivo/.test(transitContext) ||
    (operator === 'stc' && railway === 'station')
  ) {
    return { keep: true, mode: 'subway', system: MODE_LABELS.subway };
  }

  if (station === 'light_rail' || /tren ligero|ste tren ligero/.test(transitContext)) {
    return { keep: true, mode: 'light_rail', system: MODE_LABELS.light_rail };
  }

  if (station === 'monorail') {
    return { keep: true, mode: 'monorail', system: MODE_LABELS.monorail };
  }

  if (/cablebus|mexicable/.test(transitContext)) {
    return { keep: true, mode: 'cable_car', system: MODE_LABELS.cable_car };
  }

  if (/metrobus|mexibus/.test(transitContext) || isBrtTrolleybus(tags, transitContext)) {
    return { keep: true, mode: 'brt', system: MODE_LABELS.brt };
  }

  if (/fc suburbano|suburbano/.test(transitContext)) {
    return {
      keep: true,
      mode: 'commuter_rail',
      system: MODE_LABELS.commuter_rail,
    };
  }

  if (/tren interurbano|el insurgente/.test(transitContext)) {
    return {
      keep: true,
      mode: 'regional_rail',
      system: MODE_LABELS.regional_rail,
    };
  }

  return { keep: false, mode: 'excluded', system: 'Excluded' };
}

function isStationLikeTags(tags = {}) {
  const publicTransport = normalizeTag(tags.public_transport);
  const highway = normalizeTag(tags.highway);
  const amenity = normalizeTag(tags.amenity);
  const railway = normalizeTag(tags.railway);

  return (
    /^(station|platform|stop_position)$/.test(publicTransport) ||
    highway === 'bus_stop' ||
    amenity === 'bus_station' ||
    /^(station|halt|tram_stop)$/.test(railway)
  );
}

function shouldInheritRouteContext(member, element) {
  const role = normalizeTag(member.role);

  if (/stop|platform|station/.test(role)) return true;
  if (!element) return false;
  if (isStationLikeTags(element.tags)) return true;

  return false;
}

function mergeRouteContexts(existing, next) {
  if (!existing) return next;

  const merged = { ...existing };
  for (const [key, value] of Object.entries(next)) {
    if (!value) continue;
    if (!merged[key]) {
      merged[key] = value;
      continue;
    }
    if (merged[key] !== value) {
      const values = new Set(String(merged[key]).split(';').concat(value));
      merged[key] = [...values].join(';');
    }
  }
  return merged;
}

function routeOperatorForContext(routeTags, routeContext) {
  if (routeTags.operator) return routeTags.operator;
  if (/mexibus/.test(routeContext)) return 'Mexibús';
  if (/metrobus/.test(routeContext)) return 'Metrobús';
  if (/trolebus/.test(routeContext)) return 'STE';
  return '';
}

function routeMemberContexts(elements) {
  const elementsById = new Map(
    elements
      .filter((element) => Number.isFinite(element.id))
      .map((element) => [`${element.type}/${element.id}`, element]),
  );
  const contexts = new Map();

  for (const relation of elements.filter((element) => element.type === 'relation')) {
    const routeTags = relation.tags ?? {};
    const routeClass = classifyStation(routeTags);
    if (!routeClass.keep || routeClass.mode !== 'brt') continue;

    const routeContext = transitContextForTags(routeTags);
    const routeNetwork =
      routeTags.network || routeTags.ref || routeTags.name || routeClass.system;
    const context = {
      network: routeNetwork,
      operator: routeOperatorForContext(routeTags, routeContext),
      route_ref: routeTags.ref ?? '',
      route_name: routeTags.name ?? '',
      route_relation: `${relation.type}/${relation.id}`,
    };

    for (const member of relation.members ?? []) {
      const key = `${member.type}/${member.ref}`;
      const element = elementsById.get(key);
      if (!shouldInheritRouteContext(member, element)) continue;
      contexts.set(key, mergeRouteContexts(contexts.get(key), context));
    }
  }

  console.log(
    `Inherited BRT route context for ${contexts.size.toLocaleString()} stop/platform members.`,
  );
  return contexts;
}

function project(lon, lat) {
  const metersPerDegreeLat = 111_320;
  const metersPerDegreeLon =
    111_320 * Math.cos((projectionCenter.lat * Math.PI) / 180);

  return {
    x: (lon - projectionCenter.lon) * metersPerDegreeLon,
    y: (lat - projectionCenter.lat) * metersPerDegreeLat,
  };
}

function pointToSegmentDistanceSquared(point, segmentStart, segmentEnd) {
  const dx = segmentEnd.x - segmentStart.x;
  const dy = segmentEnd.y - segmentStart.y;

  if (dx === 0 && dy === 0) {
    const px = point.x - segmentStart.x;
    const py = point.y - segmentStart.y;
    return px * px + py * py;
  }

  const t = Math.max(
    0,
    Math.min(
      1,
      ((point.x - segmentStart.x) * dx + (point.y - segmentStart.y) * dy) /
        (dx * dx + dy * dy),
    ),
  );

  const closest = {
    x: segmentStart.x + t * dx,
    y: segmentStart.y + t * dy,
  };

  const px = point.x - closest.x;
  const py = point.y - closest.y;
  return px * px + py * py;
}

function nearestStationDistanceMeters(lineCoordinates, stations) {
  let bestDistanceSquared = Number.POSITIVE_INFINITY;
  const projectedLine = lineCoordinates.map(([lon, lat]) => project(lon, lat));

  for (let i = 0; i < projectedLine.length - 1; i += 1) {
    const segmentStart = projectedLine[i];
    const segmentEnd = projectedLine[i + 1];

    for (const station of stations) {
      const distanceSquared = pointToSegmentDistanceSquared(
        station.projected,
        segmentStart,
        segmentEnd,
      );

      if (distanceSquared < bestDistanceSquared) {
        bestDistanceSquared = distanceSquared;
      }
    }
  }

  return Math.sqrt(bestDistanceSquared);
}

function compactProperties(tags, distanceMeters) {
  const properties = {
    d: Math.round(Math.min(distanceMeters, MAX_DISTANCE_M)),
  };

  if (distanceMeters > MAX_DISTANCE_M) properties.o = 1;
  if (tags.highway) properties.h = tags.highway;
  if (tags.name) properties.n = tags.name;

  return properties;
}

async function fetchOverpass(query, label) {
  console.log(`Fetching ${label} from Overpass...`);

  for (let attempt = 1; attempt <= OVERPASS_MAX_RETRIES; attempt += 1) {
    const response = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':
          'transit-colors-poc/0.1 (https://github.com/liambutler-lawrence/transit-colors)',
      },
      body: query,
      signal: AbortSignal.timeout(OVERPASS_REQUEST_TIMEOUT_MS),
    });

    const body = await response.text();

    if (response.ok) {
      const data = JSON.parse(body);
      console.log(
        `Fetched ${data.elements.length.toLocaleString()} ${label} elements.`,
      );
      return data;
    }

    const retryable = [429, 502, 503, 504].includes(response.status);
    if (retryable && attempt < OVERPASS_MAX_RETRIES) {
      const waitMs = OVERPASS_RETRY_DELAY_MS * attempt;
      console.warn(
        `${label} query returned ${response.status}; retrying in ${Math.round(
          waitMs / 1000,
        )}s (${attempt}/${OVERPASS_MAX_RETRIES}).`,
      );
      await sleep(waitMs);
      continue;
    }

    throw new Error(`${label} query failed: ${response.status}\n${body}`);
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

function setProjectionCenter(bounds) {
  projectionCenter = {
    lat: (bounds.south + bounds.north) / 2,
    lon: (bounds.west + bounds.east) / 2,
  };
}

function padBoundsMeters(bounds, paddingMeters) {
  const centerLat = (bounds.south + bounds.north) / 2;
  const latPadding = paddingMeters / 111_320;
  const lonPadding =
    paddingMeters / (111_320 * Math.cos((centerLat * Math.PI) / 180));

  return {
    south: bounds.south - latPadding,
    west: bounds.west - lonPadding,
    north: bounds.north + latPadding,
    east: bounds.east + lonPadding,
  };
}

function stationBounds(stationFeatures) {
  if (stationFeatures.length === 0) {
    throw new Error('No station features found; cannot derive street bbox.');
  }

  const bounds = stationFeatures.reduce(
    (result, feature) => {
      const [lon, lat] = feature.geometry.coordinates;
      result.south = Math.min(result.south, lat);
      result.west = Math.min(result.west, lon);
      result.north = Math.max(result.north, lat);
      result.east = Math.max(result.east, lon);
      return result;
    },
    {
      south: Number.POSITIVE_INFINITY,
      west: Number.POSITIVE_INFINITY,
      north: Number.NEGATIVE_INFINITY,
      east: Number.NEGATIVE_INFINITY,
    },
  );

  return padBoundsMeters(bounds, STATION_BBOX_PADDING_M);
}

function roundedBounds(bounds) {
  return {
    south: Number(bounds.south.toFixed(6)),
    west: Number(bounds.west.toFixed(6)),
    north: Number(bounds.north.toFixed(6)),
    east: Number(bounds.east.toFixed(6)),
  };
}

function boundsCacheKey(bounds) {
  return Object.values(roundedBounds(bounds))
    .map((value) => String(value).replace('-', 'm').replace('.', 'p'))
    .join('_');
}

function buildStreetTiles(bounds) {
  const tiles = [];
  const latStep = (bounds.north - bounds.south) / STREET_TILE_ROWS;
  const lonStep = (bounds.east - bounds.west) / STREET_TILE_COLS;

  for (let row = 0; row < STREET_TILE_ROWS; row += 1) {
    for (let col = 0; col < STREET_TILE_COLS; col += 1) {
      tiles.push({
        south: bounds.south + row * latStep,
        west: bounds.west + col * lonStep,
        north: row === STREET_TILE_ROWS - 1 ? bounds.north : bounds.south + (row + 1) * latStep,
        east: col === STREET_TILE_COLS - 1 ? bounds.east : bounds.west + (col + 1) * lonStep,
      });
    }
  }

  return tiles;
}

async function fetchElementsWithCache(kind, query) {
  await mkdir(cacheDir, { recursive: true });

  const cachePath = resolve(cacheDir, `${kind}.json`);

  if (!REFRESH_OVERPASS_CACHE) {
    try {
      const cachedData = JSON.parse(await readFile(cachePath, 'utf8'));
      console.log(`Loaded ${kind} from cache.`);
      return cachedData.elements;
    } catch {
      // Cache miss; fetch below.
    }
  }

  const data = await fetchOverpass(query, kind);
  await writeJson(cachePath, data);
  return data.elements;
}

async function fetchTiledElements(kind, queryForTile, bounds) {
  await mkdir(cacheDir, { recursive: true });

  const tiles = buildStreetTiles(bounds);
  const elementsById = new Map();
  const cacheKey = boundsCacheKey(bounds);

  for (const [index, tile] of tiles.entries()) {
    const label = `${kind} tile ${index + 1}/${tiles.length}`;
    const cachePath = resolve(cacheDir, `${kind}-${cacheKey}-${index + 1}.json`);
    let tileData;

    if (!REFRESH_OVERPASS_CACHE) {
      try {
        tileData = JSON.parse(await readFile(cachePath, 'utf8'));
        console.log(`Loaded ${label} from cache.`);
      } catch {
        tileData = null;
      }
    }

    if (!tileData) {
      tileData = await fetchOverpass(queryForTile(tile), label);
      await writeJson(cachePath, tileData);
    }

    for (const element of tileData.elements) {
      elementsById.set(`${element.type}/${element.id}`, element);
    }

    console.log(
      `${kind} dedupe total: ${elementsById.size.toLocaleString()} elements.`,
    );

    if (index < tiles.length - 1 && STREET_TILE_DELAY_MS > 0) {
      await sleep(STREET_TILE_DELAY_MS);
    }
  }

  return [...elementsById.values()];
}

function stationCoordinate(element) {
  if (Number.isFinite(element.lon) && Number.isFinite(element.lat)) {
    return [element.lon, element.lat];
  }

  if (
    Number.isFinite(element.center?.lon) &&
    Number.isFinite(element.center?.lat)
  ) {
    return [element.center.lon, element.center.lat];
  }

  return null;
}

function stationTagsForElement(element, routeContexts) {
  const tags = { ...(element.tags ?? {}) };
  const routeContext = routeContexts.get(`${element.type}/${element.id}`);

  if (!routeContext) return tags;

  if (!tags.network && routeContext.network) tags.network = routeContext.network;
  if (!tags.operator && routeContext.operator) tags.operator = routeContext.operator;
  if (!tags.route_ref && routeContext.route_ref) tags.route_ref = routeContext.route_ref;
  if (!tags.route_name && routeContext.route_name) tags.route_name = routeContext.route_name;
  if (!tags.route_relation && routeContext.route_relation) {
    tags.route_relation = routeContext.route_relation;
  }

  return tags;
}

function buildStationFeatures(elements, routeContexts = new Map()) {
  const deduped = new Map();
  const excluded = [];

  for (const element of elements) {
    const elementKey = `${element.type}/${element.id}`;
    const coordinate = stationCoordinate(element);
    if (!coordinate) continue;

    const [lon, lat] = coordinate;
    const tags = stationTagsForElement(element, routeContexts);
    const publicTransport = normalizeTag(tags.public_transport);

    if (!isStationLikeTags(tags) && !routeContexts.has(elementKey)) {
      excluded.push(element);
      continue;
    }

    if (!tags.name && publicTransport === 'stop_position') {
      excluded.push(element);
      continue;
    }

    const stationClass = classifyStation(tags);
    const status = stationStatus(tags);

    if (!stationClass.keep) {
      excluded.push(element);
      continue;
    }

    const rounded = [roundCoordinate(lon), roundCoordinate(lat)];
    const key = `${rounded[0]},${rounded[1]},${tags.name ?? ''}`;

    const feature = {
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: rounded,
      },
      properties: {
        id: `${element.type}/${element.id}`,
        osm_type: element.type,
        osm_id: element.id,
        name: tags.name ?? '',
        mode: stationClass.mode,
        system: stationClass.system,
        status: status.status,
        status_detail: status.status_detail,
        status_source: status.status_source,
        network: tags.network ?? '',
        operator: tags.operator ?? '',
        opening_date: tags.opening_date ?? '',
        station: tags.station ?? '',
        railway: tags.railway ?? '',
        amenity: tags.amenity ?? '',
        public_transport: tags.public_transport ?? '',
        highway: tags.highway ?? '',
        bus: tags.bus ?? '',
        trolleybus: tags.trolleybus ?? '',
        brand: tags.brand ?? '',
        ref: tags.ref ?? '',
        local_ref: tags.local_ref ?? '',
        route_ref: tags.route_ref ?? '',
        route_name: tags.route_name ?? '',
        route_relation: tags.route_relation ?? '',
      },
    };

    const existing = deduped.get(key);
    if (
      !existing ||
      (existing.properties.status !== 'open' && status.status === 'open')
    ) {
      deduped.set(key, feature);
    }
  }

  console.log(
    `Excluded ${excluded.length.toLocaleString()} generic bus/terminal station elements.`,
  );
  return [...deduped.values()];
}

function lineCoordinates(element) {
  if (!Array.isArray(element.geometry) || element.geometry.length < 2) {
    return null;
  }

  const coordinates = element.geometry
    .filter((point) => Number.isFinite(point.lon) && Number.isFinite(point.lat))
    .map((point) => [roundCoordinate(point.lon), roundCoordinate(point.lat)]);

  return coordinates.length >= 2 ? coordinates : null;
}

function buildStreetFeatures(elements, stationFeatures) {
  const stations = stationFeatures.map((feature) => {
    const [lon, lat] = feature.geometry.coordinates;
    return {
      projected: project(lon, lat),
    };
  });

  if (stations.length === 0) {
    throw new Error('No station features found; cannot compute street distances.');
  }

  const features = [];

  elements.forEach((element, index) => {
    const coordinates = lineCoordinates(element);
    if (!coordinates) return;

    const tags = element.tags ?? {};
    const distanceMeters = nearestStationDistanceMeters(coordinates, stations);

    features.push({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates,
      },
      properties: compactProperties(tags, distanceMeters),
    });

    if ((index + 1) % 5000 === 0) {
      console.log(`Processed ${(index + 1).toLocaleString()} street elements...`);
    }
  });

  return features;
}

function histogram(features) {
  const result = {
    under_500_m: 0,
    under_1000_m: 0,
    under_2500_m: 0,
    under_5000_m: 0,
    over_5000_m: 0,
  };

  for (const feature of features) {
    const distance = feature.properties.d;

    if (distance <= 500) result.under_500_m += 1;
    if (distance <= 1000) result.under_1000_m += 1;
    if (distance <= 2500) result.under_2500_m += 1;
    if (feature.properties.o === 1) {
      result.over_5000_m += 1;
    } else {
      result.under_5000_m += 1;
    }
  }

  return result;
}

function propertyCounts(features, property) {
  return features
    .reduce((counts, feature) => {
      const key = feature.properties[property] || 'unknown';
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {});
}

function featureCollection(features) {
  return {
    type: 'FeatureCollection',
    features,
  };
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`, 'utf8');
}

async function main() {
  await mkdir(dataDir, { recursive: true });

  const stationElements = await fetchElementsWithCache('station-cdmx-edomex', stationQuery());
  const routeElements = await fetchElementsWithCache(
    'brt-route-members-cdmx-edomex',
    routeMemberQuery(),
  );
  const routeContexts = routeMemberContexts(routeElements);

  const stationFeatures = buildStationFeatures(
    [...stationElements, ...routeElements],
    routeContexts,
  );
  console.log(`Built ${stationFeatures.length.toLocaleString()} station features.`);
  const dataBounds = roundedBounds(stationBounds(stationFeatures));
  setProjectionCenter(dataBounds);
  console.log(
    `Derived street bbox ${formatBbox(dataBounds)} from stations with ${STATION_BBOX_PADDING_M.toLocaleString()}m padding.`,
  );

  const openStationFeatures = stationFeatures.filter(
    (feature) => feature.properties.status === 'open',
  );
  const futureStationFeatures = stationFeatures.filter(
    (feature) => feature.properties.status !== 'open',
  );
  console.log(
    `Using ${openStationFeatures.length.toLocaleString()} open stations for distance calculation.`,
  );
  console.log(
    `Keeping ${futureStationFeatures.length.toLocaleString()} future/planned stations for optional display.`,
  );

  const streetElements = await fetchTiledElements('street', streetQuery, dataBounds);
  const streetFeatures = buildStreetFeatures(streetElements, openStationFeatures);
  console.log(`Built ${streetFeatures.length.toLocaleString()} street features.`);

  const metadata = {
    city: 'Ciudad de Mexico / Estado de Mexico rapid transit area',
    generated_at: new Date().toISOString(),
    bbox: dataBounds,
    max_distance_m: MAX_DISTANCE_M,
    station_bbox_padding_m: STATION_BBOX_PADDING_M,
    station_search_areas: STATION_SEARCH_AREAS,
    status_date: STATUS_DATE.toISOString(),
    street_count: streetFeatures.length,
    station_count: stationFeatures.length,
    open_station_count: openStationFeatures.length,
    future_station_count: futureStationFeatures.length,
    station_modes: propertyCounts(stationFeatures, 'mode'),
    station_modes_open: propertyCounts(openStationFeatures, 'mode'),
    station_modes_future: propertyCounts(futureStationFeatures, 'mode'),
    station_statuses: propertyCounts(stationFeatures, 'status'),
    distance_station_scope: 'open stations only',
    future_station_rules: FUTURE_NETWORK_RULES.map((rule) => ({
      pattern: String(rule.pattern),
      status_detail: rule.status_detail,
      reason: rule.reason,
    })),
    histogram: histogram(streetFeatures),
    street_property_schema: {
      d: 'nearest station distance in meters, clamped to max_distance_m',
      h: 'OpenStreetMap highway tag',
      n: 'OpenStreetMap street name',
      o: '1 when true distance is over max_distance_m',
    },
    sources: [
      'OpenStreetMap contributors',
      'Overpass API',
    ],
  };

  await writeJson(resolve(dataDir, 'cdmx-stations.geojson'), featureCollection(stationFeatures));
  await writeJson(resolve(dataDir, 'cdmx-streets.geojson'), featureCollection(streetFeatures));
  await writeJson(resolve(dataDir, 'cdmx-metadata.json'), metadata);

  console.log('Wrote data/cdmx-stations.geojson');
  console.log('Wrote data/cdmx-streets.geojson');
  console.log('Wrote data/cdmx-metadata.json');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
