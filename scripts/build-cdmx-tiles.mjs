import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const dataDir = resolve(rootDir, 'data');
const streetsPath = resolve(dataDir, 'cdmx-streets.geojson');
const distancesPath = resolve(dataDir, 'cdmx-street-mode-distances.json');
const accessPath = resolve(dataDir, 'cdmx-street-access.json');
const metadataPath = resolve(dataDir, 'cdmx-metadata.json');
const temporaryPath = resolve(dataDir, '.cdmx-streets.ndjson');
const tilesPath = resolve(dataDir, 'cdmx-streets.pmtiles');

const MIN_ZOOM = 8;
const MAX_ZOOM = 14;
const NEAR_DISTANCE_M = 2500;
const TILE_DISTANCE_PRECISION_M = 50;
const MODE_DISTANCE_PROPERTIES = {
  subway: 'ds',
  brt: 'db',
  light_rail: 'dl',
  cable_car: 'dc',
  commuter_rail: 'dt',
  regional_rail: 'dr',
  monorail: 'dm',
};
const MODE_KEYS = Object.keys(MODE_DISTANCE_PROPERTIES);
const FUTURE_MODE_DISTANCE_PROPERTIES = {
  subway: 'fs',
  brt: 'fb',
  light_rail: 'fl',
  cable_car: 'fc',
  commuter_rail: 'ft',
  regional_rail: 'fr',
  monorail: 'fm',
};
const STREET_MIN_ZOOM = {
  motorway: 8,
  trunk: 8,
  motorway_link: 9,
  trunk_link: 9,
  primary: 10,
  primary_link: 10,
  secondary: 10,
  secondary_link: 10,
  tertiary: 10,
  tertiary_link: 10,
  busway: 10,
  residential: 13,
  unclassified: 13,
  living_street: 13,
  service: 14,
  pedestrian: 14,
  track: 14,
};

async function writeLine(stream, value) {
  if (!stream.write(`${JSON.stringify(value)}\n`)) {
    await once(stream, 'drain');
  }
}

function validateData(features, distanceData, streetAccess) {
  if (distanceData.feature_count !== features.length) {
    throw new Error(
      `Street mode distances have ${distanceData.feature_count} features; expected ${features.length}.`,
    );
  }

  for (const mode of MODE_KEYS) {
    const distances = distanceData.distances_by_mode?.[mode];
    if (!distances || distances.length !== features.length) {
      throw new Error(`Invalid street distance data for station mode: ${mode}.`);
    }
  }

  if (
    !Array.isArray(streetAccess.station_ids) ||
    !Array.isArray(streetAccess.street_station_indexes) ||
    streetAccess.street_station_indexes.length !== features.length
  ) {
    throw new Error('Street access data does not match the street feature collection.');
  }
}

function tileDistance(distance, maxDistance) {
  if (distance > maxDistance) return maxDistance + 1;
  return Math.round(distance / TILE_DISTANCE_PRECISION_M) * TILE_DISTANCE_PRECISION_M;
}

function nearCountsByModeSelection(featureCount, distancesByMode) {
  const proximityMaskCounts = new Uint32Array(1 << MODE_KEYS.length);

  for (let featureIndex = 0; featureIndex < featureCount; featureIndex += 1) {
    let proximityMask = 0;

    for (const [modeIndex, mode] of MODE_KEYS.entries()) {
      if (distancesByMode[mode][featureIndex] <= NEAR_DISTANCE_M) {
        proximityMask |= 1 << modeIndex;
      }
    }

    proximityMaskCounts[proximityMask] += 1;
  }

  const result = {};
  for (let selectionMask = 0; selectionMask < 1 << MODE_KEYS.length; selectionMask += 1) {
    const selectionKey = MODE_KEYS.filter(
      (_, modeIndex) => selectionMask & (1 << modeIndex),
    ).join(',');
    let nearCount = 0;

    for (let proximityMask = 1; proximityMask < proximityMaskCounts.length; proximityMask += 1) {
      if (selectionMask & proximityMask) {
        nearCount += proximityMaskCounts[proximityMask];
      }
    }

    result[selectionKey] = nearCount;
  }

  return result;
}

