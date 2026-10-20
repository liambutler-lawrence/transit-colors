import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { serialize, deserialize } from 'node:v8';
import {
  readOsmMotorwayPbf,
  buildOsmHighwayCenterlines,
  buildMidpointTopologyGraph,
  finalizeMidpointTopology,
} from './osm-highway-network.mjs';
import { connectionNetwork } from './government-connections-network.mjs';
const cache = 'data/.osm-highway-cache/government-connections';
const source = 'data/.osm-highway-cache/north-america-motorways.osm.pbf';
const inputs = [
  source,
  'scripts/osm-highway-network.mjs',
  'scripts/highway-midpoint-topology.mjs',
  'scripts/highway-turns.mjs',
  'src/geodesy.ts',
  'scripts/wgs84-geodesy.mjs',
  'scripts/highway-ordered-midpoint.mjs',
  'scripts/highway-source-correspondence.mjs',
  'scripts/highway-shared-midpoints.mjs',
  'scripts/ordered-midline.mjs',
  'scripts/highway-ramp-attachment-aliases.mjs',
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
  const derivedPath = 'data/.osm-highway-cache/north-america-derived-network.bin';
  const geometryFingerprint = createHash('sha256');
  for (const name of [
    'osm-highway-network.mjs',
    'highway-midpoint-topology.mjs',
    'highway-ordered-midpoint.mjs',
    'highway-source-correspondence.mjs',
    'highway-shared-midpoints.mjs',
    'highway-mainline-endings.mjs',
    'ordered-midline.mjs',
    'highway-ramp-attachment-aliases.mjs',
    'highway-terminal-continuations.mjs',
  ])
    geometryFingerprint.update(fs.readFileSync(new URL(name, import.meta.url)));
  let detailed;
  if (
    fs.existsSync(derivedPath) &&
    fs.statSync(derivedPath).mtimeMs >= fs.statSync(source).mtimeMs
  ) {
    const derived = deserialize(fs.readFileSync(derivedPath));
    if (
      derived.displayTopologyVersion === 50 &&
      derived.midpointFingerprint === geometryFingerprint.digest('hex')
    ) {
      detailed = derived.detailed;
      console.info('Reusing the freshly built highway midpoint geometry');
    }
  }
  if (!detailed) {
    console.info('Reading OSM motorway topology');
    const osm = await readOsmMotorwayPbf(source);
    console.info('Rebuilding paired mainlines and reciprocal ramps');
    detailed = buildOsmHighwayCenterlines(osm, console.info);
  }
  console.info(
    'Building full graph, including branches outside the circumference two-core',
  );
  graph = buildMidpointTopologyGraph(finalizeMidpointTopology(detailed.parts));
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
