import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const dataDir = resolve(rootDir, 'data');
const cacheDir = resolve(dataDir, '.gtfs-cache');
const REFRESH_GTFS_CACHE = process.env.REFRESH_GTFS_CACHE === '1';
const BOUNDS_PADDING_M = Number.parseInt(process.env.STATION_BBOX_PADDING_M ?? '5000', 10);
const COORD_DECIMALS = Number.parseInt(process.env.COORD_DECIMALS ?? '5', 10);
const NYC_METRO_BOUNDS = {
  south: 40.0,
  west: -74.8,
  north: 41.9,
  east: -71.8,
};

const FEEDS = [
  {
    key: 'mta-subway',
    name: 'MTA New York City Transit',
    url: 'https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip',
    mode: 'subway',
    system: 'Metro',
  },
  {
    key: 'mta-lirr',
    name: 'Long Island Rail Road',
    url: 'https://rrgtfsfeeds.s3.amazonaws.com/gtfslirr.zip',
    mode: 'commuter_rail',
    system: 'Commuter rail',
  },
  {
    key: 'mta-metro-north',
    name: 'Metro-North Railroad',
    url: 'https://rrgtfsfeeds.s3.amazonaws.com/gtfsmnr.zip',
    mode: 'commuter_rail',
    system: 'Commuter rail',
  },
  {
    key: 'nj-transit-rail',
    name: 'NJ Transit',
    url: 'https://www.njtransit.com/rail_data.zip',
  },
  {
    key: 'path',
    name: 'Port Authority Trans-Hudson',
    url: 'http://data.trilliumtransit.com/gtfs/path-nj-us/path-nj-us.zip',
    mode: 'subway',
    system: 'Metro',
  },
];

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        value += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(value);
      value = '';
    } else if (char === '\n') {
      row.push(value.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      value = '';
    } else {
      value += char;
    }
  }

  if (value || row.length > 0) {
    row.push(value.replace(/\r$/, ''));
    rows.push(row);
  }

  const [headers, ...records] = rows;
  if (!headers) return [];

  return records
    .filter((record) => record.some(Boolean))
    .map((record) =>
      Object.fromEntries(headers.map((header, index) => [header, record[index] ?? ''])),
    );
}

