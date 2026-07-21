const DATASETS = {
  streets: 'data/cdmx-streets.geojson',
  streetModeDistances: 'data/cdmx-street-mode-distances.json',
  stations: 'data/cdmx-stations.geojson',
  metadata: 'data/cdmx-metadata.json',
};

const COLORS = {
  near: '#0aa66a',
  midNear: '#ffd43b',
  midFar: '#f97316',
  far: '#c7362f',
  future: '#64748b',
};

const MODE_LABELS = {
  subway: 'Metro',
  brt: 'BRT',
  light_rail: 'Light rail',
  cable_car: 'Cable car',
  commuter_rail: 'Commuter rail',
  regional_rail: 'Regional rail',
  monorail: 'Monorail',
};

const MODE_COLORS = {
  subway: '#f05a28',
  brt: '#8b2bb1',
  light_rail: '#1a9d8f',
  cable_car: '#0072ce',
  commuter_rail: '#5c6f82',
  regional_rail: '#b35a00',
  monorail: '#111827',
};

const MODE_DISTANCE_PROPERTIES = {
  subway: 'ds',
  brt: 'db',
  light_rail: 'dl',
  cable_car: 'dc',
  commuter_rail: 'dt',
  regional_rail: 'dr',
  monorail: 'dm',
};

const FUTURE_MODE_DISTANCE_PROPERTIES = {
  subway: 'fs',
  brt: 'fb',
  light_rail: 'fl',
  cable_car: 'fc',
  commuter_rail: 'ft',
  regional_rail: 'fr',
  monorail: 'fm',
};

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: [-99.1332, 19.4326],
  zoom: 10.5,
});

map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

const statusEl = document.querySelector('#status');
const streetCountEl = document.querySelector('#street-count');
const stationCountEl = document.querySelector('#station-count');
const nearCountEl = document.querySelector('#near-count');
const stationBreakdownEl = document.querySelector('#station-breakdown');
const selectionTypeEl = document.querySelector('#selection-type');
const featureNameEl = document.querySelector('#feature-name');
const featureSummaryEl = document.querySelector('#feature-summary');
const featureMetadataEl = document.querySelector('#feature-metadata');
const streetToggle = document.querySelector('#toggle-streets');
const stationToggle = document.querySelector('#toggle-stations');
const futureStationToggle = document.querySelector('#toggle-future-stations');

const stationColor = [
  'match',
  ['get', 'mode'],
  'subway',
  MODE_COLORS.subway,
  'brt',
  MODE_COLORS.brt,
  'light_rail',
  MODE_COLORS.light_rail,
  'cable_car',
  MODE_COLORS.cable_car,
  'commuter_rail',
  MODE_COLORS.commuter_rail,
  'regional_rail',
  MODE_COLORS.regional_rail,
  'monorail',
  MODE_COLORS.monorail,
  '#18222c',
];

const openStationFilter = ['==', ['get', 'status'], 'open'];
const futureStationFilter = ['!=', ['get', 'status'], 'open'];
const openStationLayers = ['station-points-open', 'station-labels-open'];
const futureStationLayers = ['station-points-future', 'station-labels-future'];
const activeStationModes = new Set();
const allStationModes = new Set();
let maxDistanceMeters = 5000;
let streetFeatureCount = 0;
let streetModeDistances = {};
let futureStreetModeDistances = {};
let streetFeatureBounds = null;
let stationStatistics = [];
let selectedStreetProperties = null;

