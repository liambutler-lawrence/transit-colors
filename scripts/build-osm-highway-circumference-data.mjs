import { buildHighwayDisplayAssets } from './build-highway-display-assets.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { deserialize, serialize } from 'node:v8';
import { createHash } from 'node:crypto';
import polygonClipping from 'polygon-clipping';

import { calculateLandmassCoverage } from '../src/circumference-landmass.ts';
import { geodesicLineLengthMeters } from '../src/geodesy.ts';
import { compressHighwayCore, highwayTwoCore } from './highway-graph.mjs';
import { properHighwayBoundaryIntersection } from './highway-area-crossings.mjs';
import { highwayCycleTurnViolation } from './highway-turns.mjs';
import { solveInterchangeBoundary } from './highway-interchange-solver.mjs';
import { highwayAreaGraphDigest } from './highway-area-cache.mjs';
import { lineTraversesSubdivision } from './government-connections-geometry.mjs';
import {
  buildOsmHighwayCenterlines,
  buildMidpointTopologyGraph,
  finalizeMidpointTopology,
  readOsmMotorwayPbf,
} from './osm-highway-network.mjs';
import {
  multiPolygonAreaSquareMeters,
  pointInRing,
  readPolygonRings,
  roundCoordinate,
} from './natural-earth-land.mjs';

const sourcePath = resolve(
  process.argv[2] ?? 'data/.osm-highway-cache/north-america-motorways.osm.pbf',
);
const outputPath = resolve(
  process.argv[3] ?? 'data/north-america-highway-circumference.json',
);
const tilesPath = resolve(process.argv[4] ?? 'data/north-america-highways.pmtiles');
const landmassSourcePath = resolve(process.argv[5] ?? '/tmp/ne-land/ne_10m_land.shp');
const tileInputPath = resolve('data/.osm-highway-cache/north-america-highways.ndjson');
const derivedCachePath = resolve(
  'data/.osm-highway-cache/north-america-derived-network.bin',
);
const previewUnrestricted = process.env['HIGHWAY_UNRESTRICTED_PREVIEW'] === '1';
if (
  previewUnrestricted &&
  (!process.argv[3] ||
    !process.argv[4] ||
    outputPath === resolve('data/north-america-highway-circumference.json') ||
    tilesPath === resolve('data/north-america-highways.pmtiles'))
)
  throw new Error(
    'Unrestricted previews require separate local output and tile paths.',
  );
function boundarySegments(detailedSegments, graphParts) {
  return detailedSegments.map((segment, index) => {
    const role = [...segment.partIndices].some(
      (partIndex) => graphParts[partIndex].role === 'connector',
    )
      ? 'connector'
      : 'mainline';
    return {
      coordinates: segment.coordinates,
      id: `${role}-boundary-${index + 1}`,
      role,
    };
  });
}

function tileProperties(part) {
  const routeTokens = (part.tokens ?? []).filter((token) => !token.startsWith('NAME:'));
  return {
    class:
      part.role === 'connector'
        ? 'Paired reciprocal freeway connector'
        : 'Separated controlled-access mainline',
    country: '',
    divided: part.role === 'connector' ? 'Averaged directional pair' : 'Divided',
    id: part.id,
    name: routeTokens.join(' / '),
    number: routeTokens.join(' / '),
    role: part.role,
    state: '',
    type: part.role === 'connector' ? 'Connector' : 'Motorway',
  };
}

async function writeTileInput(parts) {
  const output = createWriteStream(tileInputPath, { encoding: 'utf8' });
  for (const part of parts) {
    const feature = {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: part.coordinates.map((coordinate) => roundCoordinate(coordinate)),
      },
      properties: tileProperties(part),
      tippecanoe: {
        minzoom: part.role === 'connector' ? 8 : 2,
      },
    };
    if (!output.write(`${JSON.stringify(feature)}\n`)) {
      await once(output, 'drain');
    }
  }
  output.end();
  await once(output, 'finish');
}

