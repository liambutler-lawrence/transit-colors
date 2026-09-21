import fs from 'node:fs';
import { deserialize } from 'node:v8';
import { createHash } from 'node:crypto';
import {
  firstCircleEntry,
  lineTraversesSubdivision,
  lineLength,
} from './government-connections-geometry.mjs';
import { shortestCircleRoute, adjacency } from './government-connections-routing.mjs';
import { interchangeApproaches } from './government-connections-interchanges.mjs';
import { applySourceRecoveries } from './government-connections-recoveries.mjs';
const read = (path) => JSON.parse(fs.readFileSync(path, 'utf8'));
const routeFile = 'data/north-america-highway-circumference.json';
const { route } = read(routeFile),
  { seats } = read('data/north-america-government-seats.json');
const boundaries = read('data/north-america-subdivisions.geojson');
const classificationInputs = [
  routeFile,
  'data/north-america-government-seats.json',
  'data/north-america-subdivisions.geojson',
  'scripts/government-connections-geometry.mjs',
];
const classificationHash = createHash('sha256');
for (const input of classificationInputs)
  classificationHash.update(fs.readFileSync(input));
const classificationFingerprint = classificationHash.digest('hex');
const classificationPath =
  'data/.osm-highway-cache/government-connections-subdivisions.json';
const cachedClassification = fs.existsSync(classificationPath)
  ? read(classificationPath)
  : null;
const classification =
  cachedClassification?.fingerprint === classificationFingerprint
    ? cachedClassification.records
    : seats.map((seat) => ({
        id: seat.id,
        traversed:
          route.countries.includes(seat.country) &&
          lineTraversesSubdivision(
            route.coordinates,
            boundaries.features.find((f) => f.properties.id === seat.id).geometry,
          ),
        circle: Boolean(firstCircleEntry(route.coordinates, seat.coordinates)),
      }));
fs.writeFileSync(
  classificationPath,
  JSON.stringify({ fingerprint: classificationFingerprint, records: classification }),
);
const network = deserialize(
  fs.readFileSync('data/.osm-highway-cache/government-connections-network.bin'),
);
applySourceRecoveries(
  network,
  read('data/government-connection-source-recoveries.json'),
  fs
    .readFileSync(
      'data/.osm-highway-cache/government-connections-source.sha256',
      'utf8',
    )
    .trim(),
);
if (
  network.routeMatch.missing.length ||
  network.routeMatch.boundaryJunctionAnomalies.length
)
  throw new Error(
    `Published circumference has ${network.routeMatch.missing.length} unmatched graph segments; rebuild or reconcile before routing.`,
  );
console.log('Finding source-proven interchange approaches');
const { starts, seeds, boundaryEdges } = interchangeApproaches(network);
console.log(
  starts.length,
  'paired approach states from',
  seeds.length,
  'boundary departures',
);
const incident = adjacency(network.edges),
  features = [],
  results = [];
