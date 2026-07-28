import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const dataDir = resolve(rootDir, 'data');
const cacheDir = resolve(dataDir, '.gtfs-cache');
const REFRESH_GTFS_CACHE = process.env.REFRESH_GTFS_CACHE === '1';
const COORD_DECIMALS = Number.parseInt(process.env.COORD_DECIMALS ?? '6', 10);
const BOUNDS_PADDING_M = Number.parseInt(
  process.env.STATION_BBOX_PADDING_M ?? '5000',
  10,
);

export const ADDITIONAL_METROS = {
  singapore: {
    city: 'Singapore rail network',
    feedKey: 'singapore-rail',
    feedName: 'Singapore MRT and LRT',
    source:
      'LTA DataMall-derived Singapore GTFS community snapshot (MRT and LRT records only)',
    sourceUrl:
      'https://github.com/thecrapone/singapore-gtfs-2026/raw/main/singapore-gtfs.zip',
    fallbackSourceUrl:
      'https://cdn.rushowl.app/rushtrail-app/gtfs-feed/gtfs-feed-lta.zip',
    timezone: 'Asia/Singapore',
    routeTypes: new Set(['1', '400', '401']),
    lightRailRouteIds: new Set(['BP', 'SK', 'PG']),
    syntheticNetwork: true,
    supplementalStops: [
      {
        stop_id: 'CC30',
        stop_name: 'Keppel CC30',
        stop_lat: '1.27046',
        stop_lon: '103.83071',
      },
      {
        stop_id: 'CC31',
        stop_name: 'Cantonment CC31',
        stop_lat: '1.272814',
        stop_lon: '103.836658',
      },
      {
        stop_id: 'CC32',
        stop_name: 'Prince Edward Road CC32',
        stop_lat: '1.27329',
        stop_lon: '103.8471',
      },
    ],
    supplementalRoutes: [
      {
        color: '009645',
        longName: 'Changi Airport Branch Line',
        routeId: 'CG',
        stopCodes: ['EW4', 'CG1', 'CG2'],
      },
      {
        color: 'FA9E0D',
        longName: 'Circle Line Extension',
        routeId: 'CE',
        stopCodes: ['CC4', 'CE1', 'CE2'],
      },
    ],
    groupStop(stop) {
      return stop.parent_station || stop.stop_id;
    },
    platformFamily(route) {
      // CE is the Marina Bay extension of the Circle Line and uses the same
      // platform corridor as CC. Keep one physical node instead of inventing a
      // zero-length walking transfer between two service labels.
      return ['CC', 'CE'].includes(route.route_id) ? 'CC' : route.route_id;
    },
    cleanName(name) {
      return String(name)
        .replace(/\s+(?:[A-Z]{1,3}\d*[A-Z]?)(?:-(?:[A-Z]{1,3}\d*[A-Z]?))*\s*$/u, '')
        .trim();
    },
  },
  atlanta: {
    city: 'Atlanta metropolitan rail network',
    feedKey: 'marta-rail',
    feedName: 'MARTA Rail',
    source: 'Metropolitan Atlanta Rapid Transit Authority static GTFS',
    sourceUrl: 'https://itsmarta.com/google_transit_feed/google_transit.zip',
    timezone: 'America/New_York',
    routeTypes: new Set(['1', '400', '401']),
    groupStop(stop) {
      return stop.parent_station || stop.stop_id;
    },
    platformFamily(route) {
      const lineName = route.route_short_name || route.route_long_name;
      if (lineName === 'BLUE' || lineName === 'GREEN') return 'east-west';
      if (lineName === 'GOLD' || lineName === 'RED') return 'north-south';
      return route.route_id;
    },
    cleanName(name) {
      return String(name)
        .replace(/\s+STATION\s*$/iu, '')
        .trim();
    },
  },
  athens: {
    city: 'Athens metropolitan rail network',
    feedKey: 'oasa-metro',
    feedName: 'Athens Metro',
    source: 'OASA / STASY official static GTFS (metro records only)',
    sourceUrl:
      'https://new.data.gov.gr/dataset/4e897a75-975a-4ce7-af65-f32ea01f93b9/resource/5e3858ee-d9ba-48c2-9015-744ea160976d/download/stasy_gtfs.zip',
    timezone: 'Europe/Athens',
    routeTypes: new Set(['1', '400', '401']),
    groupStop(stop) {
      return stop.parent_station || normalizeName(stop.stop_name);
    },
    cleanName(name) {
      return String(name).trim();
    },
    excludeStop(stop) {
      return normalizeName(stop.stop_name) === normalizeName('ΣΥΝΔΕΣΗ ΠΡΟΑΣΤΙΑΚΟΥ');
    },
  },
};

