import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { CURATED_CDMX_STATIONS, OFFICIAL_SOURCES } from '../cdmx-curated-stations.mjs';
import {
  metroLineRefsForStation,
  normalizedPlatformStationName,
} from '../cdmx-platforms.mjs';
import {
  CURATED_REPLACEMENT_DISTANCE_M,
  FUTURE_NETWORK_RULES,
  MAX_DISTANCE_M,
  MODE_KEYS,
  OVER_RANGE_DISTANCE_M,
  STATION_BBOX_PADDING_M,
  STATUS_DATE,
  STATION_SEARCH_AREAS,
  buildStationGrid,
  classifyStation,
  compactProperties,
  dataDir,
  fetchElementsWithCache,
  fetchTiledElements,
  formatBbox,
  isKnownFalsePositiveTags,
  isStationLikeTags,
  nearestStationDistancesMeters,
  normalizeTag,
  routeMemberContexts,
  routeMemberQuery,
  roundCoordinate,
  roundedBounds,
  setProjectionCenter,
  stationBounds,
  stationQuery,
  stationStatus,
  streetQuery,
} from './helpers.mjs';

function stationCoordinate(element) {
  if (Number.isFinite(element.lon) && Number.isFinite(element.lat)) {
    return [element.lon, element.lat];
  }

  if (Number.isFinite(element.center?.lon) && Number.isFinite(element.center?.lat)) {
    return [element.center.lon, element.center.lat];
  }

  return null;
}

function stationTagsForElement(element, routeContexts) {
  const tags = { ...(element.tags ?? {}) };
  const routeContext = routeContexts.get(`${element.type}/${element.id}`);

  if (!routeContext) return tags;

  if (!tags.network && routeContext.network) tags.network = routeContext.network;
  if (!tags.operator && routeContext.operator) tags.operator = routeContext.operator;
  if (!tags.route_ref && routeContext.route_ref)
    tags.route_ref = routeContext.route_ref;
  if (!tags.route_name && routeContext.route_name)
    tags.route_name = routeContext.route_name;
  if (!tags.route_relation && routeContext.route_relation) {
    tags.route_relation = routeContext.route_relation;
  }

  return tags;
}

function buildStationFeatures(elements, routeContexts = new Map()) {
  const deduped = new Map();
  const excluded = [];

  for (const element of elements) {
    const elementKey = `${element.type}/${element.id}`;
    const coordinate = stationCoordinate(element);
    if (!coordinate) continue;

    const [lon, lat] = coordinate;
    const tags = stationTagsForElement(element, routeContexts);
    const publicTransport = normalizeTag(tags.public_transport);

    if (isKnownFalsePositiveTags(tags)) {
      excluded.push(element);
      continue;
    }

    if (!isStationLikeTags(tags) && !routeContexts.has(elementKey)) {
      excluded.push(element);
      continue;
    }

    if (!tags.name && publicTransport === 'stop_position') {
      excluded.push(element);
      continue;
    }

    const stationClass = classifyStation(tags);
    const status = stationStatus(tags);

    if (!stationClass.keep) {
      excluded.push(element);
      continue;
    }

    const rounded = [roundCoordinate(lon), roundCoordinate(lat)];
    const key = `${rounded[0]},${rounded[1]},${tags.name ?? ''}`;

    const feature = {
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: rounded,
      },
      properties: {
        id: `${element.type}/${element.id}`,
        osm_type: element.type,
        osm_id: element.id,
        name: tags.name ?? '',
        mode: stationClass.mode,
        system: stationClass.system,
        status: status.status,
        status_detail: status.status_detail,
        status_source: status.status_source,
        network: tags.network ?? '',
        operator: tags.operator ?? '',
        opening_date: tags.opening_date ?? '',
        station: tags.station ?? '',
        railway: tags.railway ?? '',
        amenity: tags.amenity ?? '',
        public_transport: tags.public_transport ?? '',
        highway: tags.highway ?? '',
        bus: tags.bus ?? '',
        trolleybus: tags.trolleybus ?? '',
        brand: tags.brand ?? '',
        ref: tags.ref ?? '',
        local_ref: tags.local_ref ?? '',
        route_ref: tags.route_ref ?? '',
        route_name: tags.route_name ?? '',
        route_relation: tags.route_relation ?? '',
      },
    };

    const existing = deduped.get(key);
    if (
      !existing ||
      (existing.properties.status !== 'open' && status.status === 'open')
    ) {
      deduped.set(key, feature);
    }
  }

  console.log(
    `Excluded ${excluded.length.toLocaleString()} generic bus/terminal station elements.`,
  );
  return [...deduped.values()];
}

