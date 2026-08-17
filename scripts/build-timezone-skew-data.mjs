import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync, inflateRawSync } from 'node:zlib';

import polygonClipping from 'polygon-clipping';

import { buildTimezoneRule, parseTzif } from './tzif.mjs';

const execFile = promisify(execFileCallback);
const TIMEZONE_RELEASE = '2026c';
const TIMEZONE_SOURCE = `https://github.com/evansiroky/timezone-boundary-builder/releases/download/${TIMEZONE_RELEASE}/timezones-1970.geojson.zip`;
const TIMEZONE_SOURCE_SHA256 =
  'c1bd0839c15a94ace5107e84694915fca3ab74907dee7b2ed4e3e5e01acc8f16';
const IANA_SOURCE = `https://data.iana.org/time-zones/releases/tzdata${TIMEZONE_RELEASE}.tar.gz`;
const IANA_SOURCE_SHA256 =
  'e4a178a4477f3d0ea77cc31828ff72aa38feff8d61aa13e7e99e142e9d902be4';
const LAND_SOURCE_COMMIT = 'ca96624a56bd078437bca8184e78163e5039ad19';
const LAND_SOURCE =
  `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/` +
  `${LAND_SOURCE_COMMIT}/geojson/ne_10m_land.geojson`;
const LAND_SOURCE_SHA256 =
  '1ac90796408bc6ad6911d69448485d3c4dbf2190370080368a09976e1c9f7416';
const ZIP_ENTRY = 'combined-1970.json';
const TZDATA_FILES = [
  'africa',
  'antarctica',
  'asia',
  'australasia',
  'europe',
  'northamerica',
  'southamerica',
  'etcetera',
  'backward',
];
const SIMPLIFICATION_TOLERANCE = 0.018;
const RULES_START_SECONDS = Date.UTC(1970, 0, 1) / 1_000;
// Fat TZif files retain explicit recurring transitions through the 32-bit
// compatibility horizon. Keep the advertised rule window inside that range.
const RULES_END_SECONDS = Date.UTC(2038, 0, 1) / 1_000;
const BASELINE_SECONDS = Date.UTC(2026, 7, 16) / 1_000;

function squaredDistance(left, right) {
  const longitude = left[0] - right[0];
  const latitude = left[1] - right[1];
  return longitude * longitude + latitude * latitude;
}

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

function simplifyMultiPolygon(polygons) {
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

function simplifyGeometry(geometry) {
  const polygons =
    geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return simplifyMultiPolygon(polygons);
}

function polygonBounds(polygon) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const ring of polygon) {
    for (const [longitude, latitude] of ring) {
      bounds[0] = Math.min(bounds[0], longitude);
      bounds[1] = Math.min(bounds[1], latitude);
      bounds[2] = Math.max(bounds[2], longitude);
      bounds[3] = Math.max(bounds[3], latitude);
    }
  }
  return bounds;
}

function boundsIntersect(left, right) {
  return !(
    left[2] < right[0] ||
    left[0] > right[2] ||
    left[3] < right[1] ||
    left[1] > right[3]
  );
}

function buildLandIndex(landData) {
  return landData.features.flatMap(({ geometry }) =>
    simplifyGeometry(geometry).map((polygon) => ({
      bounds: polygonBounds(polygon),
      polygon,
    })),
  );
}

function clipGeometryToLand(geometry, landIndex) {
  const clippedPolygons = [];
  for (const timezonePolygon of simplifyGeometry(geometry)) {
    const timezoneBounds = polygonBounds(timezonePolygon);
    const nearbyLand = landIndex
      .filter(({ bounds }) => boundsIntersect(timezoneBounds, bounds))
      .map(({ polygon }) => polygon);
    if (nearbyLand.length === 0) continue;
    clippedPolygons.push(
      ...polygonClipping.intersection([timezonePolygon], nearbyLand),
    );
  }
  return simplifyMultiPolygon(clippedPolygons);
}

function offsetAtSeconds(rule, epochSeconds) {
  let offsetSeconds = rule.initialOffsetSeconds;
  for (const [transitionSeconds, nextOffsetSeconds] of rule.transitions) {
    if (transitionSeconds > epochSeconds) break;
    offsetSeconds = nextOffsetSeconds;
  }
  return offsetSeconds;
}

