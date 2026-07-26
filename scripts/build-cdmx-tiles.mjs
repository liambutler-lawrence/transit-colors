import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createStreetAccessScorer,
  splitStreetFeature,
  streetJunctionKeys,
} from '../routing.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const dataDir = resolve(rootDir, 'data');
const streetsPath = resolve(dataDir, 'cdmx-streets.geojson');
const stationsPath = resolve(dataDir, 'cdmx-stations.geojson');
const metadataPath = resolve(dataDir, 'cdmx-metadata.json');
const temporaryPath = resolve(dataDir, '.cdmx-streets.ndjson');
const tilesPath = resolve(dataDir, 'cdmx-streets.pmtiles');

const MIN_ZOOM = 8;
const MAX_ZOOM = 14;
const MAX_SEGMENT_LENGTH_M = 200;
const SCORING_BATCH_SIZE = 20_000;
const NEAR_DISTANCE_M = 2500;
const TILE_DISTANCE_PRECISION_M = 25;
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
const MODE_ACCESS_PROPERTIES = {
  subway: 'as',
  brt: 'ab',
  light_rail: 'al',
  cable_car: 'ac',
  commuter_rail: 'at',
  regional_rail: 'ar',
  monorail: 'am',
};
const FUTURE_MODE_ACCESS_PROPERTIES = {
  subway: 'us',
  brt: 'ub',
  light_rail: 'ul',
  cable_car: 'uc',
  commuter_rail: 'ut',
  regional_rail: 'ur',
  monorail: 'um',
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

function tileDistance(distance, maxDistance) {
  if (distance > maxDistance) return maxDistance + 1;
  return Math.round(distance / TILE_DISTANCE_PRECISION_M) * TILE_DISTANCE_PRECISION_M;
}

function nearCountsByModeSelection(proximityMaskCounts) {
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

function createHistogram() {
  return {
    under_500_m: 0,
    under_1000_m: 0,
    under_2500_m: 0,
    under_5000_m: 0,
    over_5000_m: 0,
  };
}

function recordSegmentStatistics(
  feature,
  histogram,
  proximityMaskCounts,
  maxDistance,
) {
  const distance = Number(feature.properties.d);
  if (distance <= 500) histogram.under_500_m += 1;
  if (distance <= 1000) histogram.under_1000_m += 1;
  if (distance <= 2500) histogram.under_2500_m += 1;
  if (distance <= maxDistance) {
    histogram.under_5000_m += 1;
  } else {
    histogram.over_5000_m += 1;
  }

  let proximityMask = 0;
  for (const [modeIndex, mode] of MODE_KEYS.entries()) {
    if (Number(feature.properties[MODE_DISTANCE_PROPERTIES[mode]]) <= NEAR_DISTANCE_M) {
      proximityMask |= 1 << modeIndex;
    }
  }
  proximityMaskCounts[proximityMask] += 1;
}

function scoreStreetSegments(segments, scoringContext, maxDistance) {
  scoringContext.openScorer.score(segments, {
    candidateCount: 5,
    modeProperties: Object.fromEntries(
      Object.entries(MODE_DISTANCE_PROPERTIES).map(([mode, distance]) => [
        mode,
        { station: `__open_${mode}`, distance },
      ]),
    ),
  });
  for (const segment of segments) {
    if (segment.properties.d > maxDistance) {
      segment.properties.o = 1;
    } else {
      delete segment.properties.o;
    }
    for (const mode of MODE_KEYS) {
      const stationProperty = `__open_${mode}`;
      segment.properties[MODE_ACCESS_PROPERTIES[mode]] =
        scoringContext.openStationIndexes.get(segment.properties[stationProperty]);
      delete segment.properties[stationProperty];
    }
  }

  if (!scoringContext.futureScorer) return;
  scoringContext.futureScorer.score(segments, {
    modeProperties: Object.fromEntries(
      [...scoringContext.futureModes].map((mode) => [
        mode,
        {
          station: `__future_${mode}`,
          distance: FUTURE_MODE_DISTANCE_PROPERTIES[mode],
        },
      ]),
    ),
  });
  for (const segment of segments) {
    for (const mode of scoringContext.futureModes) {
      const stationProperty = `__future_${mode}`;
      segment.properties[FUTURE_MODE_ACCESS_PROPERTIES[mode]] =
        scoringContext.futureStationIndexes.get(segment.properties[stationProperty]);
      delete segment.properties[stationProperty];
    }
  }
}

function createScoringContext(openStations, futureStations) {
  const futureModes = new Set(
    futureStations
      .map((feature) => feature.properties.mode)
      .filter((mode) => FUTURE_MODE_DISTANCE_PROPERTIES[mode]),
  );
  return {
    openScorer: createStreetAccessScorer(openStations, {
      exhaustive: true,
      stationFilter: () => true,
    }),
    openStationIndexes: new Map(
      openStations.map((feature, index) => [feature.properties.id, index]),
    ),
    futureScorer:
      futureStations.length > 0
        ? createStreetAccessScorer(futureStations, { stationFilter: () => true })
        : null,
    futureStationIndexes: new Map(
      futureStations.map((feature, index) => [feature.properties.id, index]),
    ),
    futureModes,
  };
}

async function buildTippecanoeInput(
  features,
  stationFeatures,
  maxDistance,
) {
  const output = createWriteStream(temporaryPath, { encoding: 'utf8' });
  const junctionKeys = streetJunctionKeys(features);
  const openStations = stationFeatures.filter(
    (feature) => feature.properties.status === 'open',
  );
  const futureStations = stationFeatures.filter(
    (feature) => feature.properties.status !== 'open',
  );
  const scoringContext = createScoringContext(openStations, futureStations);
  const histogram = createHistogram();
  const proximityMaskCounts = new Uint32Array(1 << MODE_KEYS.length);
  let featureIndex = 0;
  let sourceFeatureIndex = 0;
  let batch = [];

  const writeBatch = async () => {
    if (batch.length === 0) return;
    scoreStreetSegments(batch, scoringContext, maxDistance);

    for (const feature of batch) {
      const properties = { ...feature.properties, i: featureIndex };

      for (let candidateIndex = 0; candidateIndex < 5; candidateIndex += 1) {
        const suffix = candidateIndex === 0 ? '' : String(candidateIndex + 1);
        properties[`d${suffix}`] = tileDistance(
          properties[`d${suffix}`],
          maxDistance,
        );
      }
      for (const property of Object.values(MODE_DISTANCE_PROPERTIES)) {
        properties[property] = tileDistance(properties[property], maxDistance);
      }
      for (const property of Object.values(FUTURE_MODE_DISTANCE_PROPERTIES)) {
        if (Number.isFinite(properties[property])) {
          properties[property] = tileDistance(properties[property], maxDistance);
        }
      }

      recordSegmentStatistics(
        feature,
        histogram,
        proximityMaskCounts,
        maxDistance,
      );
      await writeLine(output, {
        type: 'Feature',
        geometry: feature.geometry,
        properties,
        tippecanoe: {
          minzoom: STREET_MIN_ZOOM[feature.properties?.h] ?? 13,
        },
      });
      featureIndex += 1;
    }

    console.log(`Prepared ${featureIndex.toLocaleString()} street segments...`);
    batch = [];
  };

  try {
    for (const feature of features) {
      batch.push(
        ...splitStreetFeature(feature, junctionKeys, {
          maxLengthMeters: MAX_SEGMENT_LENGTH_M,
        }),
      );
      sourceFeatureIndex += 1;
      if (batch.length >= SCORING_BATCH_SIZE) await writeBatch();
    }
    await writeBatch();

    output.end();
    await once(output, 'finish');
  } catch (error) {
    output.destroy();
    throw error;
  }

  return {
    featureCount: featureIndex,
    histogram,
    nearCountsByModeSelection: nearCountsByModeSelection(proximityMaskCounts),
    sourceFeatureCount: sourceFeatureIndex,
  };
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
  const [streets, stations, metadata] = await Promise.all(
    [streetsPath, stationsPath, metadataPath].map(async (path) =>
      JSON.parse(await readFile(path, 'utf8')),
    ),
  );
  const features = streets.features ?? [];
  const stationFeatures = stations.features ?? [];
  const maxDistance = metadata.max_distance_m ?? 5000;
  console.log(
    `Splitting and scoring ${features.length.toLocaleString()} source streets for vector tiling...`,
  );

  const segmentBuild = await buildTippecanoeInput(
    features,
    stationFeatures,
    maxDistance,
  );

  try {
    await runTippecanoe();
  } finally {
    await rm(temporaryPath, { force: true });
  }

  const optimizedMetadata = {
    ...metadata,
    street_count: segmentBuild.featureCount,
    street_source_feature_count: segmentBuild.sourceFeatureCount,
    street_segment_max_length_m: MAX_SEGMENT_LENGTH_M,
    histogram: segmentBuild.histogram,
    street_tiles_file: 'data/cdmx-streets.pmtiles',
    street_tiles_min_zoom: MIN_ZOOM,
    street_tiles_max_zoom: MAX_ZOOM,
    street_tile_distance_precision_m: TILE_DISTANCE_PRECISION_M,
    near_count_threshold_m: NEAR_DISTANCE_M,
    near_count_mode_order: MODE_KEYS,
    near_counts_by_mode_selection: segmentBuild.nearCountsByModeSelection,
  };

  await writeFile(metadataPath, `${JSON.stringify(optimizedMetadata)}\n`, 'utf8');
  console.log('Wrote data/cdmx-streets.pmtiles');
  console.log('Updated data/cdmx-metadata.json with constant-time filter counts');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