async function buildTiles(parts) {
  await writeTileInput(parts);
  const child = spawn(
    'tippecanoe',
    [
      '--force',
      `--output=${tilesPath}`,
      '--layer=highways',
      '--minimum-zoom=2',
      '--maximum-zoom=14',
      '--drop-densest-as-needed',
      '--simplify-only-low-zooms',
      '--no-tile-stats',
      '--name=North America controlled-access highways',
      '--description=Averaged divided motorway mainlines and paired reciprocal motorway-link connectors',
      '--attribution=© OpenStreetMap contributors',
      tileInputPath,
    ],
    { stdio: 'inherit' },
  );
  const [exitCode] = await once(child, 'exit');
  if (exitCode !== 0) {
    throw new Error(`tippecanoe exited with code ${exitCode}.`);
  }
}

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
  geometryFingerprint.update(await readFile(new URL(name, import.meta.url)));
const midpointFingerprint = geometryFingerprint.digest('hex');
let derived;
try {
  derived = deserialize(await readFile(derivedCachePath));
  if (
    derived.displayTopologyVersion !== 50 ||
    (!previewUnrestricted && derived.midpointFingerprint !== midpointFingerprint) ||
    !derived.detailed?.parts
  ) {
    throw new Error('The cached topology predates source-directed ramp junctions.');
  }
  console.log(`Reused ${derivedCachePath}.`);
} catch {
  if (previewUnrestricted)
    throw new Error(
      'Local preview requires the existing derived network cache; no rebuild was started.',
    );
  console.time('Read detailed OpenStreetMap motorway topology');
  let osm = await readOsmMotorwayPbf(sourcePath);
  console.timeEnd('Read detailed OpenStreetMap motorway topology');
  console.log({
    sourceNodes: osm.nodes.size,
    sourceWays: osm.ways.length,
  });

  console.time('Average carriageways and build explicit ramp connections');
  let built = buildOsmHighwayCenterlines(osm, (progress) => console.log(progress));
  const detailed = {
    parts: built.parts,
    statistics: built.statistics,
    terminalContinuationAudit: built.terminalContinuationAudit,
    rampAttachmentRepairs: built.rampAttachmentRepairs,
    coveredMainlineMerges: built.coveredMainlineMerges,
  };
  console.timeEnd('Average carriageways and build explicit ramp connections');
  console.log(detailed.statistics);
  derived = {
    detailed,
    displayTopologyVersion: 50,
    midpointFingerprint,
  };
  await writeFile(derivedCachePath, serialize(derived));

  console.time('Build exact-identity highway graph');
  let exactGraph = buildMidpointTopologyGraph(finalizeMidpointTopology(detailed.parts));
  let core = highwayTwoCore(
    new Set(exactGraph.coordinateByNodeId.keys()),
    exactGraph.edges,
  );
  const compressed = compressHighwayCore(
    exactGraph.coordinateByNodeId,
    exactGraph.edges,
    core,
    { parts: exactGraph.parts },
  );
  const graphStatistics = {
    ...exactGraph.statistics,
    compressedEdges: compressed.edges.length,
    compressedNodes: compressed.nodes.length,
    coreEdges: core.activeEdges.size,
    coreNodes: core.activeNodes.size,
    exactEdges: exactGraph.edges.length,
    exactNodes: exactGraph.coordinateByNodeId.size,
  };
  console.timeEnd('Build exact-identity highway graph');
  console.log(graphStatistics);
  derived = {
    compressed,
    detailed,
    displayTopologyVersion: 50,
    midpointFingerprint,
    graphStatistics,
    sourceCompressed: compressed,
    sourceGraphParts: exactGraph.parts.map(
      ({ id, role, tokens, explicitMainlineMerge }) => ({
        id,
        role,
        tokens,
        explicitMainlineMerge: Boolean(explicitMainlineMerge),
      }),
    ),
    sourceGraphStatistics: graphStatistics,
    sourceTopologyVersion: 52,
  };
  await writeFile(derivedCachePath, serialize(derived));
}
globalThis.gc?.();
const { detailed } = derived;
// Zero is an explicit unusable port on a collapsed parent; it forbids all turns.
for (const part of detailed.parts) {
  if (
    part.role === 'connector' &&
    (![-1, 0, 1].includes(part.startMainlineDirection) ||
      ![-1, 0, 1].includes(part.endMainlineDirection))
  ) {
    throw new Error(`Paired ramp ${part.id} is missing source carriageway directions.`);
  }
}
if (derived.sourceTopologyVersion !== 52) {
  console.time('Build explicit paired-centerline route graph');
  const sourceGraph = buildMidpointTopologyGraph(
    finalizeMidpointTopology(detailed.parts),
  );
  const sourceCore = highwayTwoCore(
    new Set(sourceGraph.coordinateByNodeId.keys()),
    sourceGraph.edges,
  );
  derived.sourceCompressed = compressHighwayCore(
    sourceGraph.coordinateByNodeId,
    sourceGraph.edges,
    sourceCore,
    { parts: sourceGraph.parts },
  );
  derived.sourceGraphParts = sourceGraph.parts.map(
    ({ id, role, tokens, explicitMainlineMerge }) => ({
      id,
      role,
      tokens,
      explicitMainlineMerge: Boolean(explicitMainlineMerge),
    }),
  );
  derived.sourceGraphStatistics = {
    ...sourceGraph.statistics,
    compressedEdges: derived.sourceCompressed.edges.length,
    compressedNodes: derived.sourceCompressed.nodes.length,
    coreEdges: sourceCore.activeEdges.size,
    coreNodes: sourceCore.activeNodes.size,
    exactEdges: sourceGraph.edges.length,
    exactNodes: sourceGraph.coordinateByNodeId.size,
  };
  derived.sourceTopologyVersion = 52;
  console.timeEnd('Build explicit paired-centerline route graph');
  console.log(derived.sourceGraphStatistics);
  await writeFile(derivedCachePath, serialize(derived));
}
// The graph rejects recoveries without a legal continuing leg at either port.
// Refresh display counts after that final topology check.
detailed.statistics.averagedPartCount = detailed.parts.filter(
  (part) => part.role === 'mainline',
).length;
detailed.statistics.directConnectorCount = detailed.parts.filter(
  (part) => part.role === 'connector',
).length;
detailed.statistics.terminalContinuationCount = detailed.parts.filter(
  (part) => part.explicitMainlineMerge,
).length;
const { sourceCompressed, sourceGraphParts, sourceGraphStatistics } = derived;
// Older source caches omitted the merge role; recover only that metadata from
// the same cached geometry without changing nodes, edges, or source identity.
const partsById = new Map(detailed.parts.map((part) => [part.id, part]));
for (const part of sourceGraphParts)
  part.explicitMainlineMerge ??= Boolean(partsById.get(part.id)?.explicitMainlineMerge);
