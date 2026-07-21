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

function parseGtfsTime(value) {
  const match = /^(\d+):(\d{2}):(\d{2})$/.exec(value ?? '');
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]) + Number(match[3]) / 60;
}

function weekdayFromGtfsDate(value) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value ?? '');
  if (!match) return null;
  const sundayBased = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  ).getUTCDay();
  return (sundayBased + 6) % 7;
}

function serviceWeekdays(calendar, calendarDates) {
  const result = new Map();
  const dayFields = [
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday',
  ];

  for (const service of calendar) {
    result.set(
      service.service_id,
      new Set(
        dayFields
          .map((field, weekday) => (service[field] === '1' ? weekday : null))
          .filter((weekday) => weekday !== null),
      ),
    );
  }

  for (const exception of calendarDates) {
    const weekday = weekdayFromGtfsDate(exception.date);
    if (weekday === null) continue;
    const weekdays = result.get(exception.service_id) ?? new Set();
    if (exception.exception_type === '1') weekdays.add(weekday);
    result.set(exception.service_id, weekdays);
  }

  return result;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function departureWindows(departures) {
  const times = [...new Set(departures.map((value) => Number(value.toFixed(2))))].sort(
    (first, second) => first - second,
  );
  if (times.length === 0) return [];
  if (times.length === 1) return [[times[0], times[0] + 8, 8]];

  const typicalHeadway = Math.max(
    1,
    median(times.slice(1).map((time, index) => time - times[index])) ?? 8,
  );
  const splitGap = Math.max(60, typicalHeadway * 4);
  const groups = [];
  let group = [times[0]];

  for (let index = 1; index < times.length; index += 1) {
    if (times[index] - times[index - 1] > splitGap) {
      groups.push(group);
      group = [];
    }
    group.push(times[index]);
  }
  groups.push(group);

  return groups.map((groupTimes) => {
    const gaps = groupTimes.slice(1).map((time, index) => time - groupTimes[index]);
    const headway = Math.max(1, median(gaps) ?? typicalHeadway);
    return [
      groupTimes[0],
      Number((groupTimes.at(-1) + headway).toFixed(2)),
      Number(headway.toFixed(2)),
    ];
  });
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

function stationFeature(feed, stop, mode, routeNames = []) {
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
      route_ref: routeNames.join(';'),
      wheelchair_boarding: stop.wheelchair_boarding ?? '',
    },
  };
}

