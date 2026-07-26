import { VectorTile } from '@mapbox/vector-tile';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Pbf from 'pbf';
import polygonClipping from 'polygon-clipping';
import { polygonAreaSquareMeters } from '../src/circumference.js';

const shapefilePath = resolve(process.argv[2] ?? '/tmp/ne-land/ne_10m_land.shp');
const outputPath = resolve('data/circumference-landmasses.json');
const OPENFREEMAP_TILE_VERSION = '20260621_080001_pt';
const OPENFREEMAP_TILE_URL =
  `https://tiles.openfreemap.org/planet/${OPENFREEMAP_TILE_VERSION}` +
  '/{z}/{x}/{y}.pbf';
const SHORELINE_TILE_ZOOM = 12;

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

function tileX(longitude, zoom) {
  return Math.floor(((longitude + 180) / 360) * 2 ** zoom);
}

function tileY(latitude, zoom) {
  return Math.floor(
    ((1 - Math.asinh(Math.tan((latitude * Math.PI) / 180)) / Math.PI) / 2) * 2 ** zoom,
  );
}

function tileUrl(x, y, zoom) {
  return OPENFREEMAP_TILE_URL.replace('{z}', String(zoom))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}

async function detailedLandPolygonsForBounds(bounds) {
  const [west, south, east, north] = bounds;
  const tileCoordinates = [];
  for (
    let x = tileX(west, SHORELINE_TILE_ZOOM);
    x <= tileX(east, SHORELINE_TILE_ZOOM);
    x += 1
  ) {
    for (
      let y = tileY(north, SHORELINE_TILE_ZOOM);
      y <= tileY(south, SHORELINE_TILE_ZOOM);
      y += 1
    ) {
      tileCoordinates.push([x, y]);
    }
  }

  const tiles = await Promise.all(
    tileCoordinates.map(async ([x, y]) => {
      const url = tileUrl(x, y, SHORELINE_TILE_ZOOM);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Could not load shoreline tile ${url}: ${response.status}`);
      }
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        x,
        y,
      };
    }),
  );

  const waterPolygons = [];
  for (const { bytes, x, y } of tiles) {
    const waterLayer = new VectorTile(new Pbf(bytes)).layers.water;
    for (let index = 0; index < (waterLayer?.length ?? 0); index += 1) {
      const feature = waterLayer.feature(index).toGeoJSON(x, y, SHORELINE_TILE_ZOOM);
      if (feature.geometry.type === 'Polygon') {
        waterPolygons.push(feature.geometry.coordinates);
      } else if (feature.geometry.type === 'MultiPolygon') {
        waterPolygons.push(...feature.geometry.coordinates);
      }
    }
  }

  let waterUnion = [];
  for (let index = 0; index < waterPolygons.length; index += 40) {
    const chunk = polygonClipping.union(...waterPolygons.slice(index, index + 40));
    waterUnion =
      waterUnion.length === 0 ? chunk : polygonClipping.union(waterUnion, chunk);
  }
  return polygonClipping.difference(
    [
      [
        [
          [west, south],
          [east, south],
          [east, north],
          [west, north],
          [west, south],
        ],
      ],
    ],
    waterUnion,
  );
}

function landPolygonForPoint(polygons, point) {
  const polygon = polygons.find(([outerRing]) => pointInRing(point, outerRing));
  if (!polygon) {
    throw new Error(`No detailed land polygon contains ${point.join(', ')}.`);
  }
  return polygon;
}

const records = readPolygonRecords(await readFile(shapefilePath));
const americanMainland = ringRecordForPoint(records, [-99.1332, 19.4326]);
const nycLandmassDefinitions = [
  {
    id: 'american-mainland',
    label: 'American mainland',
    points: [
      [-73.927, 40.83],
      [-74.04, 40.73],
    ],
  },
  { id: 'manhattan', label: 'Manhattan', point: [-73.985, 40.75] },
  { id: 'long-island', label: 'Long Island', point: [-73.97, 40.68] },
  {
    id: 'roosevelt-island',
    label: 'Roosevelt Island',
    area_m2: 722_607,
    point: [-73.949, 40.762],
  },
];
const seenNycRings = new Set();
const nycGradientBounds = [-74.08, 40.54, -73.7, 40.9];
const detailedNycLandPolygons = await detailedLandPolygonsForBounds(nycGradientBounds);
const nycLandmasses = nycLandmassDefinitions.flatMap((definition) => {
  const definitionPoints = definition.points ?? [definition.point];
  const areaPoint = definitionPoints[0];
  const record =
    definition.area_m2 == null ? ringRecordForPoint(records, areaPoint) : null;
  const recordKey = record
    ? `${record.recordNumber}/${record.ringIndex}`
    : definition.id;
  if (seenNycRings.has(recordKey)) return [];
  seenNycRings.add(recordKey);
  const detailedPolygons = definitionPoints.map((point) =>
    landPolygonForPoint(detailedNycLandPolygons, point),
  );
  return [
    {
      id: definition.id,
      label: definition.label,
      area_m2:
        definition.area_m2 ??
        Math.round(polygonAreaSquareMeters(record?.ring ?? detailedPolygons[0][0])),
      mask: [...new Set(detailedPolygons)].map((polygon) => polygon.map(roundedRing)),
    },
  ];
});
const data = {
  source: 'Natural Earth 1:10m land-area totals',
  source_url:
    'https://www.naturalearthdata.com/downloads/10m-physical-vectors/10m-land/',
  source_version: '5.1.1',
  mask_source: 'OpenStreetMap water polygons from the OpenFreeMap basemap',
  mask_source_url: OPENFREEMAP_TILE_URL,
  mask_source_version: OPENFREEMAP_TILE_VERSION,
  mask_source_zoom: SHORELINE_TILE_ZOOM,
  supplemental_source: 'Roosevelt Island published 2020 Census land area',
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