// Every eligible edge uses its existing geometry, independent of road role.
const routeGraphEdges = sourceCompressed.edges;
if (process.env['HIGHWAY_GRAPH_ONLY'] === '1') {
  console.log(
    'Highway graph cached; stopping before area optimization and publication.',
  );
  process.exit(0);
}
const previewTemplate = previewUnrestricted
  ? JSON.parse(await readFile('data/north-america-highway-circumference.json', 'utf8'))
  : null;
const landmassBuffer = previewUnrestricted ? null : await readFile(landmassSourcePath);
const solverFingerprint = createHash('sha256');
solverFingerprint.update(highwayAreaGraphDigest(sourceCompressed));
solverFingerprint.update(highwayAreaGraphDigest(sourceGraphParts));
for (const file of [
  'highway-interchange-graph.mjs',
  'highway-interchange-solver.mjs',
  'highway-paired-boundary-search.mjs',
  'highway-boundary-pairings.mjs',
  'highway-boundary-regions.mjs',
  'highway-boundary-search.mjs',
  'highway-geodesic-splits.mjs',
  'highway-area-crossings.mjs',
  'highway-area-cache.mjs',
  'highway-cycle.mjs',
  'highway-turns.mjs',
  'wgs84-geodesy.mjs',
]) {
  solverFingerprint.update(await readFile(new URL(file, import.meta.url)));
}
const areaSolverFingerprint = solverFingerprint.digest('hex');
console.time('Maximize highway cycle area');
const exact =
  !previewUnrestricted && derived.areaSolverFingerprint === areaSolverFingerprint
    ? derived.areaCycle
    : solveInterchangeBoundary(sourceCompressed, sourceGraphParts, {
        onTiming: console.log,
        maxPhaseMilliseconds: 30000,
        previewUnrestricted,
        checkpointPath: resolve(
          'data/.osm-highway-cache/interchange-solver',
          areaSolverFingerprint,
          'search.bin',
        ),
      });
if (!previewUnrestricted && exact.optimizationStatus !== 'optimal')
  throw new Error('The area solve did not prove optimality.');
