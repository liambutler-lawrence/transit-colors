import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LAND_USE_CATEGORIES, classifyJerseyCityParcel } from '../src/land-use.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const outputPath = resolve(rootDir, 'data/jersey-city-land-use.pmtiles');
const summaryPath = resolve(rootDir, 'data/jersey-city-land-use-summary.json');

const PARCEL_LAYER =
  'https://services2.arcgis.com/UXbywc7dSkfgdPp4/arcgis/rest/services/Parcel_2024/FeatureServer/0';
const ZONING_LAYER =
  'https://services2.arcgis.com/UXbywc7dSkfgdPp4/arcgis/rest/services/Zoning_Districts/FeatureServer/0';
const HISTORIC_LAYER =
  'https://services2.arcgis.com/UXbywc7dSkfgdPp4/arcgis/rest/services/Historic_Districts/FeatureServer/1';

const PARCEL_FIELDS = [
  'OBJECTID',
  'Parcel_UNIQUEID',
  'Parcel_BLOCK',
  'Parcel_LOT',
  'M4_Location',
  'M4_Class',
  'M4_Bldg_Desc',
  'M4_Zone',
  'M4_Year_Built',
  'M4_Impr_Value',
];

function nonEmpty(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`${response.status} ${response.statusText}: ${url}`);
  const payload = await response.json();
  if (payload.error) throw new Error(JSON.stringify(payload.error));
  return payload;
}

async function fetchFeatures(layerUrl, outFields, objectIdField = 'OBJECTID') {
  const features = [];
  const pageSize = 2000;
  for (let offset = 0; ; offset += pageSize) {
    const parameters = new URLSearchParams({
      f: 'geojson',
      geometryPrecision: '6',
      orderByFields: objectIdField,
      outFields: outFields.join(','),
      outSR: '4326',
      resultOffset: String(offset),
      resultRecordCount: String(pageSize),
      returnGeometry: 'true',
      where: '1=1',
    });
    const page = await fetchJson(`${layerUrl}/query?${parameters}`);
    const pageFeatures = Array.isArray(page.features) ? page.features : [];
    features.push(...pageFeatures);
    if (pageFeatures.length < pageSize) break;
  }
  return features;
}

function mergeParcelRecords(features) {
  const parcels = new Map();
  for (const feature of features) {
    const properties = feature.properties ?? {};
    // The tax join repeats one physical footprint for every condominium unit,
    // sometimes with sub-centimeter coordinate differences after reprojection.
    const key = geometryBbox(feature.geometry)
      .map((coordinate) => coordinate.toFixed(6))
      .join(':');
    const existing = parcels.get(key);
    if (!existing) {
      parcels.set(key, feature);
      continue;
    }
    for (const field of PARCEL_FIELDS) {
      if (!nonEmpty(existing.properties?.[field]) && nonEmpty(properties[field])) {
        existing.properties[field] = properties[field];
      }
    }
  }
  return [...parcels.values()];
}

function geometryBbox(geometry) {
  const coordinates =
    geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates.flat(1);
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  for (const ring of coordinates) {
    for (const [longitude, latitude] of ring) {
      west = Math.min(west, longitude);
      south = Math.min(south, latitude);
      east = Math.max(east, longitude);
      north = Math.max(north, latitude);
    }
  }
  return [west, south, east, north];
}

function ringContainsPoint(ring, point) {
  let inside = false;
  for (
    let current = 0, previous = ring.length - 1;
    current < ring.length;
    previous = current++
  ) {
    const [currentX, currentY] = ring[current];
    const [previousX, previousY] = ring[previous];
    const crosses =
      currentY > point[1] !== previousY > point[1] &&
      point[0] <
        ((previousX - currentX) * (point[1] - currentY)) / (previousY - currentY) +
          currentX;
    if (crosses) inside = !inside;
  }
  return inside;
}

function polygonContainsPoint(polygon, point) {
  return (
    ringContainsPoint(polygon[0] ?? [], point) &&
    !polygon.slice(1).some((hole) => ringContainsPoint(hole, point))
  );
}

function geometryContainsPoint(geometry, point) {
  const polygons =
    geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polygons.some((polygon) => polygonContainsPoint(polygon, point));
}

function representativePoint(geometry) {
  const polygons =
    geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const ring = polygons[0]?.[0] ?? [];
  if (ring.length === 0) return [0, 0];
  let longitude = 0;
  let latitude = 0;
  let areaFactor = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[index + 1];
    const cross = x1 * y2 - x2 * y1;
    longitude += (x1 + x2) * cross;
    latitude += (y1 + y2) * cross;
    areaFactor += cross;
  }
  if (Math.abs(areaFactor) > 1e-12) {
    const centroid = [longitude / (3 * areaFactor), latitude / (3 * areaFactor)];
    if (geometryContainsPoint(geometry, centroid)) return centroid;
  }
  return ring[0];
}

function searchableFeatures(features) {
  return features.map((feature) => ({
    feature,
    bbox: geometryBbox(feature.geometry),
  }));
}

function featureAtPoint(searchable, point) {
  return searchable.find(
    ({ bbox, feature }) =>
      point[0] >= bbox[0] &&
      point[0] <= bbox[2] &&
      point[1] >= bbox[1] &&
      point[1] <= bbox[3] &&
      geometryContainsPoint(feature.geometry, point),
  )?.feature;
}

function compactOverlayFeature(feature, id, properties) {
  return {
    type: 'Feature',
    id,
    properties: { id, ...properties },
    geometry: feature.geometry,
  };
}

