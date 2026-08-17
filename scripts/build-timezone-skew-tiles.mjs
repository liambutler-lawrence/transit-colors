import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const dataDir = resolve(rootDir, 'data');

const tileSets = [
  {
    description: 'Land-clipped IANA timezone boundaries and hit areas',
    input: resolve(dataDir, 'timezone-skew-zones.geojson'),
    layer: 'timezone_zones',
    name: 'Clock skew timezone boundaries',
    output: resolve(dataDir, 'timezone-skew-zones.pmtiles'),
    properties: ['id', 'timezone_name'],
  },
  {
    description: 'Country boundaries used by the clock skew simulator',
    input: resolve(dataDir, 'timezone-skew-countries.geojson'),
    layer: 'timezone_countries',
    name: 'Clock skew country boundaries',
    output: resolve(dataDir, 'timezone-skew-countries.pmtiles'),
    properties: ['id', 'name'],
  },
];

async function runTippecanoe(tileSet, temporaryPath) {
  const args = [
    '--force',
    `--output=${tileSet.output}`,
    `--layer=${tileSet.layer}`,
    '--minimum-zoom=0',
    '--maximum-zoom=8',
    '--drop-densest-as-needed',
    '--detect-shared-borders',
    '--simplify-only-low-zooms',
    '--no-tile-stats',
    '--quiet',
    `--name=${tileSet.name}`,
    `--description=${tileSet.description}`,
    temporaryPath,
  ];
  const child = spawn('tippecanoe', args, { stdio: 'inherit' });
  const [exitCode] = await once(child, 'exit');
  if (exitCode !== 0) {
    throw new Error(`tippecanoe exited with code ${exitCode}.`);
  }
}

async function buildTileSet(tileSet) {
  const temporaryPath = `${tileSet.output}.geojson`;
  const source = JSON.parse(await readFile(tileSet.input, 'utf8'));
  const compact = {
    type: 'FeatureCollection',
    features: source.features.map((feature) => ({
      type: 'Feature',
      id: feature.id,
      properties: Object.fromEntries(
        tileSet.properties.map((property) => [property, feature.properties[property]]),
      ),
      geometry: feature.geometry,
    })),
  };

  await writeFile(temporaryPath, JSON.stringify(compact));
  try {
    await runTippecanoe(tileSet, temporaryPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

for (const tileSet of tileSets) {
  await buildTileSet(tileSet);
  console.log(`Wrote ${tileSet.output}`);
}
