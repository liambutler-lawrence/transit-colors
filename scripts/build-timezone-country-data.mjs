import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const SOURCE_COMMIT = 'ca96624a56bd078437bca8184e78163e5039ad19';
const SOURCE_URL = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${SOURCE_COMMIT}/geojson/ne_50m_admin_0_countries.geojson`;
const SOURCE_SHA256 =
  '3e458fc036ad0a66411f2c1e6cac49c5d7bfb81cb1123bc513b22511a2b7fdeb';
const SIMPLIFICATION_TOLERANCE = 0.012;

function squaredSegmentDistance(point, start, end) {
  let x = start[0];
  let y = start[1];
  let dx = end[0] - x;
  let dy = end[1] - y;
  if (dx !== 0 || dy !== 0) {
    const ratio = ((point[0] - x) * dx + (point[1] - y) * dy) / (dx * dx + dy * dy);
    if (ratio > 1) {
      x = end[0];
      y = end[1];
    } else if (ratio > 0) {
      x += dx * ratio;
      y += dy * ratio;
    }
    dx = point[0] - x;
    dy = point[1] - y;
  } else {
    dx = point[0] - x;
    dy = point[1] - y;
  }
  return dx * dx + dy * dy;
}

function simplifyOpenLine(points, squaredTolerance) {
  if (points.length <= 2) return points;
  const retained = new Uint8Array(points.length);
  retained[0] = 1;
  retained[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop();
    let furthestIndex = 0;
    let furthestDistance = squaredTolerance;
    for (let index = first + 1; index < last; index += 1) {
      const distance = squaredSegmentDistance(
        points[index],
        points[first],
        points[last],
      );
      if (distance > furthestDistance) {
        furthestDistance = distance;
        furthestIndex = index;
      }
    }
    if (furthestIndex > 0) {
      retained[furthestIndex] = 1;
      stack.push([first, furthestIndex], [furthestIndex, last]);
    }
  }
  return points.filter((_, index) => retained[index] === 1);
}

function squaredDistance(left, right) {
  const longitude = left[0] - right[0];
  const latitude = left[1] - right[1];
  return longitude * longitude + latitude * latitude;
}

function simplifyRing(ring) {
  const points = ring.slice(0, -1);
  if (points.length <= 4) return ring;
  let splitIndex = 1;
  let splitDistance = 0;
  for (let index = 1; index < points.length; index += 1) {
    const distance = squaredDistance(points[0], points[index]);
    if (distance > splitDistance) {
      splitDistance = distance;
      splitIndex = index;
    }
  }
  const closedPoints = [...points, points[0]];
  const squaredTolerance = SIMPLIFICATION_TOLERANCE ** 2;
  const firstHalf = simplifyOpenLine(
    closedPoints.slice(0, splitIndex + 1),
    squaredTolerance,
  );
  const secondHalf = simplifyOpenLine(closedPoints.slice(splitIndex), squaredTolerance);
  const simplified = [...firstHalf.slice(0, -1), ...secondHalf];
  return simplified.length >= 4 ? simplified : ring;
}

function roundCoordinate(value) {
  return Number(value.toFixed(5));
}

function normalizeMultiPolygon(feature) {
  const polygons =
    feature.geometry.type === 'Polygon'
      ? [feature.geometry.coordinates]
      : feature.geometry.coordinates;
  return polygons
    .map((polygon) =>
      polygon
        .map(simplifyRing)
        .filter((ring) => ring.length >= 4)
        .map((ring) =>
          ring.map(([longitude, latitude]) => [
            roundCoordinate(longitude),
            roundCoordinate(latitude),
          ]),
        ),
    )
    .filter((polygon) => polygon.length > 0);
}

async function sourceData(sourcePath) {
  if (sourcePath) return readFile(resolve(sourcePath));
  const response = await fetch(SOURCE_URL);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${SOURCE_URL}: ${response.status} ${response.statusText}`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  const outputPath = resolve(process.argv[2] ?? 'data/timezone-skew-countries.geojson');
  const source = await sourceData(process.argv[3]);
  const checksum = createHash('sha256').update(source).digest('hex');
  if (checksum !== SOURCE_SHA256) {
    throw new Error(`Natural Earth country checksum mismatch: ${checksum}`);
  }
  const input = JSON.parse(source.toString('utf8'));
  const features = input.features
    .map((feature) => ({
      name: feature.properties.NAME_EN,
      isoA2: feature.properties.ISO_A2_EH,
      isoA3: feature.properties.ISO_A3_EH,
      coordinates: normalizeMultiPolygon(feature),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((country, id) => ({
      type: 'Feature',
      id,
      properties: {
        id,
        name: country.name,
        iso_a2: country.isoA2,
        iso_a3: country.isoA3,
      },
      geometry: {
        type: 'MultiPolygon',
        coordinates: country.coordinates,
      },
    }));
  const output = {
    type: 'FeatureCollection',
    metadata: {
      license: 'Public domain',
      source_commit: SOURCE_COMMIT,
      source_name: 'Natural Earth 1:50m Admin 0 countries',
      source_sha256: SOURCE_SHA256,
      source_url: SOURCE_URL,
    },
    features,
  };
  await writeFile(outputPath, `${JSON.stringify(output)}\n`, 'utf8');
  console.log(`Wrote ${features.length} country features to ${outputPath}`);
}

await main();