async function buildFeedData(feed) {
  const zipPath = await downloadFeed(feed);
  const [
    stopsText,
    routesText,
    tripsText,
    stopTimesText,
    calendarText,
    calendarDatesText,
    frequenciesText,
  ] = await Promise.all([
    unzipText(zipPath, 'stops.txt'),
    unzipText(zipPath, 'routes.txt'),
    unzipText(zipPath, 'trips.txt'),
    unzipText(zipPath, 'stop_times.txt'),
    unzipText(zipPath, 'calendar.txt', false),
    unzipText(zipPath, 'calendar_dates.txt', false),
    unzipText(zipPath, 'frequencies.txt', false),
  ]);
  const stops = parseCsv(stopsText);
  const routes = parseCsv(routesText);
  const trips = parseCsv(tripsText);
  const stopTimes = parseCsv(stopTimesText);
  const stopModes = feed.mode
    ? new Map()
    : modesByStop(routes, trips, stopTimes);
  const stationStops = stationRows(stops);
  const stationStopIds = new Set(stationStops.map((stop) => stop.stop_id));
  const stationIdByStopId = new Map(
    stops.map((stop) => [
      stop.stop_id,
      stationStopIds.has(stop.parent_station) ? stop.parent_station : stop.stop_id,
    ]),
  );
  const routeById = new Map(routes.map((route) => [route.route_id, route]));
  const tripById = new Map(trips.map((trip) => [trip.trip_id, trip]));
  const weekdaysByService = serviceWeekdays(
    parseCsv(calendarText),
    parseCsv(calendarDatesText),
  );
  const frequenciesByTrip = new Map();
  const firstDepartureByTrip = new Map();

  for (const stopTime of stopTimes) {
    if (!firstDepartureByTrip.has(stopTime.trip_id)) {
      firstDepartureByTrip.set(
        stopTime.trip_id,
        parseGtfsTime(stopTime.departure_time || stopTime.arrival_time),
      );
    }
  }

  for (const frequency of parseCsv(frequenciesText)) {
    const start = parseGtfsTime(frequency.start_time);
    const end = parseGtfsTime(frequency.end_time);
    const headway = Number(frequency.headway_secs) / 60;
    if (![start, end, headway].every(Number.isFinite) || headway <= 0) continue;
    const entries = frequenciesByTrip.get(frequency.trip_id) ?? [];
    entries.push({ start, end, headway });
    frequenciesByTrip.set(frequency.trip_id, entries);
  }

  const scheduleProfiles = new Map();
  const routeNamesByStation = new Map();

  for (const stopTime of stopTimes) {
    const trip = tripById.get(stopTime.trip_id);
    if (!trip) continue;
    const stationStopId = stationIdByStopId.get(stopTime.stop_id);
    if (!stationStopIds.has(stationStopId)) continue;
    const departure = parseGtfsTime(stopTime.departure_time || stopTime.arrival_time);
    if (!Number.isFinite(departure)) continue;
    const route = routeById.get(trip.route_id);
    if (!route) continue;

    const routeKey = `${feed.key}/${route.route_id}`;
    const routeName = route.route_short_name || route.route_long_name || route.route_id;
    const routeNames = routeNamesByStation.get(stationStopId) ?? new Set();
    routeNames.add(routeName);
    routeNamesByStation.set(stationStopId, routeNames);

    const stationId = `gtfs/${feed.key}/${stationStopId}`;
    const profile = scheduleProfiles.get(stationId) ?? {
      routes: new Set(),
      departures: Array.from({ length: 7 }, () => []),
    };
    profile.routes.add(routeKey);
    const weekdays = weekdaysByService.get(trip.service_id) ?? new Set([0, 1, 2, 3, 4]);
    const frequencies = frequenciesByTrip.get(trip.trip_id);
    const times = [];

    if (frequencies?.length) {
      const firstTripTime = firstDepartureByTrip.get(trip.trip_id);
      const offset = Number.isFinite(firstTripTime) ? departure - firstTripTime : 0;
      for (const frequency of frequencies) {
        for (
          let time = frequency.start + offset;
          time < frequency.end + offset;
          time += frequency.headway
        ) {
          times.push(time);
        }
      }
    } else {
      times.push(departure);
    }

    for (const weekday of weekdays) profile.departures[weekday].push(...times);
    scheduleProfiles.set(stationId, profile);
  }

  const features = stationRows(stops)
    .map((stop) => {
      const mode = modeForStop(feed, stop, stopModes);
      return mode
        ? stationFeature(feed, stop, mode, [...(routeNamesByStation.get(stop.stop_id) ?? [])])
        : null;
    })
    .filter(Boolean);

  const schedules = Object.fromEntries(
    [...scheduleProfiles].map(([stationId, profile]) => [
      stationId,
      {
        r: [...profile.routes].sort(),
        d: profile.departures.map(departureWindows),
      },
    ]),
  );
  const routeMetadata = Object.fromEntries(
    routes.map((route) => {
      const routeMode = feed.mode ?? (route.route_type === '0' ? 'light_rail' : 'commuter_rail');
      return [
        `${feed.key}/${route.route_id}`,
        {
          agency: feed.name,
          mode: routeMode,
          name: route.route_short_name || route.route_long_name || route.route_id,
          description: route.route_long_name || route.route_desc || '',
        },
      ];
    }),
  );

  console.log(`Built ${features.length.toLocaleString()} ${feed.name} stations.`);
  return { features, schedules, routes: routeMetadata };
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
  const feedData = await Promise.all(FEEDS.map(buildFeedData));
  const stationFeatures = dedupeStations(feedData.flatMap((feed) => feed.features)).filter(
    isWithinMetroBounds,
  );

  if (stationFeatures.length === 0) throw new Error('No NYC metro stations found.');

  const metadata = {
    city: 'New York City metropolitan transit area',
    generated_at: new Date().toISOString(),
    bbox: paddedBounds(stationFeatures),
    max_distance_m: 5000,
    station_bbox_padding_m: BOUNDS_PADDING_M,
    station_search_bounds: NYC_METRO_BOUNDS,
    street_source: 'OpenFreeMap OpenStreetMap vector tiles',
    street_distance_method: 'Nearest-station distances calculated in the browser from loaded vector roads',
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
  const stationIds = new Set(stationFeatures.map((feature) => feature.properties.id));
  const schedules = Object.assign({}, ...feedData.map((feed) => feed.schedules));
  const routes = Object.assign({}, ...feedData.map((feed) => feed.routes));
  await writeJson(resolve(dataDir, 'nyc-schedules.json'), {
    source: 'MTA, NJ Transit, and PATH static GTFS',
    timezone: 'America/New_York',
    generated_at: new Date().toISOString(),
    stations: Object.fromEntries(
      Object.entries(schedules).filter(([stationId]) => stationIds.has(stationId)),
    ),
    routes,
  });

  console.log(`Wrote ${stationFeatures.length.toLocaleString()} stations to data/nyc-stations.geojson.`);
  console.log('Wrote data/nyc-metadata.json.');
  console.log('Wrote data/nyc-schedules.json.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