for (const seat of seats) {
  const record = { id: seat.id, subdivision: seat.subdivision };
  const eligibility = classification.find((c) => c.id === seat.id);
  if (!eligibility.traversed) record.status = 'not-traversed';
  else if (eligibility.circle) record.status = 'already-reached';
  else {
    console.log('Searching', seat.id);
    const result = shortestCircleRoute({
      edges: network.edges,
      incident,
      starts,
      center: seat.coordinates,
      forbiddenEdges: boundaryEdges,
    });
    const unrestricted = shortestCircleRoute({
      edges: network.edges,
      incident,
      starts: seeds.map((seed) => ({
        node: seed.node,
        incoming: seed.incoming,
        seed: { boundarySeed: seed },
      })),
      center: seat.coordinates,
      forbiddenEdges: boundaryEdges,
    });
    record.unrestrictedLengthMeters = unrestricted?.distanceMeters ?? null;
    if (unrestricted)
      record.nearestApproachAudit = {
        boundaryNode: unrestricted.seed.boundarySeed.node,
        direction: unrestricted.seed.boundarySeed.direction,
        sourceParts: [
          ...new Set(
            unrestricted.steps.flatMap(
              (step) => network.edges[step.edgeIndex].partIndices,
            ),
          ),
        ].map((i) => network.parts[i].id),
      };
    if (!result) {
      record.status = 'no-eligible-connection';
      record.reason = unrestricted
        ? 'requires-both-direction-audit'
        : 'no-source-graph-route';
    } else {
      const primary = [...result.seed.primary.steps, ...result.steps];
      const secondary = result.seed.secondary.steps;
      const clipped = [];
      for (const [approach, steps] of [
        ['primary', primary],
        ['opposite-direction', secondary],
      ]) {
        for (const step of steps) {
          const cut = firstCircleEntry(step.coordinates, seat.coordinates);
          const coordinates = cut?.coordinates ?? step.coordinates;
          if (coordinates.length >= 2) clipped.push({ ...step, coordinates, approach });
          if (cut) break;
        }
      }
      const used = new Set();
      for (const step of clipped) {
        const key = `${step.edgeIndex}:${JSON.stringify(step.coordinates)}`;
        if (used.has(key)) continue;
        used.add(key);
        const edge = network.edges[step.edgeIndex];
        features.push({
          type: 'Feature',
          properties: {
            id: seat.id,
            subdivision: seat.subdivision,
            role: edge.role,
            approach: step.approach,
          },
          geometry: { type: 'LineString', coordinates: step.coordinates },
        });
      }
      const sourceParts = [
        ...new Set(clipped.flatMap((s) => network.edges[s.edgeIndex].partIndices)),
      ].map((i) => network.parts[i]);
      record.status = 'connected';
      record.lengthMeters = clipped
        .filter((s) => s.approach === 'primary')
        .reduce((sum, s) => sum + lineLength(s.coordinates), 0);
      record.circleEntry = clipped
        .filter((s) => s.approach === 'primary')
        .at(-1)
        .coordinates.at(-1);
      record.approaches = [result.seed.primary, result.seed.secondary].map((s) => ({
        boundaryNode: s.seed.node,
        boundaryCoordinate: s.steps[0].coordinates[0],
        receivingCoordinate: s.steps.at(-1).coordinates.at(-1),
        boundaryDirection: s.seed.direction,
        sourceParts: [
          ...new Set(
            s.steps.flatMap((step) => network.edges[step.edgeIndex].partIndices),
          ),
        ].map((i) => network.parts[i].id),
      }));
      record.sourceWayIds = [
        ...new Set(sourceParts.flatMap((p) => p.sourceWayIds ?? [])),
      ];
      console.log('Connected', seat.id, Math.round(record.lengthMeters / 1000), 'km');
    }
  }
  results.push(record);
}
const manifest = {
  sourceFingerprint: fs
    .readFileSync(
      'data/.osm-highway-cache/government-connections-source.sha256',
      'utf8',
    )
    .trim(),
  boundaryProof: {
    sourceCorridors: network.routeMatch.selectedCorridorCount,
    matchedDisplaySegments: network.routeMatch.matchedAtoms,
    junctionAnomalies: network.routeMatch.boundaryJunctionAnomalies.length,
  },
  sourceRecoveries: network.sourceRecoveries,
  method:
    'Shortest WGS84 distance to the 5 km radius boundary; source-topology turn constraints and both directions at one interchange',
  circumferenceSha256: createHash('sha256')
    .update(fs.readFileSync(routeFile))
    .digest('hex'),
  results,
};
fs.writeFileSync(
  'data/north-america-government-connections.geojson',
  JSON.stringify({ type: 'FeatureCollection', features }) + '\n',
);
fs.writeFileSync(
  'data/north-america-government-connections.json',
  JSON.stringify(manifest, null, 2) + '\n',
);
fs.writeFileSync(
  'data/north-america-government-connection-status.json',
  JSON.stringify(
    results.map(({ id, status, lengthMeters }) => ({ id, status, lengthMeters })),
  ) + '\n',
);
console.log(results.map((r) => `${r.id}: ${r.status}`).join('\n'));
