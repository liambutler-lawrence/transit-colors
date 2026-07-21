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
  candidateCount: 5,
  onProgress(completed, total) {
    console.log(
      `Matched ${completed.toLocaleString()} of ${total.toLocaleString()} streets.`,
    );
  },
  yieldControl: async () => {},
});

const output = {
  station_ids: openStations.map((feature) => feature.properties.id),
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
