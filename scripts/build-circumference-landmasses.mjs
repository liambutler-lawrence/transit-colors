import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { polygonAreaSquareMeters } from '../src/circumference.js';

const shapefilePath = resolve(process.argv[2] ?? '/tmp/ne-land/ne_10m_land.shp');
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
      current[1] > latitude !== previous[1] > latitude &&
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

function ringRecordForPoint(records, point) {
  for (const record of records) {
    for (const [ringIndex, ring] of record.rings.entries()) {
      if (pointInRing(point, ring)) {
        return { recordNumber: record.recordNumber, ringIndex, ring };
      }
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

function clipRingToBounds(ring, [west, south, east, north]) {
  const clip = (points, inside, intersect) => {
    const output = [];
    for (
      let currentIndex = 0, previousIndex = points.length - 1;
      currentIndex < points.length;
      previousIndex = currentIndex, currentIndex += 1
    ) {
      const current = points[currentIndex];
      const previous = points[previousIndex];
      const currentInside = inside(current);
      const previousInside = inside(previous);
      if (currentInside) {
        if (!previousInside) output.push(intersect(previous, current));
        output.push(current);
      } else if (previousInside) {
        output.push(intersect(previous, current));
      }
    }
    return output;
  };
  let result = ring;
  result = clip(
    result,
    ([longitude]) => longitude >= west,
    (from, to) => [
      west,
      from[1] + ((to[1] - from[1]) * (west - from[0])) / (to[0] - from[0]),
    ],
  );
  result = clip(
    result,
    ([longitude]) => longitude <= east,
    (from, to) => [
      east,
      from[1] + ((to[1] - from[1]) * (east - from[0])) / (to[0] - from[0]),
    ],
  );
  result = clip(
    result,
    ([, latitude]) => latitude >= south,
    (from, to) => [
      from[0] + ((to[0] - from[0]) * (south - from[1])) / (to[1] - from[1]),
      south,
    ],
  );
  return clip(
    result,
    ([, latitude]) => latitude <= north,
    (from, to) => [
      from[0] + ((to[0] - from[0]) * (north - from[1])) / (to[1] - from[1]),
      north,
    ],
  );
}

const records = readPolygonRecords(await readFile(shapefilePath));
const americanMainland = ringRecordForPoint(records, [-99.1332, 19.4326]);
const nycLandmassDefinitions = [
  {
    id: 'american-mainland',
    label: 'American mainland',
    point: [-73.927, 40.83],
  },
  { id: 'manhattan', label: 'Manhattan', point: [-73.985, 40.75] },
  { id: 'long-island', label: 'Long Island', point: [-73.97, 40.68] },
  {
    id: 'roosevelt-island',
    label: 'Roosevelt Island',
    area_m2: 722_607,
    ring: [
      [-73.9612, 40.7503],
      [-73.959, 40.749],
      [-73.9411, 40.7721],
      [-73.9425, 40.7737],
      [-73.9448, 40.7727],
      [-73.9617, 40.752],
    ],
  },
];
const seenNycRings = new Set();
const nycGradientBounds = [-74.08, 40.54, -73.7, 40.9];
const nycLandmasses = nycLandmassDefinitions.flatMap((definition) => {
  const record = definition.ring
    ? { recordNumber: definition.id, ringIndex: 0, ring: definition.ring }
    : ringRecordForPoint(records, definition.point);
  const recordKey = `${record.recordNumber}/${record.ringIndex}`;
  if (seenNycRings.has(recordKey)) return [];
  seenNycRings.add(recordKey);
  return [
    {
      id: definition.id,
      label: definition.label,
      area_m2: definition.area_m2 ?? Math.round(polygonAreaSquareMeters(record.ring)),
      mask: roundedRing(clipRingToBounds(record.ring, nycGradientBounds)),
    },
  ];
});
const data = {
  source: 'Natural Earth 1:10m land polygons',
  source_url:
    'https://www.naturalearthdata.com/downloads/10m-physical-vectors/10m-land/',
  source_version: '5.1.1',
  supplemental_source:
    'Roosevelt Island published 2020 Census land area with a manual local shoreline mask',
  calculation:
    'Chamberlain-Duquette spherical area after exact route/landmass polygon intersection',
  areas: {
    cdmx: {
      label: 'American mainland',
      area_m2: Math.round(polygonAreaSquareMeters(americanMainland.ring)),
      gradient_bounds: [-99.42, 19.18, -98.84, 19.66],
      mask: null,
      landmasses: [
        {
          id: 'american-mainland',
          label: 'American mainland',
          area_m2: Math.round(polygonAreaSquareMeters(americanMainland.ring)),
          mask: null,
        },
      ],
    },
    nyc: {
      label: 'NYC landmasses',
      area_m2: nycLandmasses.reduce((total, landmass) => total + landmass.area_m2, 0),
      gradient_bounds: nycGradientBounds,
      mask: null,
      landmasses: nycLandmasses,
    },
  },
};

await writeFile(outputPath, `${JSON.stringify(data)}\n`);
console.log(`Wrote ${outputPath}`);
