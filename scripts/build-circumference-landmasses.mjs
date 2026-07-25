import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { polygonAreaSquareMeters } from '../circumference.js';

const shapefilePath = resolve(
  process.argv[2] ?? '/tmp/ne-land/ne_10m_land.shp',
);
const outputPath = resolve('data/circumference-landmasses.json');

function readPolygonRecords(buffer) {
  const records = [];
  let offset = 100;

  while (offset + 8 <= buffer.length) {
    const recordNumber = buffer.readInt32BE(offset);
    const contentLengthBytes = buffer.readInt32BE(offset + 4) * 2;
    offset += 8;
    const recordEnd = offset + contentLengthBytes;
    const shapeType = buffer.readInt32LE(offset);

    if (shapeType === 5) {
      let cursor = offset + 36;
      const partCount = buffer.readInt32LE(cursor);
      const pointCount = buffer.readInt32LE(cursor + 4);
      cursor += 8;
      const partStarts = [];
      for (let index = 0; index < partCount; index += 1) {
        partStarts.push(buffer.readInt32LE(cursor + index * 4));
      }
      cursor += partCount * 4;

      const points = [];
      for (let index = 0; index < pointCount; index += 1) {
        points.push([
          buffer.readDoubleLE(cursor + index * 16),
          buffer.readDoubleLE(cursor + index * 16 + 8),
        ]);
      }

      records.push({
        recordNumber,
        rings: partStarts.map((start, index) =>
          points.slice(start, partStarts[index + 1] ?? pointCount),
        ),
      });
    }

    offset = recordEnd;
  }

  return records;
}

function pointInRing([longitude, latitude], ring) {
  let inside = false;
  for (
    let currentIndex = 0, previousIndex = ring.length - 1;
    currentIndex < ring.length;
    previousIndex = currentIndex, currentIndex += 1
  ) {
    const current = ring[currentIndex];
    const previous = ring[previousIndex];
    if (
      (current[1] > latitude) !== (previous[1] > latitude) &&
      longitude <
        ((previous[0] - current[0]) * (latitude - current[1])) /
          (previous[1] - current[1]) +
          current[0]
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function ringForPoint(records, point) {
  for (const record of records) {
    for (const ring of record.rings) {
      if (pointInRing(point, ring)) return ring;
    }
  }
  throw new Error(`No land polygon contains ${point.join(', ')}.`);
}

function roundedRing(ring) {
  return ring.map(([longitude, latitude]) => [
    Number(longitude.toFixed(6)),
    Number(latitude.toFixed(6)),
  ]);
}

const records = readPolygonRecords(await readFile(shapefilePath));
const americanMainland = ringForPoint(records, [-99.1332, 19.4326]);
const longIsland = ringForPoint(records, [-73.97, 40.68]);
const data = {
  source: 'Natural Earth 1:10m land polygons',
  source_url:
    'https://www.naturalearthdata.com/downloads/10m-physical-vectors/10m-land/',
  source_version: '5.1.1',
  calculation: 'Chamberlain-Duquette spherical polygon area',
  areas: {
    cdmx: {
      label: 'American mainland',
      area_m2: Math.round(polygonAreaSquareMeters(americanMainland)),
      gradient_bounds: [-99.42, 19.18, -98.84, 19.66],
      mask: null,
    },
    nyc: {
      label: 'Long Island',
      area_m2: Math.round(polygonAreaSquareMeters(longIsland)),
      gradient_bounds: [-74.04, 40.54, -73.7, 40.82],
      mask: roundedRing(longIsland),
    },
  },
};

await writeFile(outputPath, `${JSON.stringify(data)}\n`);
console.log(`Wrote ${outputPath}`);