if (!previewUnrestricted) {
  derived.areaSolverFingerprint = areaSolverFingerprint;
  derived.areaCycle = exact;
  await writeFile(derivedCachePath, serialize(derived));
}
console.timeEnd('Maximize highway cycle area');
const forbiddenTurn = highwayCycleTurnViolation(exact.segments, routeGraphEdges);
if (forbiddenTurn && !previewUnrestricted) {
  throw new Error(
    `The highway boundary contains an illegal ramp turn at segments ${forbiddenTurn.join(', ')}.`,
  );
}
// Preserve the validated centerline precision. A second rounding pass can
// turn closely spaced source vertices into a crossing in the exported ring.
const routeCoordinates = exact.coordinates;
if (!previewUnrestricted && properHighwayBoundaryIntersection(routeCoordinates)) {
  throw new Error('The exported highway boundary must remain a simple cycle.');
}
const subdivisions = JSON.parse(
  await readFile('data/north-america-subdivisions.geojson', 'utf8'),
);
const { seats } = JSON.parse(
  await readFile('data/north-america-government-seats.json', 'utf8'),
);
const countries = [...new Set(seats.map((seat) => seat.country))].filter((country) =>
  seats
    .filter((seat) => seat.country === country)
    .some((seat) =>
      lineTraversesSubdivision(
        routeCoordinates,
        subdivisions.features.find((feature) => feature.properties.id === seat.id)
          .geometry,
      ),
    ),
);
console.time('Subdivision and landmass coverage');
const americanMainlandRing = previewUnrestricted
  ? previewTemplate.landmass.mask[0][0]
  : readPolygonRings(landmassBuffer).find((ring) =>
      pointInRing([-99.1332, 19.4326], ring),
    );
if (!americanMainlandRing) {
  throw new Error('Natural Earth land data does not contain the American mainland.');
}
const northAmericanMainlandMask = previewUnrestricted
  ? previewTemplate.landmass.mask
  : polygonClipping
      .intersection(
        [[americanMainlandRing]],
        [
          [
            [
              [-180, 7],
              [-20, 7],
              [-20, 90],
              [-180, 90],
              [-180, 7],
            ],
          ],
        ],
      )
      .map((polygon) =>
        polygon.map((ring) => ring.map((coordinate) => roundCoordinate(coordinate))),
      );
const northAmericanMainlandAreaSquareMeters = multiPolygonAreaSquareMeters(
  northAmericanMainlandMask,
);
const [landmassCoverage] = calculateLandmassCoverage(
  routeCoordinates,
  {
    area_m2: northAmericanMainlandAreaSquareMeters,
    gradient_bounds: [-130, 15, -52, 65],
    label: 'North American mainland',
    landmasses: [
      {
        area_m2: northAmericanMainlandAreaSquareMeters,
        id: 'north-american-mainland',
        label: 'North American mainland',
        mask: northAmericanMainlandMask,
      },
    ],
    mask: northAmericanMainlandMask,
  },
  polygonClipping,
);
if (!landmassCoverage) {
  throw new Error(
    'The detailed highway boundary does not intersect North American land.',
  );
}
console.timeEnd('Subdivision and landmass coverage');

const routeSegments = boundarySegments(exact.segments, sourceGraphParts);
const boundaryPartIndices = new Set(
  exact.segments.flatMap((segment) => [...segment.partIndices]),
);

if (previewUnrestricted || process.env['HIGHWAY_REUSE_EXISTING_TILES'] === '1') {
  console.log(`Reused existing ${tilesPath}.`);
} else {
  console.time('Build detailed motorway vector tiles');
  await buildTiles(detailed.parts);
  console.timeEnd('Build detailed motorway vector tiles');
}

