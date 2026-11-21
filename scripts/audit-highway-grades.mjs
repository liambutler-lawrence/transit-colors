import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { deserialize } from 'node:v8';
import { readOsmMotorwayPbf } from './osm-highway-network.mjs';

const [source, pairedCache] = process.argv.slice(2);
if (!source || !pairedCache) {
  throw new Error(
    'Usage: node --import tsx scripts/audit-highway-grades.mjs MOTORWAYS.osm.pbf PAIRED-NETWORK.bin',
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
const raw = await readFile(routePath);
const { route, source_version: sourceVersion } = JSON.parse(raw);
const parts = deserialize(await readFile(pairedCache)).detailed.parts;
const { nodes, ways } = await readOsmMotorwayPbf(source);
const wayById = new Map(ways.map((way) => [way.id, way]));

function motorwayGrade(way) {
  if (!way) return null;
  const { tags } = way;
  if (
    tags.highway !== 'motorway' ||
    (tags.oneway && !['yes', '-1'].includes(tags.oneway)) ||
    (tags.access_control && tags.access_control !== 'full') ||
    tags.construction ||
    tags.lane_markings === 'no' ||
    Object.keys(tags).some(
      (key) => /(^|:)lanes(:|$)|^hov$/.test(key) && key !== 'lanes',
    ) ||
    !/^[1-9]\d*$/.test(tags.lanes ?? '')
  ) {
    return null;
  }
  if (
    way.nodeIds.some((id) => {
      const tags = nodes.get(id)?.tags;
      return (
        !tags ||
        tags.crossing ||
        tags.railway ||
        ['crossing', 'traffic_signals', 'stop', 'give_way', 'mini_roundabout'].includes(
          tags.highway,
        )
      );
    })
  )
    return null;

  const count = Number(tags.lanes);
  if (count >= 4) return 'A++';
  if (count === 3) return 'A+';
  if (count === 2) return 'A';
  return 'A-';
}

const key = (coordinate) => coordinate.map((value) => value.toFixed(7)).join(',');
function atoms(coordinates) {
  const vertices = coordinates.map(key);
  return vertices.slice(1).flatMap((second, index) => {
    const first = vertices[index];
    if (first === second) return [];
    return [first < second ? `${first}|${second}` : `${second}|${first}`];
  });
}

const boundaryAtoms = route.segments.map(({ coordinates }) => atoms(coordinates));
const wantedAtoms = new Set(boundaryAtoms.flat());
const atomGrades = new Map();
const gradeByWayId = new Map();
const radians = Math.PI / 180;
const gradeOrder = ['A-', 'A', 'A+', 'A++'];

function pairedAtomGrade(start, end, sourceEdges, metersPerDegreeLongitude) {
  const dx = (end[0] - start[0]) * metersPerDegreeLongitude;
  const dy = (end[1] - start[1]) * 111_195;
  const length = Math.hypot(dx, dy);
  if (!length) return null;
  const ux = dx / length;
  const uy = dy / length;
  const bounds = [
    Math.min(start[0], end[0]) - 160 / metersPerDegreeLongitude,
    Math.min(start[1], end[1]) - 160 / 111_195,
    Math.max(start[0], end[0]) + 160 / metersPerDegreeLongitude,
    Math.max(start[1], end[1]) + 160 / 111_195,
  ];
  const directions = [[], []];
  for (const { from, to, grade } of sourceEdges) {
    if (
      Math.max(from[0], to[0]) < bounds[0] ||
      Math.min(from[0], to[0]) > bounds[2] ||
      Math.max(from[1], to[1]) < bounds[1] ||
      Math.min(from[1], to[1]) > bounds[3]
    )
      continue;
    const x = (from[0] - start[0]) * metersPerDegreeLongitude;
    const y = (from[1] - start[1]) * 111_195;
    const ex = (to[0] - from[0]) * metersPerDegreeLongitude;
    const ey = (to[1] - from[1]) * 111_195;
    const along = ex * ux + ey * uy;
    if (Math.abs(along) < Math.hypot(ex, ey) * 0.85 || along === 0) continue;
    const origin = x * ux + y * uy;
    const begin = Math.max(0, Math.min(origin, origin + along));
    const finish = Math.min(length, Math.max(origin, origin + along));
    if (finish <= begin) continue;
    const across = -ex * uy + ey * ux;
    const offset = x * -uy + y * ux;
    const offsetStart = offset + (across * (begin - origin)) / along;
    const offsetEnd = offset + (across * (finish - origin)) / along;
    if (Math.max(Math.abs(offsetStart), Math.abs(offsetEnd)) > 160) continue;
    directions[along > 0 ? 0 : 1].push({ begin, finish, grade });
  }
  let weakest = gradeOrder.length - 1;
  for (const intervals of directions) {
    intervals.sort((first, second) => first.begin - second.begin);
    let coverage = 0;
    for (const { begin, finish, grade } of intervals) {
      // Source vertices and paired averages differ slightly on curves.
      if (!grade || begin > coverage + 0.25) return null;
      coverage = Math.max(coverage, finish);
      weakest = Math.min(weakest, gradeOrder.indexOf(grade));
    }
    if (!intervals.length || coverage < length - 0.25) return null;
  }
  return gradeOrder[weakest];
}

for (const part of parts) {
  if (
    part.role !== 'mainline' ||
    !part.pairedChainId ||
    part.explicitMainlineMerge ||
    part.sourceWayIds.length < 2
  )
    continue;
  if (!atoms(part.coordinates).some((atom) => wantedAtoms.has(atom))) continue;
  const sourceEdges = part.sourceWayIds.flatMap((id) => {
    const way = wayById.get(id);
    if (!way) return [];
    if (!gradeByWayId.has(id)) gradeByWayId.set(id, motorwayGrade(way));
    const nodeIds = way.tags.oneway === '-1' ? [...way.nodeIds].reverse() : way.nodeIds;
    return nodeIds.slice(1).flatMap((nodeId, index) => {
      const from = nodes.get(nodeIds[index])?.coordinate;
      const to = nodes.get(nodeId)?.coordinate;
      return from && to ? [{ from, to, grade: gradeByWayId.get(id) }] : [];
    });
  });
  const metersPerDegreeLongitude = 111_195 * Math.cos(part.coordinates[0][1] * radians);
  for (let index = 1; index < part.coordinates.length; index++) {
    const start = part.coordinates[index - 1];
    const end = part.coordinates[index];
    const [atom] = atoms([start, end]);
    if (!wantedAtoms.has(atom)) continue;
    const grade = pairedAtomGrade(start, end, sourceEdges, metersPerDegreeLongitude);
    const existing = atomGrades.get(atom);
    atomGrades.set(atom, existing === undefined || existing === grade ? grade : null);
  }
}

const segments = boundaryAtoms.map((edges, index) => {
  const { role } = route.segments[index];
  if (role !== 'mainline' || !edges.length) return null;
  const grades = edges.map((edge) => atomGrades.get(edge));
  if (grades.some((grade) => !grade)) return null;
  return gradeOrder.find((grade) => grades.includes(grade));
});
const counts = {};
for (const grade of segments) {
  if (grade !== null) counts[grade] = (counts[grade] ?? 0) + 1;
}
const inputs = {
  boundarySha256: createHash('sha256').update(raw).digest('hex'),
  sourceVersion,
  areaSquareMeters: route.areaSquareMeters,
  segments,
};
await writeFile(outputPath, JSON.stringify(inputs, null, 2) + '\n');
console.log({
  matchedAtoms: atomGrades.size,
  boundaryAtoms: wantedAtoms.size,
  total: segments.length,
  counts,
});