function formatInteger(value) {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatDistance(meters) {
  if (!Number.isFinite(meters)) return '--';
  if (meters < 950) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: ${response.status}`);
  }
  return response.json();
}

function firstSymbolLayerId() {
  return map.getStyle().layers.find((layer) => layer.type === 'symbol')?.id;
}

function setLayerVisibility(id, visible) {
  if (map.getLayer(id)) {
    map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }
}

function syncStationVisibility() {
  const showStations = stationToggle.checked;
  const showFuture = showStations && futureStationToggle.checked;

  for (const layerId of openStationLayers) {
    setLayerVisibility(layerId, showStations);
  }

  for (const layerId of futureStationLayers) {
    setLayerVisibility(layerId, showFuture);
  }
}

function filterByActiveModes(statusFilter) {
  const activeModes = [...activeStationModes];

  if (activeModes.length === 0) {
    return ['all', statusFilter, ['==', ['get', 'mode'], '__none__']];
  }

  return [
    'all',
    statusFilter,
    ['in', ['get', 'mode'], ['literal', activeModes]],
  ];
}

function syncStationFilters() {
  for (const layerId of openStationLayers) {
    if (map.getLayer(layerId)) {
      map.setFilter(layerId, filterByActiveModes(openStationFilter));
    }
  }

  for (const layerId of futureStationLayers) {
    if (map.getLayer(layerId)) {
      map.setFilter(layerId, filterByActiveModes(futureStationFilter));
    }
  }
}

function streetDistanceExpression() {
  if (
    activeStationModes.size === allStationModes.size &&
    !futureStationToggle.checked
  ) {
    return ['get', 'd'];
  }

  const distanceProperties = [...activeStationModes]
    .map((mode) => MODE_DISTANCE_PROPERTIES[mode])
    .filter(Boolean);

  if (futureStationToggle.checked) {
    distanceProperties.push(
      ...[...activeStationModes]
        .map((mode) => FUTURE_MODE_DISTANCE_PROPERTIES[mode])
        .filter(Boolean),
    );
  }

  const modeDistances = distanceProperties
    .map((property) => ['to-number', ['get', property], maxDistanceMeters]);

  if (modeDistances.length === 0) return maxDistanceMeters;
  if (modeDistances.length === 1) return modeDistances[0];
  return ['min', ...modeDistances];
}

function streetColorExpression() {
  return [
    'interpolate',
    ['linear'],
    streetDistanceExpression(),
    0,
    COLORS.near,
    1000,
    COLORS.midNear,
    2500,
    COLORS.midFar,
    maxDistanceMeters,
    COLORS.far,
  ];
}

function syncStreetColor() {
  if (map.getLayer('street-proximity')) {
    map.setPaintProperty('street-proximity', 'line-color', streetColorExpression());
  }
}

function selectedDistanceArrays() {
  const selectedDistanceArrays = [...activeStationModes]
    .map((mode) => streetModeDistances[mode])
    .filter(Boolean);

  if (futureStationToggle.checked) {
    selectedDistanceArrays.push(
      ...[...activeStationModes]
        .map((mode) => futureStreetModeDistances[mode])
        .filter(Boolean),
    );
  }

  return selectedDistanceArrays;
}

function initializeStatisticsData(streets, stations) {
  const streetFeatures = streets.features ?? [];
  streetFeatureBounds = new Float64Array(streetFeatures.length * 4);

  for (const [featureIndex, feature] of streetFeatures.entries()) {
    const coordinates = feature.geometry?.coordinates ?? [];
    let west = Number.POSITIVE_INFINITY;
    let south = Number.POSITIVE_INFINITY;
    let east = Number.NEGATIVE_INFINITY;
    let north = Number.NEGATIVE_INFINITY;

    for (const [lon, lat] of coordinates) {
      west = Math.min(west, lon);
      south = Math.min(south, lat);
      east = Math.max(east, lon);
      north = Math.max(north, lat);
    }

    const offset = featureIndex * 4;
    streetFeatureBounds[offset] = west;
    streetFeatureBounds[offset + 1] = south;
    streetFeatureBounds[offset + 2] = east;
    streetFeatureBounds[offset + 3] = north;
  }

  stationStatistics = (stations.features ?? []).map((feature) => ({
    coordinates: feature.geometry?.coordinates ?? [],
    mode: feature.properties?.mode,
    status: feature.properties?.status,
  }));
}

function updateViewportStatistics() {
  if (!streetFeatureBounds) return;

  const bounds = map.getBounds();
  const west = bounds.getWest();
  const south = bounds.getSouth();
  const east = bounds.getEast();
  const north = bounds.getNorth();
  const distanceArrays = selectedDistanceArrays();
  let visibleStreetCount = 0;
  let nearCount = 0;

  if (streetToggle.checked) {
    for (let featureIndex = 0; featureIndex < streetFeatureCount; featureIndex += 1) {
      const offset = featureIndex * 4;
      const isInView =
        streetFeatureBounds[offset] <= east &&
        streetFeatureBounds[offset + 2] >= west &&
        streetFeatureBounds[offset + 1] <= north &&
        streetFeatureBounds[offset + 3] >= south;

      if (!isInView) continue;

      visibleStreetCount += 1;
      if (distanceArrays.some((distances) => distances[featureIndex] <= 2500)) {
        nearCount += 1;
      }
    }
  }

  let visibleStationCount = 0;

  if (stationToggle.checked) {
    for (const station of stationStatistics) {
      const [lon, lat] = station.coordinates;
      const statusVisible =
        station.status === 'open' || futureStationToggle.checked;

      if (
        statusVisible &&
        activeStationModes.has(station.mode) &&
        lon >= west &&
        lon <= east &&
        lat >= south &&
        lat <= north
      ) {
        visibleStationCount += 1;
      }
    }
  }

  streetCountEl.textContent = formatInteger(visibleStreetCount);
  stationCountEl.textContent = formatInteger(visibleStationCount);
  nearCountEl.textContent = formatInteger(nearCount);
}

function attachStreetModeDistances(streets, distanceData) {
  const features = streets.features ?? [];
  const distancesByMode = distanceData.distances_by_mode ?? {};
  const futureDistancesByMode = distanceData.future_distances_by_mode ?? {};

  if (distanceData.feature_count !== features.length) {
    throw new Error(
      `Street mode distances have ${distanceData.feature_count} features; expected ${features.length}.`,
    );
  }

  maxDistanceMeters = distanceData.max_distance_m ?? maxDistanceMeters;
  streetFeatureCount = features.length;
  streetModeDistances = distancesByMode;
  futureStreetModeDistances = futureDistancesByMode;

  const attachDistances = (modeDistances, properties, status) => {
    for (const [mode, distances] of Object.entries(modeDistances)) {
      const property = properties[mode];
      if (!property || distances.length !== features.length) {
        throw new Error(`Invalid ${status} street distance data for station mode: ${mode}.`);
      }

      for (let featureIndex = 0; featureIndex < features.length; featureIndex += 1) {
        features[featureIndex].properties[property] = distances[featureIndex];
      }
    }
  };

  attachDistances(distancesByMode, MODE_DISTANCE_PROPERTIES, 'open');
  attachDistances(
    futureDistancesByMode,
    FUTURE_MODE_DISTANCE_PROPERTIES,
    'future',
  );
}

function updateStatus(label, isError = false) {
  statusEl.textContent = label;
  statusEl.classList.toggle('error', isError);
}

function renderMetadata(metadata) {
  const streetCount = metadata.street_count ?? 0;
  const stationCount = metadata.open_station_count ?? metadata.station_count ?? 0;
  const nearCount = metadata.histogram?.under_2500_m ?? 0;

  maxDistanceMeters = metadata.max_distance_m ?? maxDistanceMeters;

  streetCountEl.textContent = formatInteger(streetCount);
  stationCountEl.textContent = formatInteger(stationCount);
  nearCountEl.textContent = formatInteger(nearCount);

  const stationModes = metadata.station_modes_open ?? metadata.station_modes ?? {};
  const sortedStationModes = Object.entries(stationModes).sort((a, b) => b[1] - a[1]);

  activeStationModes.clear();
  allStationModes.clear();
  for (const [mode] of sortedStationModes) {
    activeStationModes.add(mode);
    allStationModes.add(mode);
  }

  stationBreakdownEl.replaceChildren(
    ...sortedStationModes.map(([mode, count]) => {
      const label = MODE_LABELS[mode] ?? mode;
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'mode-pill';
      item.dataset.mode = mode;
      item.setAttribute('aria-pressed', 'true');
      item.setAttribute('aria-label', `${label} stations: ${formatInteger(count)}`);
      item.title = `Hide ${label} stations`;
      item.style.setProperty('--mode-color', MODE_COLORS[mode] ?? '#18222c');
      item.textContent = `${label}: ${formatInteger(count)}`;
      return item;
    }),
  );
}

stationBreakdownEl.addEventListener('click', (event) => {
  const button = event.target.closest('.mode-pill[data-mode]');
  if (!button || !stationBreakdownEl.contains(button)) return;

  const { mode } = button.dataset;
  const isActive = button.getAttribute('aria-pressed') === 'true';
  const nextActive = !isActive;

  button.setAttribute('aria-pressed', String(nextActive));
  button.title = `${nextActive ? 'Hide' : 'Show'} ${MODE_LABELS[mode] ?? mode} stations`;

  if (nextActive) {
    activeStationModes.add(mode);
  } else {
    activeStationModes.delete(mode);
  }

  syncStationFilters();
  syncStreetColor();
  updateViewportStatistics();

  if (selectedStreetProperties) {
    showStreetFeature(selectedStreetProperties);
  }
});

function metadataBounds(metadata) {
  const bounds = metadata.bbox;
  if (
    !bounds ||
    !Number.isFinite(bounds.west) ||
    !Number.isFinite(bounds.south) ||
    !Number.isFinite(bounds.east) ||
    !Number.isFinite(bounds.north)
  ) {
    return null;
  }

  return [
    [bounds.west, bounds.south],
    [bounds.east, bounds.north],
  ];
}

function applyMapBounds(metadata) {
  const bounds = metadataBounds(metadata);
  if (!bounds) return;

  const leftPadding = window.innerWidth >= 760 ? 360 : 48;

  map.setMaxBounds(bounds);
  map.fitBounds(bounds, {
    padding: {
      top: 48,
      right: 48,
      bottom: 48,
      left: leftPadding,
    },
    duration: 0,
  });
}

function renderDetails(details) {
  featureMetadataEl.replaceChildren(
    ...details
      .filter((detail) => detail.value)
      .map((detail) => {
        const term = document.createElement('dt');
        term.textContent = detail.label;

        const description = document.createElement('dd');
        description.textContent = detail.value;

        const fragment = document.createDocumentFragment();
        fragment.append(term, description);
        return fragment;
      }),
  );
}

function showStreetFeature(props) {
  const streetName = props.n || props.h || 'Unnamed street';
  selectedStreetProperties = props;
  selectionTypeEl.textContent = 'Selected street';
  featureNameEl.textContent = streetName;

  if (activeStationModes.size === 0) {
    featureSummaryEl.textContent = 'No station types selected';
  } else {
    let distance = Number.POSITIVE_INFINITY;

    if (activeStationModes.size === allStationModes.size) {
      distance = Number(props.d);
    } else {
      for (const mode of activeStationModes) {
        const value = Number(props[MODE_DISTANCE_PROPERTIES[mode]]);
        if (Number.isFinite(value)) distance = Math.min(distance, value);
      }
    }

    if (futureStationToggle.checked) {
      for (const mode of activeStationModes) {
        const value = Number(props[FUTURE_MODE_DISTANCE_PROPERTIES[mode]]);
        if (Number.isFinite(value)) distance = Math.min(distance, value);
      }
    }

    const distanceLabel =
      !Number.isFinite(distance) || distance > maxDistanceMeters
        ? `More than ${formatDistance(maxDistanceMeters)}`
        : formatDistance(distance);
    featureSummaryEl.textContent = `${distanceLabel} from nearest selected station`;
  }

  renderDetails([
    { label: 'OSM highway', value: props.h },
  ]);
}

function showStationFeature(props) {
  selectedStreetProperties = null;
  selectionTypeEl.textContent = 'Selected station';
  featureNameEl.textContent = props.name || 'Unnamed station';
  featureSummaryEl.textContent = props.system || MODE_LABELS[props.mode] || 'Transit station';
  renderDetails([
    { label: 'Status', value: props.status_detail || props.status },
    { label: 'Mode', value: props.system || MODE_LABELS[props.mode] },
    { label: 'Network', value: props.network },
    { label: 'Operator', value: props.operator },
    { label: 'Ref', value: props.local_ref || props.route_ref || props.ref },
    { label: 'Route', value: props.route_name || props.route_relation },
    { label: 'Stop tag', value: props.highway || props.public_transport },
    { label: 'Opening', value: props.opening_date },
    { label: 'OSM', value: props.id },
  ]);
}

function installHover() {
  let hoveredId = null;
  const stationLayerIds = ['station-points-open', 'station-points-future'];

  map.on('mousemove', 'street-proximity', (event) => {
    const feature = event.features?.[0];
    if (!feature) return;

    if (hoveredId !== null) {
      map.setFeatureState({ source: 'streets', id: hoveredId }, { hover: false });
    }

    hoveredId = feature.id;
    map.setFeatureState({ source: 'streets', id: hoveredId }, { hover: true });

    showStreetFeature(feature.properties);
    map.getCanvas().style.cursor = 'pointer';
  });

  map.on('mouseleave', 'street-proximity', () => {
    if (hoveredId !== null) {
      map.setFeatureState({ source: 'streets', id: hoveredId }, { hover: false });
    }
    hoveredId = null;
    map.getCanvas().style.cursor = '';
  });

  map.on('click', 'street-proximity', (event) => {
    const feature = event.features?.[0];
    if (feature) showStreetFeature(feature.properties);
  });

  for (const layerId of stationLayerIds) {
    map.on('mousemove', layerId, (event) => {
      const feature = event.features?.[0];
      if (!feature) return;

      showStationFeature(feature.properties);
      map.getCanvas().style.cursor = 'pointer';
    });

    map.on('mouseleave', layerId, () => {
      map.getCanvas().style.cursor = '';
    });

    map.on('click', layerId, (event) => {
      const feature = event.features?.[0];
      if (feature) showStationFeature(feature.properties);
    });
  }
}

async function initialize() {
  try {
    const [streets, streetModeDistanceData, stations, metadata] = await Promise.all([
      fetchJson(DATASETS.streets),
      fetchJson(DATASETS.streetModeDistances),
      fetchJson(DATASETS.stations),
      fetchJson(DATASETS.metadata),
    ]);

    attachStreetModeDistances(streets, streetModeDistanceData);
    initializeStatisticsData(streets, stations);
    renderMetadata(metadata);
    applyMapBounds(metadata);

    const labelLayerId = firstSymbolLayerId();

    map.addSource('streets', {
      type: 'geojson',
      data: streets,
      generateId: true,
    });

    map.addSource('stations', {
      type: 'geojson',
      data: stations,
      generateId: true,
    });

    map.addLayer(
      {
        id: 'street-proximity',
        type: 'line',
        source: 'streets',
        paint: {
          'line-color': streetColorExpression(),
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            9,
            0.75,
            12,
            1.8,
            15,
            4.2,
          ],
          'line-opacity': [
            'case',
            ['boolean', ['feature-state', 'hover'], false],
            1,
            0.78,
          ],
        },
      },
      labelLayerId,
    );

    map.addLayer({
      id: 'station-points-open',
      type: 'circle',
      source: 'stations',
      filter: openStationFilter,
      paint: {
        'circle-color': stationColor,
        'circle-stroke-color': '#18222c',
        'circle-stroke-width': 1.5,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 3, 13, 6],
      },
    });

    map.addLayer({
      id: 'station-points-future',
      type: 'circle',
      source: 'stations',
      filter: futureStationFilter,
      layout: {
        visibility: 'none',
      },
      paint: {
        'circle-color': stationColor,
        'circle-opacity': 0.42,
        'circle-stroke-color': COLORS.future,
        'circle-stroke-width': 2,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 3.5, 13, 7],
      },
    });

    map.addLayer({
      id: 'station-labels-open',
      type: 'symbol',
      source: 'stations',
      filter: openStationFilter,
      minzoom: 11.4,
      layout: {
        'text-field': ['get', 'name'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 11.4, 10, 15, 13],
        'text-offset': [0, 1.2],
        'text-anchor': 'top',
        'text-allow-overlap': false,
        'text-optional': true,
      },
      paint: {
        'text-color': '#18222c',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.2,
      },
    });

    map.addLayer({
      id: 'station-labels-future',
      type: 'symbol',
      source: 'stations',
      filter: futureStationFilter,
      minzoom: 10.8,
      layout: {
        visibility: 'none',
        'text-field': ['concat', ['get', 'name'], ' (future)'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 10.8, 10, 15, 13],
        'text-offset': [0, 1.25],
        'text-anchor': 'top',
        'text-allow-overlap': false,
        'text-optional': true,
      },
      paint: {
        'text-color': '#334155',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.2,
        'text-opacity': 0.8,
      },
    });

    installHover();
    syncStationFilters();
    syncStationVisibility();
    updateViewportStatistics();
    updateStatus('Ready');
  } catch (error) {
    console.error(error);
    updateStatus('Data missing', true);
    featureSummaryEl.textContent = 'Run npm run build:data:cdmx, then refresh.';
  }
}

streetToggle.addEventListener('change', () => {
  setLayerVisibility('street-proximity', streetToggle.checked);
  updateViewportStatistics();
});

stationToggle.addEventListener('change', () => {
  syncStationVisibility();
  updateViewportStatistics();
});

futureStationToggle.addEventListener('change', () => {
  syncStationVisibility();
  syncStreetColor();
  updateViewportStatistics();

  if (selectedStreetProperties) {
    showStreetFeature(selectedStreetProperties);
  }
});

map.on('moveend', updateViewportStatistics);
map.on('load', initialize);