function offsetLabel(offsetSeconds) {
  const sign = offsetSeconds < 0 ? '-' : '+';
  const absoluteSeconds = Math.abs(offsetSeconds);
  const hours = Math.floor(absoluteSeconds / 3_600);
  const minutes = Math.floor((absoluteSeconds % 3_600) / 60);
  const seconds = absoluteSeconds % 60;
  const secondText = seconds === 0 ? '' : `:${String(seconds).padStart(2, '0')}`;
  return `UTC${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}${secondText}`;
}

function placeLabel(timezone) {
  return timezone.split('/').at(-1).replaceAll('_', ' ');
}

function extractZipEntry(zipBuffer, entryName) {
  const endSignature = 0x06054b50;
  let endOffset = zipBuffer.length - 22;
  while (endOffset >= 0 && zipBuffer.readUInt32LE(endOffset) !== endSignature) {
    endOffset -= 1;
  }
  if (endOffset < 0) throw new Error('Could not find ZIP central directory');
  const entryCount = zipBuffer.readUInt16LE(endOffset + 10);
  let directoryOffset = zipBuffer.readUInt32LE(endOffset + 16);

  for (let index = 0; index < entryCount; index += 1) {
    if (zipBuffer.readUInt32LE(directoryOffset) !== 0x02014b50) {
      throw new Error('Invalid ZIP central directory entry');
    }
    const compression = zipBuffer.readUInt16LE(directoryOffset + 10);
    const compressedSize = zipBuffer.readUInt32LE(directoryOffset + 20);
    const nameLength = zipBuffer.readUInt16LE(directoryOffset + 28);
    const extraLength = zipBuffer.readUInt16LE(directoryOffset + 30);
    const commentLength = zipBuffer.readUInt16LE(directoryOffset + 32);
    const localOffset = zipBuffer.readUInt32LE(directoryOffset + 42);
    const name = zipBuffer
      .subarray(directoryOffset + 46, directoryOffset + 46 + nameLength)
      .toString('utf8');
    if (name === entryName) {
      if (zipBuffer.readUInt32LE(localOffset) !== 0x04034b50) {
        throw new Error(`Invalid ZIP local header for ${entryName}`);
      }
      const localNameLength = zipBuffer.readUInt16LE(localOffset + 26);
      const localExtraLength = zipBuffer.readUInt16LE(localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = zipBuffer.subarray(dataOffset, dataOffset + compressedSize);
      if (compression === 0) return compressed;
      if (compression === 8) return inflateRawSync(compressed);
      throw new Error(`Unsupported ZIP compression method ${compression}`);
    }
    directoryOffset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`ZIP entry not found: ${entryName}`);
}

function extractTarFiles(archive, requestedNames) {
  const tarBuffer = gunzipSync(archive);
  const requested = new Set(requestedNames);
  const files = new Map();
  for (let offset = 0; offset + 512 <= tarBuffer.length;) {
    const name = tarBuffer
      .subarray(offset, offset + 100)
      .toString('utf8')
      .replace(/\0.*$/, '');
    if (!name) break;
    const sizeText = tarBuffer
      .subarray(offset + 124, offset + 136)
      .toString('ascii')
      .replace(/\0.*$/, '')
      .trim();
    const size = Number.parseInt(sizeText || '0', 8);
    const dataOffset = offset + 512;
    if (requested.has(name)) {
      files.set(name, tarBuffer.subarray(dataOffset, dataOffset + size));
    }
    offset = dataOffset + Math.ceil(size / 512) * 512;
  }
  for (const requestedName of requested) {
    if (!files.has(requestedName)) {
      throw new Error(`Missing ${requestedName} in IANA tzdata archive`);
    }
  }
  return files;
}

async function fetchArchive(url, sourcePath) {
  if (sourcePath) return readFile(resolve(sourcePath));
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${url}: ${response.status} ${response.statusText}`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

function verifyChecksum(archive, expected, label) {
  const checksum = createHash('sha256').update(archive).digest('hex');
  if (checksum !== expected) {
    throw new Error(`${label} archive checksum mismatch: ${checksum}`);
  }
}

async function compileTimezoneRules(tzdataArchive, timezones) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'transit-colors-tzdata-'));
  const zoneinfoDirectory = join(temporaryRoot, 'zoneinfo');
  try {
    const sourceFiles = extractTarFiles(tzdataArchive, TZDATA_FILES);
    await Promise.all(
      [...sourceFiles].map(([name, contents]) =>
        writeFile(join(temporaryRoot, name), contents),
      ),
    );
    await mkdir(zoneinfoDirectory);
    try {
      await execFile(
        process.env.ZIC ?? 'zic',
        ['-b', 'fat', '-d', zoneinfoDirectory, ...TZDATA_FILES],
        { cwd: temporaryRoot },
      );
    } catch (error) {
      throw new Error(
        `Could not compile IANA timezone rules. Install zic or set ZIC. ${error}`,
      );
    }

    const entries = await Promise.all(
      timezones.map(async (timezone) => {
        const tzif = await readFile(join(zoneinfoDirectory, timezone));
        return [
          timezone,
          buildTimezoneRule(parseTzif(tzif), RULES_START_SECONDS, RULES_END_SECONDS),
        ];
      }),
    );
    return Object.fromEntries(entries);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function main() {
  const outputPath = resolve(process.argv[2] ?? 'data/timezone-skew-zones.geojson');
  const [timezoneArchive, tzdataArchive, landSource] = await Promise.all([
    fetchArchive(TIMEZONE_SOURCE, process.argv[3]),
    fetchArchive(IANA_SOURCE, process.argv[4]),
    fetchArchive(LAND_SOURCE, process.argv[5]),
  ]);
  verifyChecksum(timezoneArchive, TIMEZONE_SOURCE_SHA256, 'Timezone boundary');
  verifyChecksum(tzdataArchive, IANA_SOURCE_SHA256, 'IANA tzdata');
  verifyChecksum(landSource, LAND_SOURCE_SHA256, 'Natural Earth land');
  const timezoneData = JSON.parse(
    extractZipEntry(timezoneArchive, ZIP_ENTRY).toString('utf8'),
  );
  const landIndex = buildLandIndex(JSON.parse(landSource.toString('utf8')));
  const timezones = timezoneData.features.map(({ properties }) => properties.tzid);
  const timezoneRules = await compileTimezoneRules(tzdataArchive, timezones);

  const features = timezoneData.features.map((timezoneFeature, index) => {
    const timezone = timezoneFeature.properties.tzid;
    const baselineOffsetSeconds = offsetAtSeconds(
      timezoneRules[timezone],
      BASELINE_SECONDS,
    );
    return {
      type: 'Feature',
      id: index,
      properties: {
        id: index,
        offset_hours: baselineOffsetSeconds / 3_600,
        offset_label: offsetLabel(baselineOffsetSeconds),
        places: placeLabel(timezone),
        dst_places: '',
        timezone_name: timezone,
      },
      geometry: {
        type: 'MultiPolygon',
        coordinates: clipGeometryToLand(timezoneFeature.geometry, landIndex),
      },
    };
  });

  const output = {
    type: 'FeatureCollection',
    metadata: {
      baseline_instant: new Date(BASELINE_SECONDS * 1_000).toISOString(),
      iana_release: TIMEZONE_RELEASE,
      iana_source: IANA_SOURCE,
      iana_source_sha256: IANA_SOURCE_SHA256,
      land_source: LAND_SOURCE,
      land_source_commit: LAND_SOURCE_COMMIT,
      land_source_license: 'Public domain',
      land_source_sha256: LAND_SOURCE_SHA256,
      license: 'Open Database License (ODbL); © OpenStreetMap contributors',
      rules_end_epoch_seconds: RULES_END_SECONDS,
      rules_start_epoch_seconds: RULES_START_SECONDS,
      timezone_release: TIMEZONE_RELEASE,
      timezone_rules: timezoneRules,
      timezone_source: TIMEZONE_SOURCE,
      timezone_source_sha256: TIMEZONE_SOURCE_SHA256,
    },
    features,
  };
  await writeFile(outputPath, `${JSON.stringify(output)}\n`, 'utf8');
  console.log(
    `Wrote ${features.length} historical timekeeping-zone features to ${outputPath}`,
  );
}

await main();
