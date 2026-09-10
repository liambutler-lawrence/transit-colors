import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  automaticRegionSchema,
  automaticTimezoneDataSchema,
  assignAutomaticTimezones,
} from '../src/automatic-timezones.ts';

const cache = resolve(process.argv[2] ?? 'data/.automatic-timezone-cache');
const python = process.env.AUTOMATIC_TIMEZONE_PYTHON ?? 'python3';
const sources = JSON.parse(
  await readFile(new URL('./automatic-timezone-sources.json', import.meta.url), 'utf8'),
);
await mkdir(cache, { recursive: true });
for (const source of sources) {
  const path = resolve(cache, source.file);
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    console.info(`Downloading ${source.name}`);
    const response = await fetch(source.url);
    if (!response.ok) throw new Error(`${source.url}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(path, bytes);
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== source.sha256)
    throw new Error(`Source checksum mismatch: ${source.file}`);
}
const preparedPath = resolve(cache, 'regions.json');
if (!process.argv.includes('--use-prepared')) {
  const child = spawn(
    python,
    ['scripts/prepare-automatic-timezone-boundaries.py', cache, preparedPath],
    { stdio: 'inherit' },
  );
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error(`Boundary preparation exited with ${code}`);
}
const regions = automaticRegionSchema
  .array()
  .parse(JSON.parse(await readFile(preparedPath, 'utf8')));
const assignments = assignAutomaticTimezones(regions);
const retained = new Set();
const byId = new Map(regions.map((region) => [region.id, region]));
for (const { region } of assignments) {
  let current = region;
  while (current) {
    retained.add(current.id);
    current = byId.get(current.parent_id);
  }
}
const leafIds = new Set(assignments.map(({ region }) => region.id));
const data = automaticTimezoneDataSchema.parse({
  metadata: {
    sources: sources.map(({ id, name, url, sha256, license }) => ({
      id,
      name,
      url,
      sha256,
      license,
    })),
    notes: [
      'Longitude extents use unsimplified source polygons. Display boundaries are simplified to 0.012 degrees and clipped to their parent footprint.',
      'Overlapping longitude intervals are merged exactly. Display coordinates are rounded to five decimals; polygon pieces below 1e-5 square degrees are omitted, retaining the largest piece for tiny regions. All original islands still affect classification. Coverage gaps use non-topological display simplification.',
      'Natural Earth country/territory grouping follows the existing map; overseas dependencies with separate country entries are evaluated separately.',
      'ISO parent relationships group smaller units into first-level regions, including France, Spain and Indonesia. Boundary snapshots have different dates; source ISO codes can be historical.',
      'French Polynesia and the French Southern Territories use named administrative equivalents with source IDs where ISO subdivision codes do not exist.',
      'Second-level administrative divisions may have source identifiers rather than ISO codes. Canadian census divisions and Chinese prefectures are used instead of mislabeled ADM2 economic regions or counties.',
      'UTC+0 data fallbacks are separate from second-level regions that exceed the ±60-minute limit. They include unavailable subdivisions and uncovered coastline or island geometry between source datasets.',
    ],
  },
  regions: regions
    .filter(({ id }) => retained.has(id))
    .map((region) => ({
      ...region,
      geometry: leafIds.has(region.id)
        ? region.geometry
        : { type: 'MultiPolygon', coordinates: [] },
    })),
});
await writeFile('data/timezone-automatic-regions.json', JSON.stringify(data) + '\n');
const fallbacks = assignments.filter(({ fallback }) => fallback);
console.info(
  `Wrote ${assignments.length} automatic regions; ${fallbacks.length} UTC+0 exceptions.`,
);
for (const { region, fallback } of fallbacks.filter(
  ({ fallback }) => fallback !== 'uncovered-area',
))
  console.info(`${region.country_name} / ${region.name}: ${fallback}`);
