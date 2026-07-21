import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OFFICIAL_SOURCES } from './cdmx-curated-stations.mjs';
import {
  buildStreetFeatures,
  featureCollection,
  histogram,
  propertyCounts,
  reconcileStationFeatures,
  setProjectionCenter,
  writeJson,
} from './build-cdmx-data.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, '..', 'data');

const [stationCollection, streetCollection, metadata] = await Promise.all(
  ['cdmx-stations.geojson', 'cdmx-streets.geojson', 'cdmx-metadata.json'].map(
    async (filename) => JSON.parse(await readFile(resolve(dataDir, filename), 'utf8')),
  ),
);

const stationFeatures = reconcileStationFeatures(stationCollection.features ?? []);
const openStationFeatures = stationFeatures.filter(
  (feature) => feature.properties.status === 'open',
);
const futureStationFeatures = stationFeatures.filter(
  (feature) => feature.properties.status !== 'open',
);

setProjectionCenter(metadata.bbox);
const streetElements = (streetCollection.features ?? []).map((feature) => ({
  geometry: feature.geometry.coordinates.map(([lon, lat]) => ({ lon, lat })),
  tags: {
    highway: feature.properties.h,
    name: feature.properties.n,
  },
}));

console.log(
  `Recomputing ${(streetElements.length).toLocaleString()} streets against ${openStationFeatures.length.toLocaleString()} open stations...`,
);
const streetBuild = buildStreetFeatures(
  streetElements,
  openStationFeatures,
  futureStationFeatures,
);
const streetFeatures = streetBuild.features;

const updatedMetadata = {
  ...metadata,
  generated_at: new Date().toISOString(),
  station_count: stationFeatures.length,
  open_station_count: openStationFeatures.length,
  future_station_count: futureStationFeatures.length,
  station_modes: propertyCounts(stationFeatures, 'mode'),
  station_modes_open: propertyCounts(openStationFeatures, 'mode'),
  station_modes_future: propertyCounts(futureStationFeatures, 'mode'),
  station_statuses: propertyCounts(stationFeatures, 'status'),
  histogram: histogram(streetFeatures),
  sources: [
    ...new Set([
      ...(metadata.sources ?? []),
      ...Object.values(OFFICIAL_SOURCES),
    ]),
  ],
};

await Promise.all([
  writeJson(
    resolve(dataDir, 'cdmx-stations.geojson'),
    featureCollection(stationFeatures),
  ),
  writeJson(
    resolve(dataDir, 'cdmx-streets.geojson'),
    featureCollection(streetFeatures),
  ),
  writeJson(resolve(dataDir, 'cdmx-street-mode-distances.json'), {
    feature_count: streetFeatures.length,
    max_distance_m: metadata.max_distance_m,
    over_range_value: metadata.street_mode_distance_over_range_value,
    distances_by_mode: streetBuild.modeDistances,
    future_distances_by_mode: streetBuild.futureModeDistances,
  }),
  writeJson(resolve(dataDir, 'cdmx-street-access.json'), {
    station_ids: openStationFeatures.map((feature) => feature.properties.id),
    future_station_ids: futureStationFeatures.map(
      (feature) => feature.properties.id,
    ),
    street_station_indexes: streetBuild.accessStationIndexes,
    station_indexes_by_mode: streetBuild.modeAccessStationIndexes,
    future_station_indexes_by_mode:
      streetBuild.futureModeAccessStationIndexes,
  }),
  writeJson(resolve(dataDir, 'cdmx-metadata.json'), updatedMetadata),
]);

console.log('Rebuilt checked-in CDMX station, street distance, and access data.');
