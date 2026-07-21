import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { distanceMeters } from '../routing.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const dataDir = resolve(rootDir, 'data');
const DEFAULT_GTFS_URL =
  'https://datos.cdmx.gob.mx/dataset/75538d96-3ade-4bc5-ae7d-d85595e4522d/resource/32ed1b6b-41cd-49b3-b7f0-b57acb0eb819/download/gtfs.zip';
const GTFS_URL = process.env.GTFS_URL ?? DEFAULT_GTFS_URL;
const inputPath = process.argv[2] ? resolve(process.argv[2]) : null;

const AGENCY_MODES = {
  METRO: 'subway',
  MB: 'brt',
  TL: 'light_rail',
  SUB: 'commuter_rail',
  CBB: 'cable_car',
  INTERURBANO: 'regional_rail',
};

const DAY_COLUMNS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
      continue;
    }

    if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(value);
      value = '';
    } else if (character === '\n') {
      row.push(value.replace(/\r$/, ''));
      if (row.some((cell) => cell !== '')) rows.push(row);
      row = [];
      value = '';
    } else {
      value += character;
    }
  }

  if (value || row.length > 0) {
    row.push(value.replace(/\r$/, ''));
    rows.push(row);
  }

  const [headers, ...values] = rows;
  return values.map((cells) =>
    Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ''])),
  );
}

function readZipEntry(zipPath, entryName) {
  return execFileSync('unzip', ['-p', zipPath, entryName], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function timeToMinutes(value) {
  const [hours, minutes, seconds] = String(value)
    .split(':')
    .map((part) => Number(part));
  if (![hours, minutes, seconds].every(Number.isFinite)) return null;
  return hours * 60 + minutes + seconds / 60;
}

function normalizeName(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(estacion|metrobus|metro|anden|platforma|plataforma|linea|line|l)\b/g, ' ')
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
    (normalizedFirst.includes(normalizedSecond) || normalizedSecond.includes(normalizedFirst))
  ) {
    return true;
  }

  const firstTokens = new Set(normalizedFirst.split(' ').filter((token) => token.length > 2));
  const secondTokens = new Set(
    normalizedSecond.split(' ').filter((token) => token.length > 2),
  );
  if (firstTokens.size === 0 || secondTokens.size === 0) return false;
  let shared = 0;
  for (const token of firstTokens) {
    if (secondTokens.has(token)) shared += 1;
  }
  return shared / Math.min(firstTokens.size, secondTokens.size) >= 0.6;
}

function routeMode(route) {
  if (route.agency_id === 'TROLE') {
    return /^(10|11|13)$/.test(route.route_short_name) ? 'brt' : null;
  }
  return AGENCY_MODES[route.agency_id] ?? null;
}

function compactWindow(window) {
  return window.map((value) => Number(value.toFixed(2)));
}

async function downloadFeed() {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'transit-colors-gtfs-'));
  const zipPath = join(temporaryDirectory, 'gtfs.zip');
  console.log(`Downloading official GTFS feed from ${GTFS_URL}...`);
  const response = await fetch(GTFS_URL);
  if (!response.ok) {
    throw new Error(`GTFS download failed: ${response.status}`);
  }
  await writeFile(zipPath, Buffer.from(await response.arrayBuffer()));
  return { zipPath, temporaryDirectory };
}

