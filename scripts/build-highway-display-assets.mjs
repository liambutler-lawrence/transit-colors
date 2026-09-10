import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  highwayCircumferenceDataSchema,
  highwayCircumferenceSummary,
  highwayFeatureCollection,
} from '../src/highway-circumference.ts';

export async function buildHighwayDisplayAssets(dataPath, tilesPath) {
  const data = highwayCircumferenceDataSchema.parse(
    JSON.parse(await readFile(dataPath, 'utf8')),
  );
  const directory = await mkdtemp(join(tmpdir(), 'highway-display-'));
  try {
    const input = join(directory, 'route.geojson');
    const collection = highwayFeatureCollection(data);
    for (const [index, feature] of collection.features.entries()) {
      feature.properties.segment_id = index;
    }
    await writeFile(input, JSON.stringify(collection));
    const process = spawn(
      'tippecanoe',
      [
        '--force',
        `--output=${tilesPath}`,
        '--layer=boundary',
        '--minimum-zoom=0',
        '--maximum-zoom=14',
        '--no-feature-limit',
        '--no-tile-size-limit',
        '--simplify-only-low-zooms',
        '--no-tile-stats',
        '--quiet',
        '--name=North America highway boundary',
        '--attribution=© OpenStreetMap contributors',
        input,
      ],
      { stdio: 'inherit' },
    );
    const [code] = await once(process, 'exit');
    if (code !== 0)
      throw new Error(`Boundary tile build failed with exit code ${code}`);
    const summaryPath = dataPath.replace(/\.json$/, '-summary.json');
    await writeFile(
      summaryPath,
      `${JSON.stringify(highwayCircumferenceSummary(data))}\n`,
    );
    console.info(`Built ${summaryPath} and ${tilesPath}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildHighwayDisplayAssets(
    resolve(process.argv[2] ?? 'data/north-america-highway-circumference.json'),
    resolve(process.argv[3] ?? 'data/north-america-highways-route.pmtiles'),
  );
}
