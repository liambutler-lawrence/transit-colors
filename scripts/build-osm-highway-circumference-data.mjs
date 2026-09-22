import { buildHighwayDisplayAssets } from './build-highway-display-assets.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { deserialize, serialize } from 'node:v8';
import { createHash } from 'node:crypto';
import polygonClipping from 'polygon-clipping';

import { calculateLandmassCoverage } from '../src/circumference-landmass.ts';
import { geodesicLineLengthMeters } from '../src/geodesy.ts';
import { compressHighwayCore, highwayTwoCore } from './highway-graph.mjs';
import { properHighwayBoundaryIntersection } from './highway-area-crossings.mjs';
import { highwayCycleTurnViolation } from './highway-turns.mjs';
import { solveHighwayAreaCycle } from './highway-area-cycle.mjs';
import { nativeHighwayAreaSolver } from './highway-area-native.mjs';
import { highwayAreaGraphDigest } from './highway-area-cache.mjs';
import { lineTraversesSubdivision } from './government-connections-geometry.mjs';
import {
  buildOsmHighwayCenterlines,
  buildPairedOsmSourceTopologyGraph,
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

const landmassBuffer = await readFile(landmassSourcePath);

let derived;
try {
  derived = deserialize(await readFile(derivedCachePath));
  if (derived.displayTopologyVersion !== 49) {
    throw new Error('The cached topology predates source-directed ramp junctions.');
  }
  console.log(`Reused ${derivedCachePath}.`);
} catch {
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
    displayTopologyVersion: 49,
  };
  await writeFile(derivedCachePath, serialize(derived));

  console.time('Build exact-identity highway graph');
  let exactGraph = buildPairedOsmSourceTopologyGraph(osm, detailed.parts);
  let core = highwayTwoCore(
    new Set(exactGraph.coordinateByNodeId.keys()),
    exactGraph.edges,
  );
  const compressed = compressHighwayCore(
    exactGraph.coordinateByNodeId,
    exactGraph.edges,
    core,
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
    displayTopologyVersion: 49,
    graphStatistics,
    sourceCompressed: compressed,
    sourceGraphParts: exactGraph.parts.map(({ id, role, tokens }) => ({
      id,
      role,
      tokens,
    })),
    sourceGraphStatistics: graphStatistics,
    sourceTopologyVersion: 48,
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
if (derived.sourceTopologyVersion !== 48) {
  console.time('Read OSM mainline continuity topology');
  const osm = await readOsmMotorwayPbf(sourcePath);
  console.timeEnd('Read OSM mainline continuity topology');
  console.time('Build explicit paired-centerline route graph');
  const sourceGraph = buildPairedOsmSourceTopologyGraph(osm, detailed.parts);
  const sourceCore = highwayTwoCore(
    new Set(sourceGraph.coordinateByNodeId.keys()),
    sourceGraph.edges,
  );
  derived.sourceCompressed = compressHighwayCore(
    sourceGraph.coordinateByNodeId,
    sourceGraph.edges,
    sourceCore,
  );
  derived.sourceGraphParts = sourceGraph.parts.map(({ id, role, tokens }) => ({
    id,
    role,
    tokens,
  }));
  derived.sourceGraphStatistics = {
    ...sourceGraph.statistics,
    compressedEdges: derived.sourceCompressed.edges.length,
    compressedNodes: derived.sourceCompressed.nodes.length,
    coreEdges: sourceCore.activeEdges.size,
    coreNodes: sourceCore.activeNodes.size,
    exactEdges: sourceGraph.edges.length,
    exactNodes: sourceGraph.coordinateByNodeId.size,
  };
  derived.sourceTopologyVersion = 48;
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
// Every eligible edge uses its existing geometry, independent of road role.
const routeGraphEdges = sourceCompressed.edges;
const solverFingerprint = createHash('sha256');
solverFingerprint.update(highwayAreaGraphDigest(sourceCompressed));
for (const file of [
  'highway-area-cycle.mjs',
  'highway-area-crossings.mjs',
  'highway-area-objective.mjs',
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
  derived.areaSolverFingerprint === areaSolverFingerprint
    ? derived.areaCycle
    : await solveHighwayAreaCycle(sourceCompressed.nodes, routeGraphEdges, {
        onIteration: console.log,
        timeLimitSeconds: 1800,
        solveModel: process.env['HIGHWAY_HIGHS_PYTHON']
          ? nativeHighwayAreaSolver(process.env['HIGHWAY_HIGHS_PYTHON'])
          : null,
      });
if (exact.optimizationStatus !== 'optimal')
  throw new Error('The area solve did not prove optimality.');
derived.areaSolverFingerprint = areaSolverFingerprint;
derived.areaCycle = exact;
await writeFile(derivedCachePath, serialize(derived));
console.timeEnd('Maximize highway cycle area');
const forbiddenTurn = highwayCycleTurnViolation(exact.segments, routeGraphEdges);
if (forbiddenTurn) {
  throw new Error(
    `The highway boundary contains an illegal ramp turn at segments ${forbiddenTurn.join(', ')}.`,
  );
}
// Preserve the validated centerline precision. A second rounding pass can
// turn closely spaced source vertices into a crossing in the exported ring.
const routeCoordinates = exact.coordinates;
if (properHighwayBoundaryIntersection(routeCoordinates)) {
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
const americanMainlandRing = readPolygonRings(landmassBuffer).find((ring) =>
  pointInRing([-99.1332, 19.4326], ring),
);
if (!americanMainlandRing) {
  throw new Error('Natural Earth land data does not contain the American mainland.');
}
const northAmericanMainlandMask = polygonClipping
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

const routeSegments = boundarySegments(exact.segments, sourceGraphParts);
const boundaryPartIndices = new Set(
  exact.segments.flatMap((segment) => [...segment.partIndices]),
);

if (process.env['HIGHWAY_REUSE_EXISTING_TILES'] === '1') {
  console.log(`Reused existing ${tilesPath}.`);
} else {
  console.time('Build detailed motorway vector tiles');
  await buildTiles(detailed.parts);
  console.timeEnd('Build detailed motorway vector tiles');
}

const output = {
  centerline_method:
    'Closest-tangent geodesic midpoints of opposing OSM motorway carriageways and reciprocal ramps, continued along source mainlines through staggered joins',
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
    optimizationMethod: 'source-topology-wgs84-area-integer-program',
    optimizationStatus: exact.optimizationStatus,
    objectiveUpperBoundSquareMeters: exact.objectiveUpperBoundSquareMeters,
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
await buildHighwayDisplayAssets(
  outputPath,
  tilesPath.replace(/\.pmtiles$/, '-route.pmtiles'),
);
console.log({
  outputPath,
  routeAreaSquareKilometers: output.route.areaSquareMeters / 1_000_000,
  routeLengthKilometers: output.route.lengthMeters / 1_000,
  tilesPath,
});
