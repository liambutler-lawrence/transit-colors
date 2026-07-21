import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assignNearestStations } from '../routing.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, '..', 'data');

const streets = JSON.parse(
  await readFile(resolve(dataDir, 'cdmx-streets.geojson'), 'utf8'),
);
const stations = JSON.parse(
  await readFile(resolve(dataDir, 'cdmx-stations.geojson'), 'utf8'),
);
const distanceData = JSON.parse(
  await readFile(resolve(dataDir, 'cdmx-street-mode-distances.json'), 'utf8'),
);
const openStations = stations.features.filter(
  (feature) => feature.properties.status === 'open',
);
const futureStations = stations.features.filter(
  (feature) => feature.properties.status !== 'open',
);
const stationIndexes = new Map(
  openStations.map((feature, index) => [feature.properties.id, index]),
);

await assignNearestStations(streets.features, stations.features, {
  batchSize: 25_000,
  candidateCount: 5,
  onProgress(completed, total) {
    console.log(
      `Matched ${completed.toLocaleString()} of ${total.toLocaleString()} streets.`,
    );
  },
  yieldControl: async () => {},
});

async function buildModeIndexes(stationPool, distancesByMode, label) {
  const indexesByMode = {};
  const indexByStationId = new Map(
    stationPool.map((feature, index) => [feature.properties.id, index]),
  );

  for (const [mode, distances] of Object.entries(distancesByMode)) {
    if (!Array.isArray(distances) || distances.length !== streets.features.length) {
      throw new Error(`Invalid ${label} distance data for ${mode}.`);
    }
    if (!stationPool.some((feature) => feature.properties.mode === mode)) continue;

    console.log(`Matching ${label} ${mode} access stations...`);
    await assignNearestStations(streets.features, stationPool, {
      batchSize: 25_000,
      distanceForFeature: (_feature, index) => distances[index],
      propertyKey: '__access_station',
      stationFilter: (feature) => feature.properties.mode === mode,
      yieldControl: async () => {},
    });

    const indexes = streets.features.map((feature) => {
      const index = indexByStationId.get(feature.properties.__access_station);
      delete feature.properties.__access_station;
      return index;
    });
    if (indexes.some((index) => !Number.isInteger(index))) {
      throw new Error(`At least one street could not be matched to a ${label} ${mode} station.`);
    }
    indexesByMode[mode] = indexes;
  }

  return indexesByMode;
}

const stationIndexesByMode = await buildModeIndexes(
  openStations,
  distanceData.distances_by_mode ?? {},
  'open',
);
const futureStationIndexesByMode = await buildModeIndexes(
  futureStations,
  distanceData.future_distances_by_mode ?? {},
  'future',
);

const output = {
  station_ids: openStations.map((feature) => feature.properties.id),
  future_station_ids: futureStations.map((feature) => feature.properties.id),
  station_indexes_by_mode: stationIndexesByMode,
  future_station_indexes_by_mode: futureStationIndexesByMode,
};

for (let candidateIndex = 0; candidateIndex < 5; candidateIndex += 1) {
  const suffix = candidateIndex === 0 ? '' : `_${candidateIndex + 1}`;
  const propertySuffix = candidateIndex === 0 ? '' : String(candidateIndex + 1);
  const indexes = streets.features.map((feature) =>
    stationIndexes.get(feature.properties[`s${propertySuffix}`]),
  );
  const distances = streets.features.map((feature) =>
    feature.properties[`d${propertySuffix}`],
  );
  if (
    indexes.some((index) => !Number.isInteger(index)) ||
    distances.some((distance) => !Number.isFinite(distance))
  ) {
    throw new Error(
      `At least one street is missing access-station candidate ${candidateIndex + 1}.`,
    );
  }
  output[`street_station_indexes${suffix}`] = indexes;
  output[`street_station_distances${suffix}`] = distances;
}

await writeFile(
  resolve(dataDir, 'cdmx-street-access.json'),
  `${JSON.stringify(output)}\n`,
  'utf8',
);
console.log('Wrote data/cdmx-street-access.json');