async function downloadFeed(feed) {
  await mkdir(cacheDir, { recursive: true });
  const cachePath = resolve(cacheDir, `${feed.key}.zip`);

  if (!REFRESH_GTFS_CACHE) {
    try {
      await readFile(cachePath);
      console.log(`Loaded ${feed.name} GTFS from cache.`);
      return cachePath;
    } catch {
      // Cache miss; download below.
    }
  }

  console.log(`Downloading ${feed.name} GTFS...`);
  const response = await fetch(feed.url, {
    headers: {
      'User-Agent':
        'transit-colors-poc/0.1 (https://github.com/liambutler-lawrence/transit-colors)',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    throw new Error(`${feed.name} GTFS download failed: ${response.status}`);
  }

  await writeFile(cachePath, Buffer.from(await response.arrayBuffer()));
  return cachePath;
}

async function unzipText(zipPath, filename, required = true) {
  try {
    const { stdout } = await execFileAsync('unzip', ['-p', zipPath, filename], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    if (!required) return '';
    throw new Error(`Could not read ${filename} from ${basename(zipPath)}: ${error.message}`);
  }
}

function modesByStop(routes, trips, stopTimes) {
  const modeForRoute = new Map(
    routes.map((route) => [
      route.route_id,
      route.route_type === '0' || route.route_type === '900'
        ? 'light_rail'
        : 'commuter_rail',
    ]),
  );
  const modeForTrip = new Map(
    trips.map((trip) => [trip.trip_id, modeForRoute.get(trip.route_id)]),
  );
  const result = new Map();

  for (const stopTime of stopTimes) {
    const mode = modeForTrip.get(stopTime.trip_id);
    if (!mode) continue;
    const modes = result.get(stopTime.stop_id) ?? new Set();
    modes.add(mode);
    result.set(stopTime.stop_id, modes);
  }

  return result;
}

function stationRows(stops) {
  const parentIds = new Set(stops.map((stop) => stop.parent_station).filter(Boolean));
  return stops.filter((stop) => {
    if (!Number.isFinite(Number(stop.stop_lon)) || !Number.isFinite(Number(stop.stop_lat))) {
      return false;
    }
    if (stop.location_type === '1' || parentIds.has(stop.stop_id)) return true;
    return !stop.parent_station && !['2', '3', '4'].includes(stop.location_type);
  });
}

function modeForStop(feed, stop, stopModes) {
  if (feed.mode) return feed.mode;

  const modes = stopModes.get(stop.stop_id);
  if (modes?.has('commuter_rail')) return 'commuter_rail';
  if (modes?.has('light_rail')) return 'light_rail';
  return null;
}

function stationFeature(feed, stop, mode) {
  const lon = Number(Number(stop.stop_lon).toFixed(COORD_DECIMALS));
  const lat = Number(Number(stop.stop_lat).toFixed(COORD_DECIMALS));

  return {
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [lon, lat],
    },
    properties: {
      id: `gtfs/${feed.key}/${stop.stop_id}`,
      name: stop.stop_name ?? '',
      mode,
      system: feed.system ?? (mode === 'light_rail' ? 'Light rail' : 'Commuter rail'),
      status: 'open',
      status_detail: 'Open',
      status_source: 'Published in current static GTFS',
      network: feed.name,
      operator: feed.name,
      ref: stop.stop_code ?? stop.stop_id,
      wheelchair_boarding: stop.wheelchair_boarding ?? '',
    },
  };
}

async function buildFeedFeatures(feed) {
  const zipPath = await downloadFeed(feed);
  const [stopsText, routesText, tripsText, stopTimesText] = await Promise.all([
    unzipText(zipPath, 'stops.txt'),
    feed.mode ? '' : unzipText(zipPath, 'routes.txt'),
    feed.mode ? '' : unzipText(zipPath, 'trips.txt'),
    feed.mode ? '' : unzipText(zipPath, 'stop_times.txt'),
  ]);
  const stops = parseCsv(stopsText);
  const stopModes = feed.mode
    ? new Map()
    : modesByStop(parseCsv(routesText), parseCsv(tripsText), parseCsv(stopTimesText));
  const features = stationRows(stops)
    .map((stop) => {
      const mode = modeForStop(feed, stop, stopModes);
      return mode ? stationFeature(feed, stop, mode) : null;
    })
    .filter(Boolean);

  console.log(`Built ${features.length.toLocaleString()} ${feed.name} stations.`);
  return features;
}

function dedupeStations(features) {
  const stations = new Map();

  for (const feature of features) {
    const [lon, lat] = feature.geometry.coordinates;
    const normalizedName = feature.properties.name.trim().toLowerCase();
    const key = `${lon.toFixed(4)},${lat.toFixed(4)},${normalizedName}`;
    if (!stations.has(key)) stations.set(key, feature);
  }

  return [...stations.values()];
}

function isWithinMetroBounds(feature) {
  const [lon, lat] = feature.geometry.coordinates;
  return (
    lat >= NYC_METRO_BOUNDS.south &&
    lat <= NYC_METRO_BOUNDS.north &&
    lon >= NYC_METRO_BOUNDS.west &&
    lon <= NYC_METRO_BOUNDS.east
  );
}

function paddedBounds(features) {
  const bounds = features.reduce(
    (result, feature) => {
      const [lon, lat] = feature.geometry.coordinates;
      return {
        south: Math.min(result.south, lat),
        west: Math.min(result.west, lon),
        north: Math.max(result.north, lat),
        east: Math.max(result.east, lon),
      };
    },
    { south: Infinity, west: Infinity, north: -Infinity, east: -Infinity },
  );
  const centerLat = (bounds.south + bounds.north) / 2;
  const latPadding = BOUNDS_PADDING_M / 111_320;
  const lonPadding = BOUNDS_PADDING_M / (111_320 * Math.cos((centerLat * Math.PI) / 180));

  return {
    south: Number((bounds.south - latPadding).toFixed(6)),
    west: Number((bounds.west - lonPadding).toFixed(6)),
    north: Number((bounds.north + latPadding).toFixed(6)),
    east: Number((bounds.east + lonPadding).toFixed(6)),
  };
}

function propertyCounts(features, property) {
  return features.reduce((counts, feature) => {
    const key = feature.properties[property] || 'unknown';
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`, 'utf8');
}

async function main() {
  await mkdir(dataDir, { recursive: true });
  const feedFeatures = await Promise.all(FEEDS.map(buildFeedFeatures));
  const stationFeatures = dedupeStations(feedFeatures.flat()).filter(isWithinMetroBounds);

  if (stationFeatures.length === 0) throw new Error('No NYC metro stations found.');

  const metadata = {
    city: 'New York City metropolitan transit area',
    generated_at: new Date().toISOString(),
    bbox: paddedBounds(stationFeatures),
    max_distance_m: 5000,
    station_bbox_padding_m: BOUNDS_PADDING_M,
    station_search_bounds: NYC_METRO_BOUNDS,
    street_source: 'OpenFreeMap OpenStreetMap vector tiles',
    street_distance_method: 'MapLibre distance expression evaluated in the browser',
    street_count: null,
    station_count: stationFeatures.length,
    open_station_count: stationFeatures.length,
    future_station_count: 0,
    station_modes: propertyCounts(stationFeatures, 'mode'),
    station_modes_open: propertyCounts(stationFeatures, 'mode'),
    station_modes_future: {},
    station_statuses: { open: stationFeatures.length },
    distance_station_scope: 'open stations only',
    histogram: null,
    feeds: FEEDS.map(({ key, name, url }) => ({ key, name, url })),
    sources: [
      'MTA static GTFS',
      'NJ Transit static GTFS',
      'Port Authority Trans-Hudson static GTFS',
      'OpenStreetMap contributors via OpenFreeMap',
    ],
  };

  await writeJson(resolve(dataDir, 'nyc-stations.geojson'), {
    type: 'FeatureCollection',
    features: stationFeatures,
  });
  await writeJson(resolve(dataDir, 'nyc-metadata.json'), metadata);

  console.log(`Wrote ${stationFeatures.length.toLocaleString()} stations to data/nyc-stations.geojson.`);
  console.log('Wrote data/nyc-metadata.json.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
