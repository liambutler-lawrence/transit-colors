import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { distanceMeters } from '../routing.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const dataDir = resolve(rootDir, 'data');
const cacheDir = resolve(dataDir, '.gtfs-cache');
const DEFAULT_GTFS_URL =
  'https://datos.cdmx.gob.mx/dataset/75538d96-3ade-4bc5-ae7d-d85595e4522d/resource/32ed1b6b-41cd-49b3-b7f0-b57acb0eb819/download/gtfs.zip';
const GTFS_URL = process.env.GTFS_URL ?? DEFAULT_GTFS_URL;
const inputPath = process.argv[2] ? resolve(process.argv[2]) : null;
const REFRESH_GTFS_CACHE = process.env.REFRESH_GTFS_CACHE === '1';

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

function readZipEntry(zipPath, entryName, required = true) {
  try {
    return execFileSync('unzip', ['-p', zipPath, entryName], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    if (!required) return '';
    throw error;
  }
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
    return /^(10|11|12|13)$/.test(route.route_short_name) ? 'brt' : null;
  }
  return AGENCY_MODES[route.agency_id] ?? null;
}

function compactWindow(window) {
  return window.map((value) => Number(value.toFixed(2)));
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

async function downloadFeed() {
  await mkdir(cacheDir, { recursive: true });
  const zipPath = resolve(cacheDir, 'cdmx.zip');
  if (!REFRESH_GTFS_CACHE) {
    try {
      await readFile(zipPath);
      console.log('Loaded official CDMX GTFS from cache.');
      return zipPath;
    } catch {
      // Cache miss; download below.
    }
  }
  console.log(`Downloading official GTFS feed from ${GTFS_URL}...`);
  const response = await fetch(GTFS_URL);
  if (!response.ok) {
    throw new Error(`GTFS download failed: ${response.status}`);
  }
  await writeFile(zipPath, Buffer.from(await response.arrayBuffer()));
  return zipPath;
}

async function main() {
  let zipPath = inputPath;

  if (!zipPath) {
    zipPath = await downloadFeed();
  }

  console.log(`Reading ${basename(zipPath)}...`);
    const routes = parseCsv(readZipEntry(zipPath, 'routes.txt'));
    const calendars = parseCsv(readZipEntry(zipPath, 'calendar.txt'));
    const trips = parseCsv(readZipEntry(zipPath, 'trips.txt'));
    const frequencies = parseCsv(readZipEntry(zipPath, 'frequencies.txt'));
    const stopTimes = parseCsv(readZipEntry(zipPath, 'stop_times.txt'));
    const stops = parseCsv(readZipEntry(zipPath, 'stops.txt'));
    const transfers = parseCsv(readZipEntry(zipPath, 'transfers.txt', false));

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

    const firstDepartureByTrip = new Map();
    const routesByStop = new Map();
    const graphStopsByTrip = new Map();
    for (const stopTime of stopTimes) {
      const trip = tripById.get(stopTime.trip_id);
      if (!trip) continue;
      const departure = timeToMinutes(
        stopTime.departure_time || stopTime.arrival_time,
      );
      if (!firstDepartureByTrip.has(stopTime.trip_id) && Number.isFinite(departure)) {
        firstDepartureByTrip.set(stopTime.trip_id, departure);
      }
      const stopRoutes = routesByStop.get(stopTime.stop_id) ?? new Set();
      stopRoutes.add(trip.route_id);
      routesByStop.set(stopTime.stop_id, stopRoutes);
      const tripStops = graphStopsByTrip.get(stopTime.trip_id) ?? [];
      tripStops.push({
        stopId: stopTime.stop_id,
        sequence: Number(stopTime.stop_sequence),
        arrival: timeToMinutes(stopTime.arrival_time || stopTime.departure_time),
        departure,
        serviceKey: `${trip.route_id}/${trip.direction_id || '0'}`,
      });
      graphStopsByTrip.set(stopTime.trip_id, tripStops);
    }

    const schedulesByStop = new Map();
    for (const stopTime of stopTimes) {
      const trip = tripById.get(stopTime.trip_id);
      const tripFrequencies = frequenciesByTrip.get(stopTime.trip_id);
      if (!trip || !tripFrequencies) continue;
      const calendar = calendarById.get(trip.service_id);
      const departure = timeToMinutes(stopTime.departure_time || stopTime.arrival_time);
      const firstDeparture = firstDepartureByTrip.get(stopTime.trip_id);
      const offset = departure - firstDeparture;
      if (!calendar || !Number.isFinite(offset)) continue;

      if (!schedulesByStop.has(stopTime.stop_id)) {
        schedulesByStop.set(stopTime.stop_id, {
          routes: new Set(),
          days: DAY_COLUMNS.map(() => new Map()),
          services: new Map(),
        });
      }
      const stopSchedule = schedulesByStop.get(stopTime.stop_id);
      stopSchedule.routes.add(trip.route_id);
      const serviceKey = `${trip.route_id}/${trip.direction_id || '0'}`;
      const serviceDays = stopSchedule.services.get(serviceKey) ??
        DAY_COLUMNS.map(() => new Map());

      for (const frequency of tripFrequencies) {
        for (let day = 0; day < calendar.length; day += 1) {
          if (!calendar[day]) continue;
          const window = [
            frequency.start + offset,
            frequency.end + offset,
            frequency.headway,
          ];
          const windowKey = window.map((value) => value.toFixed(2)).join(',');
          stopSchedule.days[day].set(windowKey, window);
          serviceDays[day].set(windowKey, window);
        }
      }
      stopSchedule.services.set(serviceKey, serviceDays);
    }

    const transitStops = stops
      .filter((stop) => routesByStop.has(stop.stop_id))
      .map((stop) => {
        const routeIds = routesByStop.get(stop.stop_id);
        const modes = new Set(
          [...routeIds].map((routeId) => routeById.get(routeId)?.mode).filter(Boolean),
        );
        return {
          id: stop.stop_id,
          name: stop.stop_name,
          coordinates: [Number(stop.stop_lon), Number(stop.stop_lat)],
          schedule: schedulesByStop.get(stop.stop_id),
          routeIds,
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
    const stationIdByGtfsStopId = new Map();

    for (const station of openStations) {
      const properties = station.properties;
      const nearbyStops = transitStops
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
      const services = new Map();

      for (const { stop, meters } of matches) {
        const existingMatch = stationIdByGtfsStopId.get(stop.id);
        if (!existingMatch || meters < existingMatch.meters) {
          stationIdByGtfsStopId.set(stop.id, {
            stationId: properties.id,
            meters,
          });
        }
        if (!stop.schedule) continue;
        for (const routeId of stop.schedule.routes) routeIds.add(routeId);
        for (let day = 0; day < DAY_COLUMNS.length; day += 1) {
          for (const [key, window] of stop.schedule.days[day]) {
            days[day].set(key, window);
          }
        }
        for (const [serviceKey, serviceDays] of stop.schedule.services) {
          const mergedDays = services.get(serviceKey) ??
            DAY_COLUMNS.map(() => new Map());
          for (let day = 0; day < DAY_COLUMNS.length; day += 1) {
            for (const [key, window] of serviceDays[day]) {
              mergedDays[day].set(key, window);
            }
          }
          services.set(serviceKey, mergedDays);
        }
      }

      if (routeIds.size === 0) continue;
      stationProfiles[properties.id] = {
        r: [...routeIds].sort(),
        d: days.map((windows) =>
          [...windows.values()]
            .sort((first, second) => first[0] - second[0] || first[2] - second[2])
            .map(compactWindow),
        ),
        p: Object.fromEntries(
          [...services]
            .sort(([first], [second]) => first.localeCompare(second))
            .map(([serviceKey, serviceDays]) => [
              serviceKey,
              serviceDays.map((windows) =>
                [...windows.values()]
                  .sort(
                    (first, second) =>
                      first[0] - second[0] || first[2] - second[2],
                  )
                  .map(compactWindow),
              ),
            ]),
        ),
      };
    }

    const rideSamples = new Map();
    for (const tripStops of graphStopsByTrip.values()) {
      tripStops.sort((first, second) => first.sequence - second.sequence);
      let previous = null;
      for (const tripStop of tripStops) {
        const stationId = stationIdByGtfsStopId.get(tripStop.stopId)?.stationId;
        if (!stationId) continue;
        const entry = { ...tripStop, stationId };
        if (!previous) {
          previous = entry;
          continue;
        }
        if (entry.stationId === previous.stationId) {
          previous = entry;
          continue;
        }
        const minutes = entry.arrival - previous.departure;
        if (Number.isFinite(minutes) && minutes > 0 && minutes <= 180) {
          const key = `${previous.stationId}\u0000${entry.stationId}\u0000${entry.serviceKey}`;
          const samples = rideSamples.get(key) ?? [];
          samples.push(minutes);
          rideSamples.set(key, samples);
        }
        previous = entry;
      }
    }

    const rideEdges = {};
    for (const [key, samples] of rideSamples) {
      const [fromStationId, toStationId, serviceKey] = key.split('\u0000');
      const minutes = median(samples);
      if (!Number.isFinite(minutes)) continue;
      (rideEdges[fromStationId] ??= []).push([
        toStationId,
        Number(minutes.toFixed(2)),
        serviceKey,
      ]);
    }

    const transferEdges = {};
    for (const transfer of transfers) {
      if (transfer.transfer_type === '3') continue;
      const fromStationId = stationIdByGtfsStopId.get(transfer.from_stop_id)?.stationId;
      const toStationId = stationIdByGtfsStopId.get(transfer.to_stop_id)?.stationId;
      if (!fromStationId || !toStationId || fromStationId === toStationId) continue;
      const publishedMinutes = Number(transfer.min_transfer_time) / 60;
      const minutes = Number.isFinite(publishedMinutes) && publishedMinutes > 0
        ? publishedMinutes
        : 3;
      (transferEdges[fromStationId] ??= []).push([
        toStationId,
        Number(minutes.toFixed(2)),
      ]);
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
      graph: { e: rideEdges, t: transferEdges },
    };

    await writeFile(
      resolve(dataDir, 'cdmx-schedules.json'),
      `${JSON.stringify(output)}\n`,
      'utf8',
    );
    console.log(
      `Wrote data/cdmx-schedules.json with ${output.matched_station_count.toLocaleString()} matched OSM station records and ${Object.keys(routeProfiles).length.toLocaleString()} routes.`,
    );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
