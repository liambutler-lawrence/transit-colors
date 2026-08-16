import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const TIMEZONE_RELEASE = '2026c';
const TIMEZONE_SOURCE = `https://github.com/evansiroky/timezone-boundary-builder/releases/download/${TIMEZONE_RELEASE}/timezones-now.geojson.zip`;
const TIMEZONE_SOURCE_SHA256 =
  'f7181b3690da41d174d3a943d575dd4665df48abd7119f406f243ba2df54dda8';
const ZIP_ENTRY = 'combined-now.json';
const SIMPLIFICATION_TOLERANCE = 0.018;
const BASELINE_INSTANT = Date.UTC(2026, 0, 1);

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

function offsetHours(timezone, epochMs) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'longOffset',
  });
  const offset = formatter
    .formatToParts(new Date(epochMs))
    .find(({ type }) => type === 'timeZoneName')?.value;
  if (offset === 'GMT') return 0;
  const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(offset ?? '');
  if (!match) throw new Error(`Unsupported UTC offset ${offset} for ${timezone}`);
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
  return (match[1] === '-' ? -minutes : minutes) / 60;
}

function offsetLabel(offset) {
  const sign = offset < 0 ? '-' : '+';
  const absoluteMinutes = Math.round(Math.abs(offset) * 60);
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;
  return `UTC${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
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

async function sourceArchive(sourcePath) {
  if (sourcePath) return readFile(resolve(sourcePath));
  const response = await fetch(TIMEZONE_SOURCE);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${TIMEZONE_SOURCE}: ${response.status} ${response.statusText}`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  const outputPath = resolve(process.argv[2] ?? 'data/timezone-skew-zones.geojson');
  const archive = await sourceArchive(process.argv[3]);
  const checksum = createHash('sha256').update(archive).digest('hex');
  if (checksum !== TIMEZONE_SOURCE_SHA256) {
    throw new Error(`Timezone archive checksum mismatch: ${checksum}`);
  }
  const timezoneData = JSON.parse(extractZipEntry(archive, ZIP_ENTRY).toString('utf8'));

  const features = timezoneData.features.map((timezoneFeature, index) => {
    const timezone = timezoneFeature.properties.tzid;
    const baselineOffset = offsetHours(timezone, BASELINE_INSTANT);
    return {
      type: 'Feature',
      id: index,
      properties: {
        id: index,
        offset_hours: baselineOffset,
        offset_label: offsetLabel(baselineOffset),
        places: placeLabel(timezone),
        dst_places: '',
        timezone_name: timezone,
      },
      geometry: {
        type: 'MultiPolygon',
        coordinates: simplifyMultiPolygon(timezoneFeature.geometry.coordinates),
      },
    };
  });

  const output = {
    type: 'FeatureCollection',
    metadata: {
      baseline_instant: new Date(BASELINE_INSTANT).toISOString(),
      license: 'Open Database License (ODbL); © OpenStreetMap contributors',
      release: TIMEZONE_RELEASE,
      timezone_source: TIMEZONE_SOURCE,
      timezone_source_sha256: TIMEZONE_SOURCE_SHA256,
    },
    features,
  };
  await writeFile(outputPath, `${JSON.stringify(output)}\n`, 'utf8');
  console.log(`Wrote ${features.length} timekeeping-zone features to ${outputPath}`);
}

await main();