function coordinateDistanceMeters(first, second) {
  const centerLat = ((first[1] + second[1]) / 2) * (Math.PI / 180);
  const dx = (first[0] - second[0]) * 111_320 * Math.cos(centerLat);
  const dy = (first[1] - second[1]) * 111_320;
  return Math.hypot(dx, dy);
}

function curatedStationFeature(station) {
  return {
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: station.coordinates.map(roundCoordinate),
    },
    properties: {
      id: station.id,
      osm_type: '',
      osm_id: null,
      name: station.name,
      mode: station.mode,
      system: station.system,
      status: 'open',
      status_detail: 'Open',
      status_source: 'Official operator source',
      network: station.network,
      operator: station.operator,
      opening_date: station.opening_date ?? '',
      station: station.mode === 'commuter_rail' ? 'train' : '',
      railway: station.mode === 'commuter_rail' ? 'station' : '',
      amenity: '',
      public_transport: 'station',
      highway: station.mode === 'brt' ? 'bus_stop' : '',
      bus: station.mode === 'brt' ? 'yes' : '',
      trolleybus: station.mode === 'brt' ? 'yes' : '',
      brand: station.network,
      ref: '',
      local_ref: '',
      route_ref: station.route_ref,
      route_name: station.route_name,
      route_relation: '',
      source: station.source,
      source_url: station.source_url,
    },
  };
}

function reconcileStationFeatures(features) {
  const curatedFeatures = CURATED_CDMX_STATIONS.map(curatedStationFeature);
  const retainedFeatures = features.filter((feature) => {
    const properties = feature.properties ?? {};
    if (String(properties.id ?? '').startsWith('official/')) return false;
    if (isKnownFalsePositiveTags(properties)) return false;

    const normalizedName = normalizeTag(properties.name);
    const routeRefs = new Set(
      String(properties.route_ref ?? '')
        .split(';')
        .map((value) => normalizeTag(value)),
    );
    return !curatedFeatures.some((curated) => {
      if (
        curated.properties.mode !== properties.mode ||
        coordinateDistanceMeters(
          curated.geometry.coordinates,
          feature.geometry.coordinates,
        ) > CURATED_REPLACEMENT_DISTANCE_M
      ) {
        return false;
      }
      if (properties.mode === 'subway') {
        const curatedLines = metroLineRefsForStation(curated.properties);
        const featureLines = metroLineRefsForStation(properties);
        return (
          normalizedPlatformStationName(curated.properties.name) ===
            normalizedPlatformStationName(properties.name) &&
          [...curatedLines].some((line) => featureLines.has(line))
        );
      }
      return (
        normalizeTag(curated.properties.name) === normalizedName ||
        (properties.mode === 'brt' &&
          routeRefs.has(normalizeTag(curated.properties.route_ref)))
      );
    });
  });

  return [...retainedFeatures, ...curatedFeatures];
}

function lineCoordinates(element) {
  if (!Array.isArray(element.geometry) || element.geometry.length < 2) {
    return null;
  }

  const coordinates = element.geometry
    .filter((point) => Number.isFinite(point.lon) && Number.isFinite(point.lat))
    .map((point) => [roundCoordinate(point.lon), roundCoordinate(point.lat)]);

  return coordinates.length >= 2 ? coordinates : null;
}

