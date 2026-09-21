import fs from 'node:fs';
import { createHash } from 'node:crypto';
import {
  readOsmMotorwayPbf,
  prepareWays,
  averageReciprocalPathCoordinates,
} from './osm-highway-network.mjs';
import { distance } from './government-connections-geometry.mjs';
const source = 'data/.osm-highway-cache/north-america-motorways.osm.pbf';
const recoveries = JSON.parse(
  fs.readFileSync('data/government-connection-source-recoveries.json', 'utf8'),
);
const hash = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
if (recoveries.some((r) => r.sourcePbfSha256 !== hash))
  throw new Error('Source changed; re-audit recovered paths');
const osm = await readOsmMotorwayPbf(source),
  prepared = prepareWays(osm);
for (const recovery of recoveries) {
  const all = recovery.directionalPaths.flatMap((p) => p.coordinates),
    xs = all.map((p) => p[0]),
    ys = all.map((p) => p[1]);
  const minX = Math.min(...xs) - 0.001,
    maxX = Math.max(...xs) + 0.001,
    minY = Math.min(...ys) - 0.001,
    maxY = Math.max(...ys) + 0.001;
  const segments = [];
  for (const way of [...prepared.mainlines, ...prepared.connectors])
    for (let i = 1; i < way.coordinates.length; i++) {
      const a = way.coordinates[i - 1],
        b = way.coordinates[i];
      if (
        Math.max(a[0], b[0]) < minX ||
        Math.min(a[0], b[0]) > maxX ||
        Math.max(a[1], b[1]) < minY ||
        Math.min(a[1], b[1]) > maxY
      )
        continue;
      segments.push({
        wayId: way.id,
        fromNodeId: way.nodeIds[i - 1],
        toNodeId: way.nodeIds[i],
        a,
        b,
      });
    }
  for (const path of recovery.directionalPaths) {
    const proof = [];
    for (let i = 1; i < path.coordinates.length; i++) {
      const a = path.coordinates[i - 1],
        b = path.coordinates[i];
      if (distance(a, b) < 0.001) continue;
      const match = segments
        .map((s) => ({ ...s, fromFraction: project(a, s), toFraction: project(b, s) }))
        .find(
          (s) =>
            s.fromFraction !== null &&
            s.toFraction !== null &&
            s.toFraction > s.fromFraction,
        );
      if (!match)
        throw new Error(
          `Unproven directed road segment in ${recovery.id}: ${JSON.stringify([a, b])}`,
        );
      const { wayId, fromNodeId, toNodeId, fromFraction, toFraction } = match;
      proof.push({ wayId, fromNodeId, toNodeId, fromFraction, toFraction });
    }
    // Consecutive source segments must share the actual directed OSM node.
    for (let i = 1; i < proof.length; i++)
      if (proof[i - 1].toNodeId !== proof[i].fromNodeId)
        throw new Error('Recovered route changes roads without a source junction');
    path.sourceSegments = proof;
  }
  const expected = averageReciprocalPathCoordinates(
    recovery.directionalPaths[0].coordinates,
    recovery.directionalPaths[1].coordinates.toReversed(),
    recovery.start.coordinate,
    recovery.end.coordinate,
  );
  if (JSON.stringify(expected) !== JSON.stringify(recovery.coordinates))
    throw new Error('Recovery is not the source closest-tangent midpoint');
  console.log(
    'Verified',
    recovery.id,
    recovery.directionalPaths.map((p) => p.sourceSegments.length),
    'directed source segments',
  );
}
if (process.argv.includes('--write-proof'))
  fs.writeFileSync(
    'data/government-connection-source-recoveries.json',
    JSON.stringify(recoveries, null, 2) + '\n',
  );
function project(p, { a, b }) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    den = dx * dx + dy * dy;
  if (!den) return null;
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / den;
  if (t < -1e-5 || t > 1.00001) return null;
  return distance(p, [a[0] + t * dx, a[1] + t * dy]) < 0.02
    ? Math.max(0, Math.min(1, t))
    : null;
}