async function main() {
  let temporaryDirectory = null;
  let zipPath = inputPath;

  if (!zipPath) {
    const download = await downloadFeed();
    zipPath = download.zipPath;
    temporaryDirectory = download.temporaryDirectory;
  }

  try {
    console.log(`Reading ${basename(zipPath)}...`);
    const routes = parseCsv(readZipEntry(zipPath, 'routes.txt'));
    const calendars = parseCsv(readZipEntry(zipPath, 'calendar.txt'));
    const trips = parseCsv(readZipEntry(zipPath, 'trips.txt'));
    const frequencies = parseCsv(readZipEntry(zipPath, 'frequencies.txt'));
    const stopTimes = parseCsv(readZipEntry(zipPath, 'stop_times.txt'));
    const stops = parseCsv(readZipEntry(zipPath, 'stops.txt'));

    const routeById = new Map();
    for (const route of routes) {
      const mode = routeMode(route);
      if (mode) routeById.set(route.route_id, { ...route, mode });
    }

    const calendarById = new Map(
      calendars.map((calendar) => [
        calendar.service_id,
        DAY_COLUMNS.map((column) => calendar[column] === '1'),
      ]),
    );
    const tripById = new Map(
      trips
        .filter((trip) => routeById.has(trip.route_id))
        .map((trip) => [trip.trip_id, trip]),
    );
    const frequenciesByTrip = new Map();

    for (const frequency of frequencies) {
      if (!tripById.has(frequency.trip_id)) continue;
      const start = timeToMinutes(frequency.start_time);
      const end = timeToMinutes(frequency.end_time);
      const headway = Number(frequency.headway_secs) / 60;
      if (![start, end, headway].every(Number.isFinite) || headway <= 0) continue;
      if (!frequenciesByTrip.has(frequency.trip_id)) {
        frequenciesByTrip.set(frequency.trip_id, []);
      }
      frequenciesByTrip.get(frequency.trip_id).push({ start, end, headway });
    }

    const schedulesByStop = new Map();
    for (const stopTime of stopTimes) {
      const trip = tripById.get(stopTime.trip_id);
      const tripFrequencies = frequenciesByTrip.get(stopTime.trip_id);
      if (!trip || !tripFrequencies) continue;
      const calendar = calendarById.get(trip.service_id);
      const offset = timeToMinutes(stopTime.departure_time || stopTime.arrival_time);
      if (!calendar || !Number.isFinite(offset)) continue;

      if (!schedulesByStop.has(stopTime.stop_id)) {
        schedulesByStop.set(stopTime.stop_id, {
          routes: new Set(),
          days: DAY_COLUMNS.map(() => new Map()),
        });
      }
      const stopSchedule = schedulesByStop.get(stopTime.stop_id);
      stopSchedule.routes.add(trip.route_id);

      for (const frequency of tripFrequencies) {
        for (let day = 0; day < calendar.length; day += 1) {
          if (!calendar[day]) continue;
          const window = [
            frequency.start + offset,
            frequency.end + offset,
            frequency.headway,
          ];
          stopSchedule.days[day].set(window.map((value) => value.toFixed(2)).join(','), window);
        }
      }
    }

    const scheduledStops = stops
      .filter((stop) => schedulesByStop.has(stop.stop_id))
      .map((stop) => {
        const schedule = schedulesByStop.get(stop.stop_id);
        const modes = new Set(
          [...schedule.routes].map((routeId) => routeById.get(routeId)?.mode).filter(Boolean),
        );
        return {
          id: stop.stop_id,
          name: stop.stop_name,
          coordinates: [Number(stop.stop_lon), Number(stop.stop_lat)],
          schedule,
          modes,
        };
      })
      .filter((stop) => stop.coordinates.every(Number.isFinite));

    const stationGeoJson = JSON.parse(
      await readFile(resolve(dataDir, 'cdmx-stations.geojson'), 'utf8'),
    );
    const openStations = stationGeoJson.features.filter(
      (feature) => feature.properties.status === 'open',
    );
    const stationProfiles = {};

    for (const station of openStations) {
      const properties = station.properties;
      const nearbyStops = scheduledStops
        .filter((stop) => stop.modes.has(properties.mode))
        .map((stop) => ({
          stop,
          meters: distanceMeters(station.geometry.coordinates, stop.coordinates),
        }))
        .filter(
          ({ stop, meters }) =>
            meters <= 140 ||
            (meters <= 650 && namesMatch(properties.name, stop.name)),
        )
        .sort((first, second) => first.meters - second.meters);

      if (nearbyStops.length === 0) continue;
      const maximumMatchDistance = Math.max(180, nearbyStops[0].meters + 120);
      const matches = nearbyStops.filter(
        ({ meters }) => meters <= maximumMatchDistance,
      );
      const routeIds = new Set();
      const days = DAY_COLUMNS.map(() => new Map());

      for (const { stop } of matches) {
        for (const routeId of stop.schedule.routes) routeIds.add(routeId);
        for (let day = 0; day < DAY_COLUMNS.length; day += 1) {
          for (const [key, window] of stop.schedule.days[day]) {
            days[day].set(key, window);
          }
        }
      }

      stationProfiles[properties.id] = {
        r: [...routeIds].sort(),
        d: days.map((windows) =>
          [...windows.values()]
            .sort((first, second) => first[0] - second[0] || first[2] - second[2])
            .map(compactWindow),
        ),
      };
    }

    const routeProfiles = Object.fromEntries(
      [...routeById.values()]
        .sort((first, second) => first.route_id.localeCompare(second.route_id))
        .map((route) => [
          route.route_id,
          {
            agency: route.agency_id,
            mode: route.mode,
            name: route.route_short_name,
            description: route.route_long_name,
          },
        ]),
    );
    const output = {
      source: 'Secretaría de Movilidad de la Ciudad de México (SEMOVI)',
      source_url: DEFAULT_GTFS_URL,
      source_dataset_updated_at: '2026-02-24',
      generated_at: new Date().toISOString(),
      timezone: 'America/Mexico_City',
      day_order: DAY_COLUMNS,
      calendar_note:
        'Recurring weekday flags are used; stale absolute calendar date ranges are ignored.',
      matched_station_count: Object.keys(stationProfiles).length,
      open_station_count: openStations.length,
      routes: routeProfiles,
      stations: stationProfiles,
    };

    await writeFile(
      resolve(dataDir, 'cdmx-schedules.json'),
      `${JSON.stringify(output)}\n`,
      'utf8',
    );
    console.log(
      `Wrote data/cdmx-schedules.json with ${output.matched_station_count.toLocaleString()} matched OSM station records and ${Object.keys(routeProfiles).length.toLocaleString()} routes.`,
    );
  } finally {
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