function buildStreetFeatures(elements, openStationFeatures, futureStationFeatures) {
  if (openStationFeatures.length === 0) {
    throw new Error('No station features found; cannot compute street distances.');
  }

  const openStationGrid = buildStationGrid(openStationFeatures);
  const futureStationGrid = buildStationGrid(futureStationFeatures);
  const futureModes = MODE_KEYS.filter((mode) =>
    futureStationFeatures.some((feature) => feature.properties.mode === mode),
  );
  const features = [];
  const modeDistances = Object.fromEntries(MODE_KEYS.map((mode) => [mode, []]));
  const futureModeDistances = Object.fromEntries(futureModes.map((mode) => [mode, []]));
  const modeAccessStationIndexes = Object.fromEntries(
    MODE_KEYS.map((mode) => [mode, []]),
  );
  const futureModeAccessStationIndexes = Object.fromEntries(
    futureModes.map((mode) => [mode, []]),
  );
  const accessStationIndexes = [];

  elements.forEach((element, index) => {
    const coordinates = lineCoordinates(element);
    if (!coordinates) return;

    const tags = element.tags ?? {};
    const distances = nearestStationDistancesMeters(coordinates, openStationGrid);
    const futureDistances = nearestStationDistancesMeters(
      coordinates,
      futureStationGrid,
    );

    features.push({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates,
      },
      properties: compactProperties(tags, distances.nearest),
    });
    accessStationIndexes.push(distances.stationIndex);

    for (const [modeIndex, mode] of MODE_KEYS.entries()) {
      const distance = distances.byMode[modeIndex];
      modeDistances[mode].push(
        distance <= MAX_DISTANCE_M ? Math.round(distance) : OVER_RANGE_DISTANCE_M,
      );
      modeAccessStationIndexes[mode].push(distances.stationIndexByMode[modeIndex]);

      if (futureModeDistances[mode]) {
        const futureDistance = futureDistances.byMode[modeIndex];
        futureModeDistances[mode].push(
          futureDistance <= MAX_DISTANCE_M
            ? Math.round(futureDistance)
            : OVER_RANGE_DISTANCE_M,
        );
        futureModeAccessStationIndexes[mode].push(
          futureDistances.stationIndexByMode[modeIndex],
        );
      }
    }

    if ((index + 1) % 5000 === 0) {
      console.log(`Processed ${(index + 1).toLocaleString()} street elements...`);
    }
  });

  return {
    features,
    modeDistances,
    futureModeDistances,
    accessStationIndexes,
    modeAccessStationIndexes,
    futureModeAccessStationIndexes,
  };
}

function histogram(features) {
  const result = {
    under_500_m: 0,
    under_1000_m: 0,
    under_2500_m: 0,
    under_5000_m: 0,
    over_5000_m: 0,
  };

  for (const feature of features) {
    const distance = feature.properties.d;

    if (distance <= 500) result.under_500_m += 1;
    if (distance <= 1000) result.under_1000_m += 1;
    if (distance <= 2500) result.under_2500_m += 1;
    if (feature.properties.o === 1) {
      result.over_5000_m += 1;
    } else {
      result.under_5000_m += 1;
    }
  }

  return result;
}

