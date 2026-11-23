import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { deserialize, serialize } from 'node:v8';
import { ROAD_GRADES } from '../src/circumference/grades.ts';
import { compressAllHighwayCorridors } from './highway-graph.mjs';
import {
  reviewMainline,
  reviewReciprocalWays,
  roadEvidence,
} from './highway-grade-evidence.mjs';
import {
  buildOsmHighwayCenterlines,
  buildPairedOsmSourceTopologyGraph,
  readOsmMotorwayPbf,
} from './osm-highway-network.mjs';

const cacheRoot = 'data/.osm-highway-cache';
const output = `${cacheRoot}/north-america-graded-network.bin`;
const source = process.argv[2] ?? `${cacheRoot}/north-america-motorways.osm.pbf`;
const displayCache =
  process.argv[3] ?? `${cacheRoot}/north-america-derived-network.bin`;
const boundaryPath = 'data/north-america-highway-circumference.json';
const reviewPath = 'data/north-america-highway-grade-reviews.json';
const crossingReviewPath = 'data/north-america-road-crossing-reviews.json';
const gradePriority = new Map(ROAD_GRADES.map((grade, index) => [grade, index]));

async function sourceFingerprint() {
  const inputs = [
    source,
    boundaryPath,
    reviewPath,
    crossingReviewPath,
    import.meta.filename,
    ...[
      'highway-graph.mjs',
      'highway-grade-evidence.mjs',
      'osm-highway-network.mjs',
      'highway-mainline-merges.mjs',
      'highway-mainline-endings.mjs',
      'highway-terminal-continuations.mjs',
      'highway-ordered-midpoint.mjs',
      'wgs84-geodesy.mjs',
    ].map((file) => new URL(file, import.meta.url)),
    new URL('../src/circumference/grades.ts', import.meta.url),
  ];
  const fingerprint = createHash('sha256');
  for (const input of inputs) fingerprint.update(await readFile(input));
  return fingerprint.digest('hex');
}

async function averagedRoads(osm) {
  try {
    const cache = deserialize(await readFile(displayCache));
    if (cache.displayTopologyVersion === 49) return cache.detailed.parts;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const built = buildOsmHighwayCenterlines(osm, console.info, { retainSamples: false });
  const detailed = {
    parts: built.parts,
    statistics: built.statistics,
    terminalContinuationAudit: built.terminalContinuationAudit,
    rampAttachmentRepairs: built.rampAttachmentRepairs,
    coveredMainlineMerges: built.coveredMainlineMerges,
  };
  await writeFile(displayCache, serialize({ displayTopologyVersion: 49, detailed }));
  return detailed.parts;
}

function compressSource(osm, parts, published) {
  console.info(`Loaded ${parts.length} paired motorway and ramp features.`);
  const graph = buildPairedOsmSourceTopologyGraph(osm, parts);
  if (
    graph.edges.length !== published.methodology.giantNetworkEdgeCount ||
    graph.coordinateByNodeId.size !== published.methodology.giantNetworkNodeCount
  ) {
    throw new Error(
      `Source graph has ${graph.edges.length} edges and ${graph.coordinateByNodeId.size} nodes. Reconcile it with the published highway snapshot before grading.`,
    );
  }
  const compressed = compressAllHighwayCorridors(graph);
  console.info(
    `Compressed ${graph.edges.length} source edges into ${compressed.edges.length} road segments.`,
  );
  return { ...compressed, parts: graph.parts };
}

function geometryKey(coordinates) {
  const keys = coordinates.map((point) =>
    point.map((value) => value.toFixed(7)).join(','),
  );
  return (keys[0] < keys.at(-1) ? keys : keys.reverse()).join(';');
}

async function previouslyReviewedGrades(boundary) {
  const review = JSON.parse(await readFile(reviewPath, 'utf8'));
  if (
    review.areaSquareMeters !== boundary.route.areaSquareMeters ||
    review.sourceVersion !== boundary.source_version ||
    review.segments.length !== boundary.route.segments.length
  ) {
    throw new Error('Road reviews and source boundary snapshots disagree.');
  }
  const entries = boundary.route.segments.flatMap(({ coordinates }, index) =>
    review.segments[index] ? [[geometryKey(coordinates), review.segments[index]]] : [],
  );
  return new Map(entries);
}

function combineReviews(current, prior) {
  if (!prior || current.reason === 'Separation or access exception') return current;
  if (!current.grade || gradePriority.get(prior) > gradePriority.get(current.grade)) {
    return { grade: prior };
  }
  return current;
}

function reviewCorridors(graph, evidence, prior) {
  return graph.edges.map(({ partIndices, ...edge }, index) => {
    const parts = [...partIndices].map((partIndex) => graph.parts[partIndex]);
    const ramps = parts.filter(({ role }) => role === 'connector');
    const roles = ramps.length ? ramps : parts;
    const refs = [...new Set(roles.flatMap(({ tokens }) => tokens ?? []))].filter(
      (token) => !token.startsWith('NAME:'),
    );
    const point = edge.coordinates[Math.floor(edge.coordinates.length / 2)];
    const junction = edge.coordinates.every(
      ([x, y]) => x === point[0] && y === point[1],
    );
    const review = junction
      ? { junction: true }
      : ramps.length
        ? reviewReciprocalWays(
            [...new Set(ramps.flatMap(({ sourceWayIds }) => sourceWayIds))],
            evidence.roads,
            point,
          )
        : reviewMainline(edge.coordinates, evidence, { fullRubric: true });
    return {
      ...edge,
      id: index + 1,
      role: ramps.length ? 'connector' : 'mainline',
      name: refs.join(' / '),
      review: junction
        ? review
        : combineReviews(review, prior.get(geometryKey(edge.coordinates))),
    };
  });
}

async function sourceGraphAndEvidence(published) {
  const osm = await readOsmMotorwayPbf(source);
  const graph = compressSource(osm, await averagedRoads(osm), published);
  globalThis.gc?.();
  const review = JSON.parse(await readFile(crossingReviewPath, 'utf8'));
  const gradeSeparatedNodes = new Set(
    review.gradeSeparatedCrossings.flatMap(({ nodeIds }) => nodeIds),
  );
  return { graph, evidence: roadEvidence(osm, { gradeSeparatedNodes }) };
}

const fingerprint = await sourceFingerprint();
let cached;
try {
  cached = deserialize(await readFile(output));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (cached?.fingerprint === fingerprint) {
  console.info(`Reused ${output}.`);
} else {
  console.time('Prepare North American road grades');
  const published = JSON.parse(await readFile(boundaryPath, 'utf8'));
  const { graph, evidence } = await sourceGraphAndEvidence(published);
  globalThis.gc?.();
  const grades = await previouslyReviewedGrades(published);
  const edges = reviewCorridors(graph, evidence, grades);
  const counts = Object.groupBy(
    edges,
    ({ review }) => review.grade ?? review.reason ?? 'Coincident graph join',
  );
  console.info(
    Object.fromEntries(
      Object.entries(counts).map(([key, items]) => [key, items.length]),
    ),
  );
  await writeFile(
    output,
    serialize({
      fingerprint,
      sourceVersion: published.source_version,
      nodes: graph.nodes,
      edges,
    }),
  );
  console.timeEnd('Prepare North American road grades');
}
