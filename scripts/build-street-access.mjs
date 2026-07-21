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
const openStations = stations.features.filter(
  (feature) => feature.properties.status === 'open',
);
const stationIndexes = new Map(
  openStations.map((feature, index) => [feature.properties.id, index]),
);

await assignNearestStations(streets.features, stations.features, {
  batchSize: 25_000,
  onProgress(completed, total) {
    console.log(
      `Matched ${completed.toLocaleString()} of ${total.toLocaleString()} streets.`,
    );
  },
  yieldControl: async () => {},
});

const streetStationIndexes = streets.features.map((feature) =>
  stationIndexes.get(feature.properties.s),
);
if (streetStationIndexes.some((index) => !Number.isInteger(index))) {
  throw new Error('At least one street could not be matched to an open station.');
}

const output = {
  station_ids: openStations.map((feature) => feature.properties.id),
  street_station_indexes: streetStationIndexes,
};

await writeFile(
  resolve(dataDir, 'cdmx-street-access.json'),
  `${JSON.stringify(output)}\n`,
  'utf8',
);
console.log('Wrote data/cdmx-street-access.json');
