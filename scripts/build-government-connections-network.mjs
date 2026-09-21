import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { serialize, deserialize } from 'node:v8';
import {
  readOsmMotorwayPbf,
  buildOsmHighwayCenterlines,
  buildPairedOsmSourceTopologyGraph,
} from './osm-highway-network.mjs';
import { connectionNetwork } from './government-connections-network.mjs';
const cache = 'data/.osm-highway-cache/government-connections';
const source = 'data/.osm-highway-cache/north-america-motorways.osm.pbf';
const inputs = [
  source,
  'scripts/osm-highway-network.mjs',
  'scripts/highway-turns.mjs',
  'src/geodesy.ts',
  'scripts/wgs84-geodesy.mjs',
  'scripts/highway-ordered-midpoint.mjs',
  'scripts/highway-mainline-merges.mjs',
  'scripts/highway-mainline-endings.mjs',
  'scripts/highway-terminal-continuations.mjs',
  'scripts/highway-cycle.mjs',
];
const fingerprint = createHash('sha256');
for (const path of inputs) fingerprint.update(fs.readFileSync(path));
const sourceFingerprint = fingerprint.digest('hex');
const stamp = `${cache}-source.sha256`;
let graph;
if (
  fs.existsSync(stamp) &&
  fs.readFileSync(stamp, 'utf8').trim() === sourceFingerprint &&
  fs.existsSync(`${cache}-graph.bin`)
) {
  console.info('Using verified full source graph cache');
  graph = deserialize(fs.readFileSync(`${cache}-graph.bin`));
} else {
  console.info('Reading OSM motorway topology');
  const osm = await readOsmMotorwayPbf(source);
  console.info('Rebuilding paired mainlines and reciprocal ramps');
  const detailed = buildOsmHighwayCenterlines(osm, console.info);
  console.info(
    'Building full graph, including branches outside the circumference two-core',
  );
  graph = buildPairedOsmSourceTopologyGraph(osm, detailed.parts);
  fs.writeFileSync(`${cache}-parts.bin`, serialize(detailed.parts));
  fs.writeFileSync(`${cache}-graph.bin`, serialize(graph));
  fs.writeFileSync(stamp, sourceFingerprint + '\n');
}
const { route } = JSON.parse(
  fs.readFileSync('data/north-america-highway-circumference.json', 'utf8'),
);
console.info('Matching published circumference and compressing full graph');
const detailedParts = deserialize(fs.readFileSync(`${cache}-parts.bin`));
const result = connectionNetwork(graph, route, detailedParts);
result.sourceFingerprint = sourceFingerprint;
fs.writeFileSync(`${cache}-network.bin`, serialize(result));
console.info(
  'Route coverage',
  result.routeMatch.matchedAtoms,
  '/',
  result.routeMatch.atomCount,
);
if (
  result.routeMatch.missing.length ||
  result.routeMatch.boundaryJunctionAnomalies.length
)
  throw new Error(
    'Published route no longer matches the source graph. Reconcile before publishing connections.',
  );