async function buildTippecanoeInput(
  features,
  distancesByMode,
  futureDistancesByMode,
  streetAccess,
  maxDistance,
) {
  const output = createWriteStream(temporaryPath, { encoding: 'utf8' });

  try {
    for (const [featureIndex, feature] of features.entries()) {
      const properties = {
        ...feature.properties,
        d: tileDistance(feature.properties.d, maxDistance),
        i: featureIndex,
        s: streetAccess.station_ids[
          streetAccess.street_station_indexes[featureIndex]
        ],
      };

      for (const [mode, property] of Object.entries(MODE_DISTANCE_PROPERTIES)) {
        properties[property] = tileDistance(
          distancesByMode[mode][featureIndex],
          maxDistance,
        );
      }

      for (const [mode, distances] of Object.entries(futureDistancesByMode)) {
        const property = FUTURE_MODE_DISTANCE_PROPERTIES[mode];
        if (!property || distances.length !== features.length) {
          throw new Error(`Invalid future street distance data for station mode: ${mode}.`);
        }
        properties[property] = tileDistance(distances[featureIndex], maxDistance);
      }

      await writeLine(output, {
        type: 'Feature',
        geometry: feature.geometry,
        properties,
        tippecanoe: {
          minzoom: STREET_MIN_ZOOM[feature.properties?.h] ?? 13,
        },
      });

      if ((featureIndex + 1) % 50_000 === 0) {
        console.log(`Prepared ${(featureIndex + 1).toLocaleString()} street features...`);
      }
    }

    output.end();
    await once(output, 'finish');
  } catch (error) {
    output.destroy();
    throw error;
  }
}

async function runTippecanoe() {
  const args = [
    '--force',
    `--output=${tilesPath}`,
    '--layer=streets',
    `--minimum-zoom=${MIN_ZOOM}`,
    `--maximum-zoom=${MAX_ZOOM}`,
    '--drop-densest-as-needed',
    '--simplify-only-low-zooms',
    '--no-tile-stats',
    '--name=CDMX transit proximity streets',
    '--description=Street distance to selected rapid-transit modes',
    '--attribution=© OpenStreetMap contributors',
    temporaryPath,
  ];
  const child = spawn('tippecanoe', args, { stdio: 'inherit' });
  const [exitCode] = await once(child, 'exit');

  if (exitCode !== 0) {
    throw new Error(`tippecanoe exited with code ${exitCode}.`);
  }
}

async function main() {
  const [streets, distanceData, streetAccess, metadata] = await Promise.all(
    [streetsPath, distancesPath, accessPath, metadataPath].map(async (path) =>
      JSON.parse(await readFile(path, 'utf8')),
    ),
  );
  const features = streets.features ?? [];
  const distancesByMode = distanceData.distances_by_mode ?? {};
  const futureDistancesByMode = distanceData.future_distances_by_mode ?? {};

  validateData(features, distanceData, streetAccess);
  console.log(`Preparing ${features.length.toLocaleString()} streets for vector tiling...`);

  await buildTippecanoeInput(
    features,
    distancesByMode,
    futureDistancesByMode,
    streetAccess,
    distanceData.max_distance_m ?? 5000,
  );

  try {
    await runTippecanoe();
  } finally {
    await rm(temporaryPath, { force: true });
  }

  const optimizedMetadata = {
    ...metadata,
    street_tiles_file: 'data/cdmx-streets.pmtiles',
    street_tiles_min_zoom: MIN_ZOOM,
    street_tiles_max_zoom: MAX_ZOOM,
    street_tile_distance_precision_m: TILE_DISTANCE_PRECISION_M,
    near_count_threshold_m: NEAR_DISTANCE_M,
    near_count_mode_order: MODE_KEYS,
    near_counts_by_mode_selection: nearCountsByModeSelection(
      features.length,
      distancesByMode,
    ),
  };

  await writeFile(metadataPath, `${JSON.stringify(optimizedMetadata)}\n`, 'utf8');
  console.log('Wrote data/cdmx-streets.pmtiles');
  console.log('Updated data/cdmx-metadata.json with constant-time filter counts');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