function propertyCounts(features, property) {
  return features.reduce((counts, feature) => {
    const key = feature.properties[property] || 'unknown';
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function featureCollection(features) {
  return {
    type: 'FeatureCollection',
    features,
  };
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`, 'utf8');
}

export async function main() {
  await mkdir(dataDir, { recursive: true });

  const stationElements = await fetchElementsWithCache(
    'station-cdmx-edomex',
    stationQuery(),
  );
  const routeElements = await fetchElementsWithCache(
    'brt-route-members-cdmx-edomex',
    routeMemberQuery(),
  );
  const routeContexts = routeMemberContexts(routeElements);

  const stationFeatures = reconcileStationFeatures(
    buildStationFeatures([...stationElements, ...routeElements], routeContexts),
  );
  console.log(`Built ${stationFeatures.length.toLocaleString()} station features.`);
  const dataBounds = roundedBounds(stationBounds(stationFeatures));
  setProjectionCenter(dataBounds);
  console.log(
    `Derived street bbox ${formatBbox(dataBounds)} from stations with ${STATION_BBOX_PADDING_M.toLocaleString()}m padding.`,
  );

  const openStationFeatures = stationFeatures.filter(
    (feature) => feature.properties.status === 'open',
  );
  const futureStationFeatures = stationFeatures.filter(
    (feature) => feature.properties.status !== 'open',
  );
  console.log(
    `Using ${openStationFeatures.length.toLocaleString()} open stations for distance calculation.`,
  );
  console.log(
    `Keeping ${futureStationFeatures.length.toLocaleString()} future/planned stations for optional display.`,
  );

  const streetElements = await fetchTiledElements('street', streetQuery, dataBounds);
  const streetBuild = buildStreetFeatures(
    streetElements,
    openStationFeatures,
    futureStationFeatures,
  );
  const streetFeatures = streetBuild.features;
  console.log(`Built ${streetFeatures.length.toLocaleString()} street features.`);

  const metadata = {
    city: 'Ciudad de Mexico / Estado de Mexico rapid transit area',
    generated_at: new Date().toISOString(),
    bbox: dataBounds,
    max_distance_m: MAX_DISTANCE_M,
    station_bbox_padding_m: STATION_BBOX_PADDING_M,
    station_search_areas: STATION_SEARCH_AREAS,
    status_date: STATUS_DATE.toISOString(),
    street_count: streetFeatures.length,
    station_count: stationFeatures.length,
    open_station_count: openStationFeatures.length,
    future_station_count: futureStationFeatures.length,
    station_modes: propertyCounts(stationFeatures, 'mode'),
    station_modes_open: propertyCounts(openStationFeatures, 'mode'),
    station_modes_future: propertyCounts(futureStationFeatures, 'mode'),
    station_statuses: propertyCounts(stationFeatures, 'status'),
    distance_station_scope: 'open stations by default; future stations when enabled',
    street_mode_distance_file: 'data/cdmx-street-mode-distances.json',
    street_mode_distance_over_range_value: OVER_RANGE_DISTANCE_M,
    future_station_rules: FUTURE_NETWORK_RULES.map((rule) => ({
      pattern: String(rule.pattern),
      status_detail: rule.status_detail,
      reason: rule.reason,
    })),
    histogram: histogram(streetFeatures),
    street_property_schema: {
      d: 'nearest station distance in meters, clamped to max_distance_m',
      h: 'OpenStreetMap highway tag',
      n: 'OpenStreetMap street name',
      o: '1 when true distance is over max_distance_m',
    },
    street_access_schema: {
      station_ids: 'open station IDs in index order',
      future_station_ids: 'future station IDs in index order',
      street_station_indexes:
        'nearest open station index for each feature in cdmx-streets.geojson',
      station_indexes_by_mode:
        'nearest open station index by mode for each street feature',
      future_station_indexes_by_mode:
        'nearest future station index by mode for each street feature',
    },
    sources: [
      'OpenStreetMap contributors',
      'Overpass API',
      ...Object.values(OFFICIAL_SOURCES),
    ],
  };

  await writeJson(
    resolve(dataDir, 'cdmx-stations.geojson'),
    featureCollection(stationFeatures),
  );
  await writeJson(
    resolve(dataDir, 'cdmx-streets.geojson'),
    featureCollection(streetFeatures),
  );
  await writeJson(resolve(dataDir, 'cdmx-street-mode-distances.json'), {
    feature_count: streetFeatures.length,
    max_distance_m: MAX_DISTANCE_M,
    over_range_value: OVER_RANGE_DISTANCE_M,
    distances_by_mode: streetBuild.modeDistances,
    future_distances_by_mode: streetBuild.futureModeDistances,
  });
  await writeJson(resolve(dataDir, 'cdmx-street-access.json'), {
    station_ids: openStationFeatures.map((feature) => feature.properties.id),
    future_station_ids: futureStationFeatures.map((feature) => feature.properties.id),
    street_station_indexes: streetBuild.accessStationIndexes,
    station_indexes_by_mode: streetBuild.modeAccessStationIndexes,
    future_station_indexes_by_mode: streetBuild.futureModeAccessStationIndexes,
  });
  await writeJson(resolve(dataDir, 'cdmx-metadata.json'), metadata);

  console.log('Wrote data/cdmx-stations.geojson');
  console.log('Wrote data/cdmx-streets.geojson');
  console.log('Wrote data/cdmx-street-mode-distances.json');
  console.log('Wrote data/cdmx-street-access.json');
  console.log('Wrote data/cdmx-metadata.json');
}

export {
  buildStationFeatures,
  buildStreetFeatures,
  classifyStation,
  featureCollection,
  histogram,
  isKnownFalsePositiveTags,
  MODE_KEYS,
  propertyCounts,
  reconcileStationFeatures,
  setProjectionCenter,
  writeJson,
};