const output = {
  ...(previewUnrestricted
    ? {
        preview: {
          mode: 'unrestricted',
          usesCachedNetwork: true,
          skippedSteps: [
            'legal-route-search',
            'optimality-proof',
            'legal-turn-publication-check',
            'simple-ring-publication-check',
          ],
          junctionCount: exact.diagnostics.junctions.length,
          interchangeConflicts: exact.diagnostics.junctions.filter(
            (p) => p.kind === 'interchange-movement',
          ).length,
          geometricContacts: exact.diagnostics.junctions.filter(
            (p) => p.kind === 'geometric-contact',
          ).length,
          repeatedBoundaryVertices: exact.diagnostics.repeatedVertices,
        },
      }
    : {}),
  centerline_method:
    'Shared ordered source correspondence with a 200 m pairing taper; WGS84 midpoints for mainlines and reciprocal ramps, continued along source mainlines through staggered joins',
  criterion:
    'Separated controlled-access mainlines (2+ lanes per direction where lane counts are explicit) with paired reciprocal motorway-link connectors',
  landmass: {
    area_m2: northAmericanMainlandAreaSquareMeters,
    id: 'north-american-mainland',
    label: 'North American mainland',
    mask: northAmericanMainlandMask,
  },
  landmass_source: 'Natural Earth 1:10m land polygons',
  landmass_source_url:
    'https://www.naturalearthdata.com/downloads/10m-physical-vectors/10m-land/',
  landmass_source_version: '5.1.1',
  methodology: {
    alternativeRampPathCount: detailed.statistics.alternativeConnectorPathCount,
    biconnectedBlockCount: exact.biconnectedBlockCount,
    compressedEdgeCount: sourceGraphStatistics.compressedEdges,
    compressedNodeCount: sourceGraphStatistics.compressedNodes,
    crossBorderSeamConnectorCount: 0,
    endpointSnapCount: 0,
    faceCount: 1,
    giantNetworkEdgeCount: sourceGraphStatistics.exactEdges,
    giantNetworkNodeCount: sourceGraphStatistics.exactNodes,
    interchangeConnectorCount: detailed.statistics.directConnectorCount,
    terminalConnectorCount: detailed.parts.filter(
      (part) => part.explicitMainlineMerge && part.role === 'connector',
    ).length,
    directionalRampPathCount: detailed.statistics.directedConnectorPathCount,
    osmPrecisionMainlineCount: detailed.statistics.averagedPartCount,
    optimizationMethod: 'interchange-ports-outer-boundary',
    optimizationStatus: exact.optimizationStatus,
    ...(exact.objectiveUpperBoundSquareMeters === null
      ? {}
      : { objectiveUpperBoundSquareMeters: exact.objectiveUpperBoundSquareMeters }),
    optimizationIterations: exact.optimizationIterations,
    sourceFeatureCount: detailed.parts.length,
    unpairedRampPathCount: detailed.statistics.unpairedConnectorPathCount,
  },
  network: {
    featureCount: detailed.parts.length,
    sourceLayer: 'highways',
    tileUrl: 'data/north-america-highways.pmtiles',
  },
  precision_source: 'OpenStreetMap',
  precision_source_license: 'OpenStreetMap contributors, ODbL 1.0',
  precision_source_url: 'https://www.openstreetmap.org/copyright',
  route: {
    areaSquareMeters: exact.areaSquareMeters,
    boundaryCorridorCount: exact.segments.length,
    boundaryRoadFeatureCount: boundaryPartIndices.size,
    containedLandAreaSquareMeters: landmassCoverage.insideAreaSquareMeters,
    coordinates: routeCoordinates,
    countries,
    id: 'north-america-controlled-access-maximum',
    lengthMeters: geodesicLineLengthMeters(routeCoordinates),
    outsideLandAreaSquareMeters: landmassCoverage.outsideAreaSquareMeters,
    segments: routeSegments,
  },
  source: 'OpenStreetMap paired-direction motorway topology',
  source_url: 'https://download.geofabrik.de/north-america.html',
  source_version: '2026-07-30',
};
await writeFile(outputPath, `${JSON.stringify(output)}\n`);
if (previewUnrestricted) {
  await writeFile(
    resolve(dirname(outputPath), 'highway-preview-junctions.geojson'),
    JSON.stringify({
      type: 'FeatureCollection',
      features: exact.diagnostics.junctions.map(({ coordinate, ...properties }) => ({
        type: 'Feature',
        id: properties.number,
        properties,
        geometry: { type: 'Point', coordinates: coordinate },
      })),
    }),
  );
}
console.time('Build normal highway display assets');
await buildHighwayDisplayAssets(
  outputPath,
  tilesPath.replace(/\.pmtiles$/, '-route.pmtiles'),
);
console.timeEnd('Build normal highway display assets');
console.log({
  outputPath,
  routeAreaSquareKilometers: output.route.areaSquareMeters / 1_000_000,
  routeLengthKilometers: output.route.lengthMeters / 1_000,
  tilesPath,
});
