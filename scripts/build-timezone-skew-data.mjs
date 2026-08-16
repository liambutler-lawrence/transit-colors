import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import polygonClipping from 'polygon-clipping';

const TIMEZONE_SOURCE =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_time_zones.geojson';
const LAND_SOURCE =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_50m_land.geojson';

function asMultiPolygon(geometry) {
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  throw new Error(`Unsupported geometry type: ${geometry.type}`);
}

function geometryBounds(geometry) {
  const polygons = asMultiPolygon(geometry);
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;

  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (const [longitude, latitude] of ring) {
        west = Math.min(west, longitude);
        south = Math.min(south, latitude);
        east = Math.max(east, longitude);
        north = Math.max(north, latitude);
      }
    }
  }
  return { east, north, south, west };
}

function boundsOverlap(a, b) {
  return (
    a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south
  );
}

function roundCoordinate(value) {
  return Number(value.toFixed(5));
}

function roundMultiPolygon(polygons) {
  return polygons.map((polygon) =>
    polygon.map((ring) =>
      ring.map(([longitude, latitude]) => [
        roundCoordinate(longitude),
        roundCoordinate(latitude),
      ]),
    ),
  );
}

function offsetLabel(offsetHours) {
  const sign = offsetHours < 0 ? '-' : '+';
  const absoluteMinutes = Math.round(Math.abs(offsetHours) * 60);
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;
  return `UTC${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${url}: ${response.status} ${response.statusText}`,
    );
  }
  return response.json();
}

async function main() {
  const outputPath = resolve(process.argv[2] ?? 'data/timezone-skew-zones.geojson');
  const [timezoneData, landData] = await Promise.all([
    fetchJson(TIMEZONE_SOURCE),
    fetchJson(LAND_SOURCE),
  ]);
  const landFeatures = landData.features.map((feature) => ({
    bounds: geometryBounds(feature.geometry),
    geometry: asMultiPolygon(feature.geometry),
  }));

  const features = [];
  for (const [index, timezoneFeature] of timezoneData.features.entries()) {
    const zone = Number(timezoneFeature.properties.zone);
    if (!Number.isFinite(zone)) continue;
    const timezoneGeometry = asMultiPolygon(timezoneFeature.geometry);
    const timezoneBounds = geometryBounds(timezoneFeature.geometry);
    const clippedPolygons = [];

    for (const landFeature of landFeatures) {
      if (!boundsOverlap(timezoneBounds, landFeature.bounds)) continue;
      const intersection = polygonClipping.intersection(
        timezoneGeometry,
        landFeature.geometry,
      );
      clippedPolygons.push(...intersection);
    }

    if (clippedPolygons.length === 0) continue;
    const properties = timezoneFeature.properties;
    features.push({
      type: 'Feature',
      id: index,
      properties: {
        id: index,
        offset_hours: zone,
        offset_label: offsetLabel(zone),
        places: properties.places ?? '',
        dst_places: properties.dst_places ?? '',
        timezone_name: properties.tz_name1st ?? '',
      },
      geometry: {
        type: 'MultiPolygon',
        coordinates: roundMultiPolygon(clippedPolygons),
      },
    });
  }

  const output = {
    type: 'FeatureCollection',
    metadata: {
      land_source: LAND_SOURCE,
      license: 'Natural Earth public domain',
      timezone_source: TIMEZONE_SOURCE,
    },
    features,
  };
  await writeFile(outputPath, `${JSON.stringify(output)}\n`, 'utf8');
  console.log(
    `Wrote ${features.length} land-clipped timezone features to ${outputPath}`,
  );
}

await main();
