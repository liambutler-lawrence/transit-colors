import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const dataDir = resolve(rootDir, 'data');
const cacheDir = resolve(dataDir, '.overpass-cache');

const OVERPASS_URL = process.env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter';
const MAX_DISTANCE_M = Number.parseInt(process.env.MAX_DISTANCE_M ?? '10000', 10);
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
const CDMX_BBOX = {
  south: 19.048,
  west: -99.365,
  north: 19.592,
  east: -98.94,
};
const CDMX_CENTER = {
  lat: 19.4326,
  lon: -99.1332,
};

const STREET_TYPES_TO_SKIP =
  '^(footway|path|cycleway|steps|bridleway|corridor|elevator|escalator|platform|construction|proposed|abandoned)$';

const MODE_LABELS = {
  subway: 'Metro',
  brt: 'BRT',
  light_rail: 'Light rail',
  cable_car: 'Cable car',
  commuter_rail: 'Commuter rail',
  regional_rail: 'Regional rail',
  trolleybus: 'Trolleybus',
  monorail: 'Monorail',
};

function stationQuery(tileBbox) {
  return `
[out:json][timeout:180];
(
  node["railway"~"^(station|halt|tram_stop)$"](${formatBbox(tileBbox)});
  way["railway"~"^(station|halt|tram_stop)$"](${formatBbox(tileBbox)});
  relation["railway"~"^(station|halt|tram_stop)$"](${formatBbox(tileBbox)});
  node["public_transport"="station"](${formatBbox(tileBbox)});
  way["public_transport"="station"](${formatBbox(tileBbox)});
  relation["public_transport"="station"](${formatBbox(tileBbox)});
  node["amenity"="bus_station"](${formatBbox(tileBbox)});
  way["amenity"="bus_station"](${formatBbox(tileBbox)});
  relation["amenity"="bus_station"](${formatBbox(tileBbox)});
);
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

function classifyStation(tags = {}) {
  const station = normalizeTag(tags.station);
  const railway = normalizeTag(tags.railway);
  const network = normalizeTag(tags.network);
  const operator = normalizeTag(tags.operator);
  const transitContext = `${network} ${operator}`;

  if (
    station === 'subway' ||
    /\bstc metro\b|\bmetro cdmx\b/.test(transitContext) ||
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

  if (/metrobus|mexibus/.test(transitContext)) {
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

  if (/trolebus/.test(transitContext)) {
    return { keep: true, mode: 'trolleybus', system: MODE_LABELS.trolleybus };
  }

  return { keep: false, mode: 'excluded', system: 'Excluded' };
}

function project(lon, lat) {
  const metersPerDegreeLat = 111_320;
  const metersPerDegreeLon =
    111_320 * Math.cos((CDMX_CENTER.lat * Math.PI) / 180);

  return {
    x: (lon - CDMX_CENTER.lon) * metersPerDegreeLon,
    y: (lat - CDMX_CENTER.lat) * metersPerDegreeLat,
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

async function fetchTiledElements(kind, queryForTile) {
  await mkdir(cacheDir, { recursive: true });

  const tiles = buildStreetTiles(CDMX_BBOX);
  const elementsById = new Map();

  for (const [index, tile] of tiles.entries()) {
    const label = `${kind} tile ${index + 1}/${tiles.length}`;
    const cachePath = resolve(cacheDir, `${kind}-${index + 1}.json`);
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

function buildStationFeatures(elements) {
  const deduped = new Map();
  const excluded = [];

  for (const element of elements) {
    const coordinate = stationCoordinate(element);
    if (!coordinate) continue;

    const [lon, lat] = coordinate;
    const tags = element.tags ?? {};
    const stationClass = classifyStation(tags);

    if (!stationClass.keep) {
      excluded.push(element);
      continue;
    }

    const rounded = [roundCoordinate(lon), roundCoordinate(lat)];
    const key = `${rounded[0]},${rounded[1]},${tags.name ?? ''}`;

    if (!deduped.has(key)) {
      deduped.set(key, {
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
          network: tags.network ?? '',
          operator: tags.operator ?? '',
          station: tags.station ?? '',
          railway: tags.railway ?? '',
          amenity: tags.amenity ?? '',
          public_transport: tags.public_transport ?? '',
        },
      });
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
    under_1000_m: 0,
    under_2500_m: 0,
    under_5000_m: 0,
    under_10000_m: 0,
    over_10000_m: 0,
  };

  for (const feature of features) {
    const distance = feature.properties.d;

    if (distance <= 1000) result.under_1000_m += 1;
    if (distance <= 2500) result.under_2500_m += 1;
    if (distance <= 5000) result.under_5000_m += 1;
    if (feature.properties.o === 1) {
      result.over_10000_m += 1;
    } else {
      result.under_10000_m += 1;
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

  const stationElements = await fetchTiledElements('station', stationQuery);
  const streetElements = await fetchTiledElements('street', streetQuery);

  const stationFeatures = buildStationFeatures(stationElements);
  console.log(`Built ${stationFeatures.length.toLocaleString()} station features.`);

  const streetFeatures = buildStreetFeatures(streetElements, stationFeatures);
  console.log(`Built ${streetFeatures.length.toLocaleString()} street features.`);

  const metadata = {
    city: 'Ciudad de Mexico',
    generated_at: new Date().toISOString(),
    bbox: CDMX_BBOX,
    max_distance_m: MAX_DISTANCE_M,
    street_count: streetFeatures.length,
    station_count: stationFeatures.length,
    station_modes: propertyCounts(stationFeatures, 'mode'),
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
