import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { nameAutomaticTimezoneRegions } from '../src/automatic-timezone-names.ts';
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
// The compact, committed place snapshot makes naming reproducible without
// depending on GeoNames' rolling download or adding a browser gazetteer download.
const places = JSON.parse(
  gunzipSync(
    await readFile(
      new URL('./data/automatic-timezone-places.json.gz', import.meta.url),
    ),
  ).toString('utf8'),
);
const supplementalById = new Map(places.secondary.map((p) => [p[0], p]));
const countryCodes = new Map();
for (const region of regions.filter((r) => r.level === 0)) {
  const codes = countryCodes.get(region.iso_code) ?? [];
  codes.push(region.country_code);
  countryCodes.set(region.iso_code, codes);
}
// These ISO territories are included in the existing parent country's footprint.
// Use its established grouping, without joining or splitting any polygons.
for (const [code, parent] of [
  ['BQ', 'NLD'],
  ['GF', 'FRA'],
  ['GP', 'FRA'],
  ['MQ', 'FRA'],
  ['RE', 'FRA'],
  ['YT', 'FRA'],
])
  if (!countryCodes.has(code)) countryCodes.set(code, [parent]);
function place(row, countryCode, source) {
  const [id, name, asciiName, longitude, latitude, population, , timezone] = row;
  return {
    id,
    name,
    asciiName,
    longitude,
    latitude,
    population,
    countryCode,
    timezone,
    source,
  };
}
const primaryPlaces = places.primary.map((row) => {
  const entry = place(row, row[6], 'natural-earth-populated-places');
  if (!entry.timezone) entry.timezone = supplementalById.get(row[8])?.[7] ?? '';
  return entry;
});
const secondaryPlaces = places.secondary.flatMap((row) =>
  (countryCodes.get(row[6]) ?? []).map((code) =>
    place(row, code, 'geonames-cities500'),
  ),
);
const continentAreas = {
  Africa: 'Africa',
  Asia: 'Asia',
  Europe: 'Europe',
  Antarctica: 'Antarctica',
  'North America': 'America',
  'South America': 'America',
  Oceania: 'Pacific',
};
const countryAreas = new Map(
  JSON.parse(await readFile(resolve(cache, 'admin0.geojson'), 'utf8')).features.map(
    ({ properties: p }) => [p.ADM0_A3, continentAreas[p.CONTINENT] ?? 'Etc'],
  ),
);
const names = nameAutomaticTimezoneRegions(
  assignments.map(({ region }) => region),
  primaryPlaces,
  secondaryPlaces,
  countryAreas,
);
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
    sources: [...sources, ...places.sources].map(
      ({ id, name, url, sha256, license }) => ({
        id,
        name,
        url,
        sha256,
        license,
      }),
    ),
    notes: [
      'Choose the whole-hour UTC meridian that minimizes maximum absolute skew across every original longitude interval. Subdivide a country or first-level region only when that optimized maximum exceeds 45 minutes; exactly 45 minutes stays whole. Ties favor the offset closest to UTC+0, then the lower offset. The date-line meridian uses UTC+12.',
      'Longitude extents use unsimplified source polygons. General display boundaries are simplified to 0.001 degrees and clipped to their parent footprint. Natural Earth remains a generalized 1:10 million source, not a detailed local boundary survey.',
      'Mexico uses detailed INEGI states (2020) via geoBoundaries. Its country outline is the union of those same states, never a clip to Natural Earth. Shared state boundaries are simplified together with a 0.0001-degree coverage tolerance, retaining every polygon piece and six-decimal coordinates. Polygon validity and shared-edge coverage are checked after rounding.',
      'The pinned Mexico source incorrectly assigns MX-MEX to Distrito Federal (shapeID 31927357B79016588373767); this is corrected to MX-CMX / Ciudad de México, separately from the State of Mexico.',
      'Overlapping longitude intervals are merged exactly. Display coordinates are rounded to five decimals; general polygon pieces below 1e-7 square degrees are omitted, retaining the largest piece for tiny regions. All original islands still affect classification. Coverage gaps use non-topological display simplification.',
      'Natural Earth country/territory grouping follows the existing map; overseas dependencies with separate country entries are evaluated separately.',
      'ISO parent relationships group smaller units into first-level regions, including France, Spain and Indonesia. Boundary snapshots have different dates; source ISO codes can be historical.',
      'French Polynesia and the French Southern Territories use named administrative equivalents with source IDs where ISO subdivision codes do not exist.',
      'Second-level administrative divisions may have source identifiers rather than ISO codes. Canadian census divisions and Chinese prefectures are used instead of mislabeled ADM2 economic regions or counties.',
      'UTC+0 data fallbacks are separate from second-level regions whose optimized maximum skew exceeds 45 minutes. They include unavailable subdivisions and uncovered coastline or island geometry between source datasets.',
      'Names are assigned after the existing country/ADM1/ADM2 UTC decision and do not change geometry, hierarchy, or offsets. Rank Natural Earth populated-place centers inside each terminal region by POP_MAX metropolitan estimates. For non-UN entries whose POP_MAX equals the city-proper POP_MIN, use the larger source LandScan catchment estimate. Centers must match the existing country grouping as well as the polygon. Population ties sort by ASCII place name, then source ID.',
      'Where no Natural Earth populated place is contained, use the largest GeoNames settlement in the committed cities500 snapshot, excluding neighborhoods and abandoned/historical places. Natural Earth places below 50,000 people and all GeoNames choices are labeled as settlements, not measured metro areas. Source population vintages vary; these are naming estimates, not current censuses.',
      'Area/City names use the chosen city name (spaces become underscores) and its IANA geographic area, never its official UTC offset. Homonyms receive administrative suffixes, preserving the bare name for a matching existing IANA city. Regions with no matching place, including coverage gaps, use an explicitly flagged Etc/administrative_name. No nearest city is borrowed to name a region.',
    ],
  },
  regions: regions
    .filter(({ id }) => retained.has(id))
    .map((region) => ({
      ...region,
      naming: names.get(region.id) ?? null,
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