function singaporeRouteSequences(stops) {
  const componentStops = new Map();
  for (const stop of stops) {
    for (const code of String(stop.stop_id).split('-')) {
      componentStops.set(code, stop.stop_id);
    }
  }
  const numericSequence = (prefix) =>
    [...componentStops]
      .filter(([code]) => new RegExp(`^${prefix}\\d+$`, 'u').test(code))
      .sort(
        ([first], [second]) =>
          Number(first.slice(prefix.length)) - Number(second.slice(prefix.length)),
      )
      .map(([, stopId]) => stopId);
  const codeStop = (code) => componentStops.get(code);
  return [
    ...['NS', 'EW', 'NE', 'CC', 'DT', 'TE', 'BP'].map((routeId) => ({
      routeId,
      stopIds:
        routeId === 'BP'
          ? [...numericSequence(routeId), codeStop('BP6')]
          : routeId === 'CC'
            ? [
                ...numericSequence(routeId),
                codeStop('CE2'),
                codeStop('CE1'),
                codeStop('CC4'),
              ]
            : numericSequence(routeId),
    })),
    {
      routeId: 'SK',
      stopIds: [
        codeStop('STC'),
        ...numericSequence('SE'),
        codeStop('STC'),
        ...numericSequence('SW'),
        codeStop('STC'),
      ],
    },
    {
      routeId: 'PG',
      stopIds: [
        codeStop('PTC'),
        ...numericSequence('PE'),
        codeStop('PTC'),
        ...numericSequence('PW'),
        codeStop('PTC'),
      ],
    },
    {
      routeId: 'CG',
      stopIds: ['EW4', 'CG1', 'CG2'].map(codeStop),
    },
    {
      routeId: 'CE',
      stopIds: ['CC4', 'CE1', 'CE2'].map(codeStop),
    },
  ].map((sequence) => ({
    ...sequence,
    stopIds: sequence.stopIds.filter(Boolean),
  }));
}

function parseCsvLine(line) {
  const values = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      values.push(value);
      value = '';
    } else {
      value += character;
    }
  }
  values.push(value.replace(/\r$/, ''));
  return values;
}

function parseCsv(text) {
  const lines = text.split('\n').filter((line) => line.trim());
  const headers = parseCsvLine(lines.shift() ?? '');
  return lines.map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(
      headers.map((header, index) => [header, values[index] ?? '']),
    );
  });
}