async function runTippecanoe(layers, output) {
  const args = [
    '--force',
    `--output=${output}`,
    '--minimum-zoom=10',
    '--maximum-zoom=16',
    '--no-feature-limit',
    '--no-tile-size-limit',
    '--detect-shared-borders',
    '--simplify-only-low-zooms',
    '--no-tile-stats',
    '--quiet',
    '--name=Jersey City parcel use and zoning',
    '--description=Classified tax parcels with current zoning and historic overlays',
    ...layers.flatMap(({ name, path }) => ['-L', `${name}:${path}`]),
  ];
  const child = spawn('tippecanoe', args, { stdio: 'inherit' });
  const [exitCode] = await once(child, 'exit');
  if (exitCode !== 0) throw new Error(`tippecanoe exited with code ${exitCode}.`);
}

async function build() {
  const [
    parcelFeatures,
    zoningFeatures,
    historicFeatures,
    parcelMetadata,
    zoningMetadata,
  ] = await Promise.all([
    fetchFeatures(PARCEL_LAYER, PARCEL_FIELDS),
    fetchFeatures(ZONING_LAYER, ['FID', 'ZONE', 'REPLAN', 'NAME'], 'FID'),
    fetchFeatures(HISTORIC_LAYER, ['OBJECTID', 'Name']),
    fetchJson(`${PARCEL_LAYER}?f=json`),
    fetchJson(`${ZONING_LAYER}?f=json`),
  ]);

  const parcels = mergeParcelRecords(parcelFeatures);
  const searchableZoning = searchableFeatures(
    [...zoningFeatures].sort((left, right) =>
      String(right.properties?.REPLAN ?? '').localeCompare(
        String(left.properties?.REPLAN ?? ''),
      ),
    ),
  );
  const searchableHistoric = searchableFeatures(historicFeatures);
  const counts = Object.fromEntries(LAND_USE_CATEGORIES.map(({ key }) => [key, 0]));

  const classifiedParcels = parcels.map((feature, index) => {
    const source = feature.properties ?? {};
    const point = representativePoint(feature.geometry);
    const zoning = featureAtPoint(searchableZoning, point)?.properties ?? {};
    const historic = featureAtPoint(searchableHistoric, point)?.properties ?? {};
    const zoneCode = String(zoning.ZONE ?? source.M4_Zone ?? '').trim();
    const zoneName = String(zoning.NAME ?? '').trim();
    const historicDistrict = String(historic.Name ?? '').trim();
    const classification = classifyJerseyCityParcel({
      buildingDescription: source.M4_Bldg_Desc,
      historicDistrict,
      improvementValue: source.M4_Impr_Value,
      taxClass: source.M4_Class,
      yearBuilt: source.M4_Year_Built,
      zoneCode,
      zoneName,
    });
    counts[classification.category] += 1;
    const id = index + 1;
    return {
      type: 'Feature',
      id,
      properties: {
        id,
        category: classification.category,
        status: classification.status,
        address: String(source.M4_Location ?? '').trim(),
        block: String(source.Parcel_BLOCK ?? '').trim(),
        lot: String(source.Parcel_LOT ?? '').trim(),
        tax_class: String(source.M4_Class ?? '').trim(),
        building: String(source.M4_Bldg_Desc ?? '').trim(),
        zone_code: zoneCode,
        zone_name: zoneName,
        zone_type:
          String(zoning.REPLAN ?? '').toUpperCase() === 'YES'
            ? 'Redevelopment plan'
            : zoneCode || zoneName
              ? 'Zoning district'
              : 'Unmapped',
        year_built: classification.yearBuilt,
        stories: classification.stories,
        historic: historicDistrict,
      },
      geometry: feature.geometry,
    };
  });

  const compactZoning = zoningFeatures.map((feature, index) =>
    compactOverlayFeature(feature, index + 1, {
      code: String(feature.properties?.ZONE ?? '').trim(),
      name: String(feature.properties?.NAME ?? '').trim(),
      redevelopment:
        String(feature.properties?.REPLAN ?? '').toUpperCase() === 'YES' ? 1 : 0,
    }),
  );
  const compactHistoric = historicFeatures.map((feature, index) =>
    compactOverlayFeature(feature, index + 1, {
      name: String(feature.properties?.Name ?? '').trim(),
    }),
  );

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'transit-colors-land-use-'));
  try {
    const layers = [
      { name: 'parcels', features: classifiedParcels },
      { name: 'zoning', features: compactZoning },
      { name: 'historic', features: compactHistoric },
    ];
    const layerPaths = [];
    for (const layer of layers) {
      const path = join(temporaryDirectory, `${layer.name}.geojson`);
      await writeFile(
        path,
        JSON.stringify({ type: 'FeatureCollection', features: layer.features }),
      );
      layerPaths.push({ name: layer.name, path });
    }
    await runTippecanoe(layerPaths, outputPath);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }

  const sourceDates = {
    parcels: new Date(parcelMetadata.editingInfo?.dataLastEditDate ?? 0).toISOString(),
    zoning: new Date(zoningMetadata.editingInfo?.dataLastEditDate ?? 0).toISOString(),
  };
  const summary = {
    generated_at: new Date().toISOString(),
    parcel_count: classifiedParcels.length,
    source_record_count: parcelFeatures.length,
    zoning_polygon_count: zoningFeatures.length,
    historic_district_count: historicFeatures.length,
    category_counts: counts,
    source_dates: sourceDates,
    sources: {
      parcels: PARCEL_LAYER,
      zoning: ZONING_LAYER,
      historic_districts: HISTORIC_LAYER,
    },
  };
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(
    `Wrote ${basename(outputPath)} with ${classifiedParcels.length.toLocaleString()} parcels (${parcelFeatures.length.toLocaleString()} source records).`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await build();
}

export {
  featureAtPoint,
  geometryContainsPoint,
  mergeParcelRecords,
  representativePoint,
};
