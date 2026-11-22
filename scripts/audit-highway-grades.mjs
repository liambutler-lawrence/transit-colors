import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import {
  buildOsmHighwayCenterlines,
  readOsmMotorwayPbf,
} from './osm-highway-network.mjs';
import {
  reviewConnector,
  reviewMainline,
  roadCorridor,
  roadEvidence,
} from './highway-grade-evidence.mjs';

const [source] = process.argv.slice(2);
if (!source) {
  throw new Error(
    'Usage: node --import tsx scripts/audit-highway-grades.mjs MOTORWAYS.osm.pbf',
  );
}

const routePath = new URL(
  '../data/north-america-highway-circumference.json',
  import.meta.url,
);
const outputPath = new URL(
  '../data/north-america-highway-grade-reviews.json',
  import.meta.url,
);
const reportPath = new URL('../docs/circumference-road-grade-gaps.md', import.meta.url);
const raw = await readFile(routePath);
const { route, source_version: sourceVersion } = JSON.parse(raw);
const boundarySha256 = createHash('sha256').update(raw).digest('hex');
const previous = JSON.parse(await readFile(outputPath, 'utf8'));
const previousGrades =
  previous.boundarySha256 === boundarySha256 &&
  previous.segments.length === route.segments.length
    ? previous.segments
    : [];

console.log('Load the motorway extract and retain ways near the published boundary.');
const osm = roadCorridor(await readOsmMotorwayPbf(source), route);
globalThis.gc?.();
console.log('Reconstruct the reciprocal ramp paths near the boundary.');
const pairedConnectors = buildOsmHighwayCenterlines(osm).parts.filter(
  (part) => part.role === 'connector' && part.pairedDirectionCount === 2,
);
globalThis.gc?.();
console.log('Audit roadway evidence for each published section.');
const evidence = roadEvidence(osm);
const findings = route.segments.map(({ role, coordinates }) =>
  role === 'connector'
    ? reviewConnector(coordinates, pairedConnectors, evidence.roads)
    : reviewMainline(coordinates, evidence),
);

const gradeOrder = ['A-', 'A', 'A+', 'A++'];
function weakest(first, second) {
  return gradeOrder[Math.min(gradeOrder.indexOf(first), gradeOrder.indexOf(second))];
}

const segments = findings.map(({ grade }, index) => {
  const priorGrade = previousGrades[index];
  if (priorGrade && grade) return weakest(priorGrade, grade) ?? priorGrade;
  return grade ?? priorGrade ?? null;
});
for (const [index, section] of route.segments.entries()) {
  const first = section.coordinates[0];
  const before = segments[(index + segments.length - 1) % segments.length];
  const after = segments[(index + 1) % segments.length];
  if (
    !segments[index] &&
    before &&
    after &&
    section.coordinates.every(([x, y]) => x === first[0] && y === first[1])
  ) {
    // A repeated junction vertex has no length of road to grade.
    segments[index] = weakest(before, after) ?? null;
  }
}

const counts = Object.fromEntries(
  Object.entries(Object.groupBy(segments, (grade) => grade ?? 'ungraded')).map(
    ([label, sections]) => [label, sections.length],
  ),
);
const report = [
  '# Road boundary sections awaiting a grade',
  '',
  `The audit graded ${segments.length - (counts.ungraded ?? 0)} of ${segments.length} sections of the published North American road boundary.`,
  'The map links mark the first evidence gap in each remaining section.',
  '',
];
for (const [index, { id }] of route.segments.entries()) {
  if (segments[index]) continue;
  const {
    reason,
    point: [longitude, latitude],
    wayIds = [],
  } = findings[index];
  const position = `https://www.openstreetmap.org/?mlat=${latitude.toFixed(6)}&mlon=${longitude.toFixed(6)}#map=17/${latitude.toFixed(6)}/${longitude.toFixed(6)}`;
  const ways = [...new Set(wayIds)].map(
    (wayId) => `[way ${wayId}](https://www.openstreetmap.org/way/${wayId})`,
  );
  report.push(
    `- \`${id}\` · ${reason} · ${[`[Map](${position})`, ...ways].join(' · ')}`,
  );
}
await writeFile(
  outputPath,
  JSON.stringify(
    {
      boundarySha256,
      sourceVersion,
      areaSquareMeters: route.areaSquareMeters,
      segments,
    },
    null,
    2,
  ) + '\n',
);
const reportFilename = fileURLToPath(reportPath);
const reportOptions = await resolveConfig(reportFilename);
await writeFile(
  reportPath,
  await format(report.join('\n') + '\n', {
    ...reportOptions,
    filepath: reportFilename,
  }),
);
console.log(counts);