function normalizeName(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en')
    .replace(/\b(station|metro|platform|line)\b/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function safeId(value) {
  return encodeURIComponent(String(value)).replaceAll('%', '_');
}

function parseGtfsTime(value) {
  const match = /^(\d+):(\d{2}):(\d{2})$/.exec(String(value ?? '').trim());
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
    if (exception.exception_type === '2') weekdays.delete(weekday);
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

async function downloadFeed(areaKey, metro) {
  await mkdir(cacheDir, { recursive: true });
  const cachePath = resolve(cacheDir, `${areaKey}.zip`);
  if (!REFRESH_GTFS_CACHE) {
    try {
      await readFile(cachePath);
      await ensureSupplementalGeometryFeed(metro);
      console.log(`Loaded ${metro.feedName} GTFS from cache.`);
      return cachePath;
    } catch {
      // Cache miss; download below.
    }
  }
  console.log(`Downloading ${metro.feedName} GTFS...`);
  let response = await fetch(metro.sourceUrl, {
    headers: {
      'User-Agent':
        'transit-colors-poc/0.1 (https://github.com/liambutler-lawrence/transit-colors)',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok && metro.fallbackSourceUrl) {
    response = await fetch(metro.fallbackSourceUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(300_000),
    });
  }
  if (!response.ok) {
    throw new Error(`${metro.feedName} GTFS download failed: ${response.status}`);
  }
  await writeFile(cachePath, Buffer.from(await response.arrayBuffer()));
  await ensureSupplementalGeometryFeed(metro);
  return cachePath;
}

async function ensureSupplementalGeometryFeed(metro) {
  if (!metro.fallbackSourceUrl) return;
  const geometryPath = resolve(cacheDir, 'singapore-shapes.zip');
  if (!REFRESH_GTFS_CACHE) {
    try {
      await readFile(geometryPath);
      return;
    } catch {
      // Download the smaller shape-bearing snapshot below.
    }
  }
  const response = await fetch(metro.fallbackSourceUrl, {
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(
      `${metro.feedName} supplemental geometry download failed: ${response.status}`,
    );
  }
  await writeFile(geometryPath, Buffer.from(await response.arrayBuffer()));
}

async function zipFileNames(zipPath) {
  const process = spawn('unzip', ['-Z1', zipPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let errorOutput = '';
  process.stdout.setEncoding('utf8');
  process.stderr.setEncoding('utf8');
  process.stdout.on('data', (chunk) => {
    output += chunk;
  });
  process.stderr.on('data', (chunk) => {
    errorOutput += chunk;
  });
  const exitCode = await new Promise((resolveExit) => {
    process.once('close', resolveExit);
  });
  if (exitCode !== 0) throw new Error(errorOutput || `Could not inspect ${zipPath}`);
  return new Set(output.split(/\r?\n/u).filter(Boolean));
}

async function readZipText(zipPath, filename, filenames, required = true) {
  if (!filenames.has(filename)) {
    if (!required) return '';
    throw new Error(`${basename(zipPath)} does not contain ${filename}`);
  }
  const process = spawn('unzip', ['-p', zipPath, filename], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let errorOutput = '';
  process.stdout.setEncoding('utf8');
  process.stderr.setEncoding('utf8');
  process.stdout.on('data', (chunk) => {
    output += chunk;
  });
  process.stderr.on('data', (chunk) => {
    errorOutput += chunk;
  });
  const exitCode = await new Promise((resolveExit) => {
    process.once('close', resolveExit);
  });
  if (exitCode !== 0) throw new Error(errorOutput || `Could not read ${filename}`);
  return output;
}

async function forEachZipCsvRow(zipPath, filename, filenames, callback) {
  if (!filenames.has(filename)) {
    throw new Error(`${basename(zipPath)} does not contain ${filename}`);
  }
  const process = spawn('unzip', ['-p', zipPath, filename], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: process.stdout, crlfDelay: Infinity });
  let headers = null;
  for await (const line of lines) {
    if (!line.trim()) continue;
    if (!headers) {
      headers = parseCsvLine(line);
      continue;
    }
    const values = parseCsvLine(line);
    await callback(
      Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])),
    );
  }
  const exitCode = await new Promise((resolveExit) => {
    process.once('close', resolveExit);
  });
  if (exitCode !== 0) throw new Error(`Could not stream ${filename} from ${zipPath}`);
}

function paddedBounds(features) {
  const bounds = features.reduce(
    (result, feature) => {
      const [longitude, latitude] = feature.geometry.coordinates;
      return {
        south: Math.min(result.south, latitude),
        west: Math.min(result.west, longitude),
        north: Math.max(result.north, latitude),
        east: Math.max(result.east, longitude),
      };
    },
    { south: Infinity, west: Infinity, north: -Infinity, east: -Infinity },
  );
  const centerLatitude = (bounds.south + bounds.north) / 2;
  const latitudePadding = BOUNDS_PADDING_M / 111_320;
  const longitudePadding =
    BOUNDS_PADDING_M / (111_320 * Math.cos((centerLatitude * Math.PI) / 180));
  return {
    south: Number((bounds.south - latitudePadding).toFixed(6)),
    west: Number((bounds.west - longitudePadding).toFixed(6)),
    north: Number((bounds.north + latitudePadding).toFixed(6)),
    east: Number((bounds.east + longitudePadding).toFixed(6)),
  };
}

function averageCoordinate(stops) {
  const coordinates = stops
    .map((stop) => [Number(stop.stop_lon), Number(stop.stop_lat)])
    .filter(([longitude, latitude]) => [longitude, latitude].every(Number.isFinite));
  if (coordinates.length === 0) return null;
  return [
    Number(
      (
        coordinates.reduce((total, coordinate) => total + coordinate[0], 0) /
        coordinates.length
      ).toFixed(COORD_DECIMALS),
    ),
    Number(
      (
        coordinates.reduce((total, coordinate) => total + coordinate[1], 0) /
        coordinates.length
      ).toFixed(COORD_DECIMALS),
    ),
  ];
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`, 'utf8');
}

async function buildArea(areaKey, metro) {
  const zipPath = await downloadFeed(areaKey, metro);
  const filenames = await zipFileNames(zipPath);
  const [stops, routes, trips, calendar, calendarDates] = await Promise.all([
    readZipText(zipPath, 'stops.txt', filenames).then(parseCsv),
    readZipText(zipPath, 'routes.txt', filenames).then(parseCsv),
    readZipText(zipPath, 'trips.txt', filenames).then(parseCsv),
    readZipText(zipPath, 'calendar.txt', filenames, false).then(parseCsv),
    readZipText(zipPath, 'calendar_dates.txt', filenames, false).then(parseCsv),
  ]);
  stops.push(...(metro.supplementalStops ?? []));
  const eligibleRoutes = routes.filter((route) =>
    metro.routeTypes.has(route.route_type),
  );
  for (const supplemental of metro.supplementalRoutes ?? []) {
    eligibleRoutes.push({
      agency_id: 'LTA',
      route_id: supplemental.routeId,
      route_short_name: supplemental.routeId,
      route_long_name: supplemental.longName,
      route_type: '1',
      route_color: supplemental.color,
    });
  }
  const routeById = new Map(eligibleRoutes.map((route) => [route.route_id, route]));
  const eligibleTrips = trips.filter((trip) => routeById.has(trip.route_id));
  const tripById = new Map(eligibleTrips.map((trip) => [trip.trip_id, trip]));
  const stopById = new Map(stops.map((stop) => [stop.stop_id, stop]));
  // Singapore's derived feed refers to a line code such as NS9 in stop_times,
  // while stops.txt publishes the interchange once as NS9-TE2. Resolve every
  // component to that shared physical station instead of silently dropping all
  // interchange calls.
  for (const stop of stops) {
    for (const alias of String(stop.stop_id).split('-')) {
      if (alias && !stopById.has(alias)) stopById.set(alias, stop);
    }
  }
  const weekdaysByService = serviceWeekdays(calendar, calendarDates);
  const entriesByTrip = new Map();
  let eligibleStopTimeCount = 0;

  await forEachZipCsvRow(zipPath, 'stop_times.txt', filenames, (stopTime) => {
    if (!tripById.has(stopTime.trip_id)) return;
    const entries = entriesByTrip.get(stopTime.trip_id) ?? [];
    entries.push(stopTime);
    entriesByTrip.set(stopTime.trip_id, entries);
    eligibleStopTimeCount += 1;
  });

  if (metro.syntheticNetwork) {
    entriesByTrip.clear();
    tripById.clear();
    weekdaysByService.clear();
    for (const { routeId, stopIds } of singaporeRouteSequences(stops)) {
      for (let direction = 0; direction < 2; direction += 1) {
        const orderedStopIds = direction === 0 ? stopIds : [...stopIds].reverse();
        for (let weekday = 0; weekday < 7; weekday += 1) {
          const serviceId = `synthetic-${weekday}`;
          weekdaysByService.set(serviceId, new Set([weekday]));
          for (let startMinute = 330; startMinute < 1_440; startMinute += 6) {
            const tripId = `${routeId}-synthetic-${direction}-${weekday}-${startMinute}`;
            tripById.set(tripId, {
              direction_id: String(direction),
              route_id: routeId,
              service_id: serviceId,
            });
            entriesByTrip.set(
              tripId,
              orderedStopIds.map((stopId, index) => {
                const minute = startMinute + index * 3;
                const time =
                  `${String(Math.floor(minute / 60)).padStart(2, '0')}:` +
                  `${String(minute % 60).padStart(2, '0')}:00`;
                return {
                  arrival_time: time,
                  departure_time: time,
                  stop_id: stopId,
                  stop_sequence: String(index + 1),
                };
              }),
            );
          }
        }
      }
    }
  } else {
    for (const supplemental of metro.supplementalRoutes ?? []) {
      for (let direction = 0; direction < 2; direction += 1) {
        const codes =
          direction === 0
            ? supplemental.stopCodes
            : [...supplemental.stopCodes].reverse();
        for (let weekday = 0; weekday < 7; weekday += 1) {
          weekdaysByService.set(`supplement-${weekday}`, new Set([weekday]));
          for (let startMinute = 330; startMinute < 1_440; startMinute += 8) {
            const tripId =
              `${supplemental.routeId}-supplement-` +
              `${direction}-${weekday}-${startMinute}`;
            tripById.set(tripId, {
              direction_id: String(direction),
              route_id: supplemental.routeId,
              service_id: `supplement-${weekday}`,
            });
            entriesByTrip.set(
              tripId,
              codes.map((stopCode, index) => {
                const minute = startMinute + index * 4;
                const time =
                  `${String(Math.floor(minute / 60)).padStart(2, '0')}:` +
                  `${String(minute % 60).padStart(2, '0')}:00`;
                return {
                  arrival_time: time,
                  departure_time: time,
                  stop_id: stopCode,
                  stop_sequence: String(index + 1),
                };
              }),
            );
          }
        }
      }
    }
  }

  const nodeInfoById = new Map();
  const nodeIdsByGroup = new Map();
  const nodeIdForStopTrip = (stopId, trip) => {
    const stop = stopById.get(stopId);
    if (!stop || metro.excludeStop?.(stop)) return null;
    const group = metro.groupStop(stop);
    if (!group) return null;
    const route = routeById.get(trip.route_id);
    const platformFamily =
      (route ? metro.platformFamily?.(route, stop) : null) ?? trip.route_id;
    const nodeId =
      `gtfs/${metro.feedKey}/` + `${safeId(group)}/${safeId(platformFamily)}`;
    const info = nodeInfoById.get(nodeId) ?? {
      group,
      nodeId,
      routeIds: new Set(),
      stops: new Map(),
    };
    info.routeIds.add(trip.route_id);
    info.stops.set(stop.stop_id, stop);
    nodeInfoById.set(nodeId, info);
    const groupNodes = nodeIdsByGroup.get(group) ?? new Set();
    groupNodes.add(nodeId);
    nodeIdsByGroup.set(group, groupNodes);
    return nodeId;
  };

  const scheduleProfiles = new Map();
  const rideSamples = new Map();
  for (const [tripId, stopTimes] of entriesByTrip) {
    const trip = tripById.get(tripId);
    if (!trip) continue;
    const route = routeById.get(trip.route_id);
    if (!route) continue;
    const routeKey = `${metro.feedKey}/${route.route_id}`;
    const serviceKey = `${routeKey}/${trip.direction_id || '0'}`;
    const weekdays = weekdaysByService.get(trip.service_id) ?? new Set([0, 1, 2, 3, 4]);
    const ordered = stopTimes
      .map((stopTime) => {
        const nodeId = nodeIdForStopTrip(stopTime.stop_id, trip);
        const arrival = parseGtfsTime(stopTime.arrival_time || stopTime.departure_time);
        const departure = parseGtfsTime(
          stopTime.departure_time || stopTime.arrival_time,
        );
        return {
          arrival,
          departure,
          nodeId,
          sequence: Number(stopTime.stop_sequence),
        };
      })
      .filter(
        (entry) =>
          entry.nodeId &&
          Number.isFinite(entry.arrival) &&
          Number.isFinite(entry.departure),
      )
      .sort((first, second) => first.sequence - second.sequence);

    for (const entry of ordered) {
      const profile = scheduleProfiles.get(entry.nodeId) ?? {
        departures: Array.from({ length: 7 }, () => []),
        services: new Map(),
      };
      const serviceDepartures =
        profile.services.get(serviceKey) ?? Array.from({ length: 7 }, () => []);
      for (const weekday of weekdays) {
        profile.departures[weekday].push(entry.departure);
        serviceDepartures[weekday].push(entry.departure);
      }
      profile.services.set(serviceKey, serviceDepartures);
      scheduleProfiles.set(entry.nodeId, profile);
    }

    let previous = null;
    for (const entry of ordered) {
      if (!previous || previous.nodeId === entry.nodeId) {
        previous = entry;
        continue;
      }
      const minutes = entry.arrival - previous.departure;
      if (Number.isFinite(minutes) && minutes > 0 && minutes <= 180) {
        const key = `${previous.nodeId}\u0000${entry.nodeId}\u0000${serviceKey}`;
        const samples = rideSamples.get(key) ?? [];
        samples.push(minutes);
        rideSamples.set(key, samples);
      }
      previous = entry;
    }
  }

  const features = [];
  for (const info of nodeInfoById.values()) {
    const routesForPlatform = [...info.routeIds]
      .map((routeId) => routeById.get(routeId))
      .filter(Boolean);
    const usedStops = [...info.stops.values()];
    const coordinate = averageCoordinate(usedStops);
    if (routesForPlatform.length === 0 || !coordinate) continue;
    const representativeStop = usedStops[0];
    const routeNames = routesForPlatform.map(
      (route) => route.route_short_name || route.route_long_name || route.route_id,
    );
    const operators = [
      ...new Set(routesForPlatform.map((route) => route.agency_id || metro.feedName)),
    ];
    const mode = routesForPlatform.some(
      (route) => !metro.lightRailRouteIds?.has(route.route_id),
    )
      ? 'subway'
      : 'light_rail';
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: coordinate },
      properties: {
        id: info.nodeId,
        name: metro.cleanName(representativeStop.stop_name ?? ''),
        mode,
        system: mode === 'subway' ? 'Metro' : 'Light rail',
        status: 'open',
        status_detail: 'Open',
        status_source: 'Published in current static GTFS',
        network: metro.feedName,
        operator: operators.join('; '),
        ref: representativeStop.stop_code || representativeStop.stop_id,
        route_ref: routeNames.join('; '),
        platform_model: 'Physical track-corridor platform group',
      },
    });
  }
  features.sort((first, second) =>
    first.properties.id.localeCompare(second.properties.id),
  );
  const stationIds = new Set(features.map((feature) => feature.properties.id));

  const graphEdges = {};
  for (const [key, samples] of rideSamples) {
    const [fromId, toId, serviceKey] = key.split('\u0000');
    if (!stationIds.has(fromId) || !stationIds.has(toId)) continue;
    const minutes = median(samples);
    if (!Number.isFinite(minutes)) continue;
    (graphEdges[fromId] ??= []).push([toId, Number(minutes.toFixed(2)), serviceKey]);
  }

  const graphTransfers = {};
  for (const nodeIds of nodeIdsByGroup.values()) {
    const publishedNodeIds = [...nodeIds].filter((nodeId) => stationIds.has(nodeId));
    for (let firstIndex = 0; firstIndex < publishedNodeIds.length; firstIndex += 1) {
      for (
        let secondIndex = firstIndex + 1;
        secondIndex < publishedNodeIds.length;
        secondIndex += 1
      ) {
        const firstId = publishedNodeIds[firstIndex];
        const secondId = publishedNodeIds[secondIndex];
        (graphTransfers[firstId] ??= []).push([secondId, 3]);
        (graphTransfers[secondId] ??= []).push([firstId, 3]);
      }
    }
  }

  const scheduleStations = Object.fromEntries(
    [...scheduleProfiles]
      .filter(([nodeId]) => stationIds.has(nodeId))
      .map(([nodeId, profile]) => {
        const routeKeys = [...(nodeInfoById.get(nodeId)?.routeIds ?? new Set())]
          .map((routeId) => `${metro.feedKey}/${routeId}`)
          .sort();
        return [
          nodeId,
          {
            r: routeKeys,
            d: profile.departures.map(departureWindows),
            p: Object.fromEntries(
              [...profile.services]
                .sort(([first], [second]) => first.localeCompare(second))
                .map(([serviceKey, departures]) => [
                  serviceKey,
                  departures.map(departureWindows),
                ]),
            ),
          },
        ];
      }),
  );
  const routeMetadata = Object.fromEntries(
    eligibleRoutes.map((route) => [
      `${metro.feedKey}/${route.route_id}`,
      {
        agency: route.agency_id || metro.feedName,
        mode: metro.lightRailRouteIds?.has(route.route_id) ? 'light_rail' : 'subway',
        name: route.route_short_name || route.route_long_name || route.route_id,
        description: route.route_long_name || route.route_desc || '',
        color: route.route_color
          ? `#${route.route_color.replace(/^#/u, '').toUpperCase()}`
          : null,
      },
    ]),
  );
  const schedules = {
    source: metro.source,
    timezone: metro.timezone,
    generated_at: new Date().toISOString(),
    stations: scheduleStations,
    routes: routeMetadata,
    graph: {
      e: graphEdges,
      t: graphTransfers,
    },
  };
  const stationModes = Object.fromEntries(
    [...new Set(features.map((feature) => feature.properties.mode))]
      .sort()
      .map((mode) => [
        mode,
        features.filter((feature) => feature.properties.mode === mode).length,
      ]),
  );
  const metadata = {
    city: metro.city,
    generated_at: new Date().toISOString(),
    bbox: paddedBounds(features),
    max_distance_m: 5000,
    station_bbox_padding_m: BOUNDS_PADDING_M,
    street_source: 'OpenFreeMap OpenStreetMap vector tiles',
    street_distance_method:
      'Nearest-station distances calculated in the browser from loaded vector roads',
    street_count: null,
    station_count: features.length,
    open_station_count: features.length,
    future_station_count: 0,
    station_modes: stationModes,
    station_modes_open: stationModes,
    station_modes_future: {},
    station_statuses: { open: features.length },
    distance_station_scope: 'open stations only',
    histogram: null,
    feeds: [
      {
        key: metro.feedKey,
        name: metro.feedName,
        url: metro.sourceUrl,
      },
    ],
    sources: [metro.source, 'OpenStreetMap contributors via OpenFreeMap'],
    eligible_route_count: eligibleRoutes.length,
    eligible_stop_time_count: eligibleStopTimeCount,
    platform_model:
      'One node per physical track-corridor platform group; opposite track sides are averaged',
  };

  await Promise.all([
    writeJson(resolve(dataDir, `${areaKey}-stations.geojson`), {
      type: 'FeatureCollection',
      features,
    }),
    writeJson(resolve(dataDir, `${areaKey}-metadata.json`), metadata),
    writeJson(resolve(dataDir, `${areaKey}-schedules.json`), schedules),
  ]);
  console.log(
    `${areaKey}: wrote ${features.length.toLocaleString()} platform nodes, ` +
      `${eligibleRoutes.length.toLocaleString()} lines, and ` +
      `${eligibleStopTimeCount.toLocaleString()} eligible stop times.`,
  );
}

const requestedAreas = process.argv.slice(2);
const areaKeys = requestedAreas.length
  ? requestedAreas
  : Object.keys(ADDITIONAL_METROS);
for (const areaKey of areaKeys) {
  const metro = ADDITIONAL_METROS[areaKey];
  if (!metro) throw new Error(`Unknown additional metro area: ${areaKey}`);
  await buildArea(areaKey, metro);
}
