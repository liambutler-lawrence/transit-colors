import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deserialize } from 'node:v8';
import polygonClipping from 'polygon-clipping';
import { calculateLandmassCoverage } from '../src/circumference-landmass.ts';
import {
  circumferenceGradientBounds,
  circumferenceGradientDistanceForArea,
} from '../src/circumference-map.ts';
import { highwayBounds, highwayLandmassArea } from '../src/highway-circumference.ts';
import { solveHighwayGradeCircles } from './highway-grade-circles.mjs';
import { nativeHighwayAreaSolver } from './highway-area-native.mjs';

const data = 'data/north-america';
const network = deserialize(
  await readFile('data/.osm-highway-cache/north-america-graded-network.bin'),
);
const published = JSON.parse(
  await readFile(`${data}-highway-circumference.json`, 'utf8'),
);
if (network.sourceVersion !== published.source_version) {
  throw new Error(
    'The highway grades must use the same source snapshot as the road map.',
  );
}
const python = process.env.HIGHWAY_HIGHS_PYTHON;
const { circles, selections } = await solveHighwayGradeCircles(network, {
  onSolve: console.info,
  onIteration: console.info,
  solveModel: python ? nativeHighwayAreaSolver(python) : null,
  timeLimitSeconds: 1800,
});

const landmass = highwayLandmassArea(published);
const coverage = {};
for (const { review } of network.edges) {
  if (review.junction) continue;
  const key = review.grade ?? 'pending';
  coverage[key] = (coverage[key] ?? 0) + 1;
}
const summary = {
  sourceVersion: network.sourceVersion,
  coverage,
  bounds: highwayBounds(published.route.coordinates),
  landmassLabel: landmass.label,
  segmentCount: Object.values(coverage).reduce((sum, count) => sum + count, 0),
  selections,
  circles: Object.fromEntries(
    circles.map((circle) => {
      const [contained] = calculateLandmassCoverage(
        circle.coordinates,
        landmass,
        polygonClipping,
      );
      return [
        circle.id,
        {
          id: circle.id,
          areaSquareMeters: circle.areaSquareMeters,
          boundaryCorridorCount: circle.edgeIds.length,
          bounds: highwayBounds(circle.coordinates),
          containedLandAreaSquareMeters: contained?.insideAreaSquareMeters ?? 0,
          gradientBounds: circumferenceGradientBounds(
            circle.coordinates,
            circumferenceGradientDistanceForArea(circle.areaSquareMeters),
          ),
          grades: circle.grades,
          lengthMeters: circle.lengthMeters,
          outsideLandAreaSquareMeters:
            contained?.outsideAreaSquareMeters ?? landmass.area_m2,
        },
      ];
    }),
  ),
};
const circleIdsByEdge = new Map();
for (const { edgeIds, id } of circles) {
  for (const edgeId of edgeIds) {
    const ids = circleIdsByEdge.get(edgeId) ?? [];
    ids.push(id);
    circleIdsByEdge.set(edgeId, ids);
  }
}

async function writeFeatures(path, features) {
  const output = createWriteStream(path, { encoding: 'utf8' });
  for (const feature of features) {
    if (!output.write(`${JSON.stringify(feature)}\n`)) await once(output, 'drain');
  }
  output.end();
  await once(output, 'finish');
}

function* segmentFeatures() {
  for (const edge of network.edges) {
    if (edge.review.junction) continue;
    const membership = circleIdsByEdge.get(edge.id);
    const connector = edge.role === 'connector';
    yield {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: edge.coordinates },
      properties: {
        id: `road-segment-${edge.id}`,
        segment_id: edge.id,
        class: connector ? 'Paired interchange connector' : 'Motorway mainline',
        country: '',
        divided: '',
        name: edge.name,
        number: '',
        role: edge.role,
        state: '',
        type: connector ? 'Connector' : 'Motorway',
        grade: edge.review.grade,
        review_issue: edge.review.reason,
        osm_ways: edge.review.wayIds?.join(','),
        circles: membership ? `|${membership.join('|')}|` : '',
      },
      tippecanoe: { minzoom: connector && !membership ? 8 : 2 },
    };
  }
}

function* circleFeatures() {
  for (const { id, coordinates } of circles) {
    yield {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [coordinates] },
      properties: { id },
    };
  }
}

const temporary = await mkdtemp(join(tmpdir(), 'graded-road-tiles-'));
try {
  const lines = join(temporary, 'segments.ndjson');
  const polygons = join(temporary, 'circles.ndjson');
  await Promise.all([
    writeFeatures(lines, segmentFeatures()),
    writeFeatures(polygons, circleFeatures()),
  ]);
  const tiles = spawn(
    'tippecanoe',
    [
      '--force',
      `--output=${data}-graded-roads.pmtiles`,
      `-Lroads:${lines}`,
      ...(circles.length ? [`-Lcircles:${polygons}`] : []),
      '--minimum-zoom=2',
      '--maximum-zoom=12',
      '--no-feature-limit',
      '--no-tile-size-limit',
      '--no-tile-stats',
      '--simplify-only-low-zooms',
      '--attribution=© OpenStreetMap contributors',
      '--quiet',
    ],
    { stdio: 'inherit' },
  );
  const [code] = await once(tiles, 'exit');
  if (code !== 0) throw new Error(`Road tile build failed with exit code ${code}.`);
  await writeFile(`${data}-road-circles.json`, `${JSON.stringify(summary)}\n`);
  const geometry = {
    mask: landmass.mask,
    circles: Object.fromEntries(
      circles.map(({ id, coordinates, areaSquareMeters }) => [
        id,
        { coordinates, areaSquareMeters },
      ]),
    ),
  };
  await writeFile(
    `${data}-road-circles-geometry.json`,
    `${JSON.stringify(geometry)}\n`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
console.info({ coverage, circles: circles.length });
