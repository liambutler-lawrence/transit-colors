const DATASETS = {
  basemapStyle: 'vendor/openfreemap-liberty.json',
  streetTiles: 'data/cdmx-streets.pmtiles',
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

const pmtilesProtocol = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', pmtilesProtocol.tile);

const map = new maplibregl.Map({
  container: 'map',
  style: 'vendor/openfreemap-shell.json',
  center: [-99.1332, 19.4326],
  zoom: 10.5,
});
window.__transitMap = map;

map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

const statusEl = document.querySelector('#status');
const mapEl = document.querySelector('#map');
const mapLoadingEl = document.querySelector('#map-loading');
const mapLoadingLabelEl = document.querySelector('#map-loading-label');
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
let allModesNearCount = 0;
let nearCountModeOrder = Object.keys(MODE_DISTANCE_PROPERTIES);
let nearCountsByModeSelection = {};
let selectedStreetProperties = null;
let streetSourceLoaded = false;
let pendingBasemapStyle = null;
let basemapInstallScheduled = false;
let loadingOperation = {
  type: 'initial',
  label: 'Loading map',
  startedAt: performance.now(),
};
let initialLoadComplete = false;
let loadingCanFinish = false;

window.__transitPerformance = {
  startedAt: loadingOperation.startedAt,
  initialReadyMs: null,
  styleLoadedMs: null,
  dataFetchedMs: null,
  firstStreetRenderMs: null,
  lastInteractionMs: null,
  operations: [],
};

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
  if (activeStationModes.size === allStationModes.size) {
    return ['get', 'd'];
  }

  const modeDistances = [...activeStationModes]
    .map((mode) => MODE_DISTANCE_PROPERTIES[mode])
    .filter(Boolean)
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

function syncNearCount() {
  const selectionKey = nearCountModeOrder
    .filter((mode) => activeStationModes.has(mode))
    .join(',');
  const nearCount = nearCountsByModeSelection[selectionKey];

  nearCountEl.textContent = Number.isFinite(nearCount)
    ? formatInteger(nearCount)
    : formatInteger(allModesNearCount);
}

function updateStatus(label, { isError = false, isLoading = false } = {}) {
  statusEl.textContent = label;
  statusEl.classList.toggle('error', isError);
  statusEl.classList.toggle('loading', isLoading);
}

function beginLoading(label, type) {
  loadingOperation = {
    type,
    label,
    startedAt: performance.now(),
  };
  loadingCanFinish = false;
  updateStatus(label, { isLoading: true });
  mapLoadingLabelEl.textContent = `${label}…`;
  mapLoadingEl.hidden = false;
  mapEl.setAttribute('aria-busy', 'true');
}

function finishLoading() {
  if (!loadingOperation || !loadingCanFinish) return;

  const completedOperation = {
    ...loadingOperation,
    durationMs: performance.now() - loadingOperation.startedAt,
  };
  window.__transitPerformance.operations.push(completedOperation);

  if (completedOperation.type === 'initial') {
    initialLoadComplete = true;
    window.__transitPerformance.initialReadyMs = completedOperation.durationMs;
    scheduleBasemapInstall();
  } else {
    window.__transitPerformance.lastInteractionMs = completedOperation.durationMs;
  }

  loadingOperation = null;
  loadingCanFinish = false;
  updateStatus('Ready');
  mapLoadingEl.hidden = true;
  mapEl.setAttribute('aria-busy', 'false');
  window.dispatchEvent(
    new CustomEvent('transit:ready', { detail: completedOperation }),
  );
}

function installBasemap() {
  if (!pendingBasemapStyle) return;

  try {
    for (const [sourceId, source] of Object.entries(pendingBasemapStyle.sources ?? {})) {
      if (!map.getSource(sourceId)) map.addSource(sourceId, source);
    }

    for (const layer of pendingBasemapStyle.layers ?? []) {
      if (layer.type !== 'background' && !map.getLayer(layer.id)) {
        const beforeLayer =
          layer.type === 'symbol' ? 'station-points-open' : 'street-proximity';
        map.addLayer(layer, beforeLayer);
      }
    }
  } catch (error) {
    console.error('Basemap could not be installed.', error);
  } finally {
    pendingBasemapStyle = null;
  }
}

function scheduleBasemapInstall() {
  if (!pendingBasemapStyle || basemapInstallScheduled) return;
  basemapInstallScheduled = true;
  setTimeout(installBasemap, 1000);
}

function runMapUpdate(label, callback) {
  beginLoading(label, 'filter');
  callback();

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      loadingCanFinish = true;
      finishLoading();
    });
  });
}

function renderMetadata(metadata) {
  const streetCount = metadata.street_count ?? 0;
  const stationCount = metadata.open_station_count ?? metadata.station_count ?? 0;
  const futureStationCount = metadata.future_station_count ?? 0;
  const nearCount = metadata.histogram?.under_2500_m ?? 0;

  maxDistanceMeters = metadata.max_distance_m ?? maxDistanceMeters;
  allModesNearCount = nearCount;
  nearCountModeOrder =
    metadata.near_count_mode_order ?? Object.keys(MODE_DISTANCE_PROPERTIES);
  nearCountsByModeSelection = metadata.near_counts_by_mode_selection ?? {};

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
    ...[
      futureStationCount > 0
        ? (() => {
            const item = document.createElement('span');
            item.className = 'mode-pill future-mode-pill';
            item.style.setProperty('--mode-color', COLORS.future);
            item.textContent = `Future: ${formatInteger(futureStationCount)}`;
            return item;
          })()
        : null,
    ].filter(Boolean),
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

  runMapUpdate('Updating filter', () => {
    syncStationFilters();
    syncStreetColor();
    syncNearCount();

    if (selectedStreetProperties) {
      showStreetFeature(selectedStreetProperties);
    }
  });
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
      map.setFeatureState(
        { source: 'streets', sourceLayer: 'streets', id: hoveredId },
        { hover: false },
      );
    }

    hoveredId = feature.id;
    map.setFeatureState(
      { source: 'streets', sourceLayer: 'streets', id: hoveredId },
      { hover: true },
    );

    showStreetFeature(feature.properties);
    map.getCanvas().style.cursor = 'pointer';
  });

  map.on('mouseleave', 'street-proximity', () => {
    if (hoveredId !== null) {
      map.setFeatureState(
        { source: 'streets', sourceLayer: 'streets', id: hoveredId },
        { hover: false },
      );
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
    const [stations, metadata, basemapStyle] = await Promise.all([
      fetchJson(DATASETS.stations),
      fetchJson(DATASETS.metadata),
      fetchJson(DATASETS.basemapStyle),
    ]);
    pendingBasemapStyle = basemapStyle;
    window.__transitPerformance.dataFetchedMs =
      performance.now() - window.__transitPerformance.startedAt;

    renderMetadata(metadata);
    applyMapBounds(metadata);

    const labelLayerId = firstSymbolLayerId();
    const streetTilesUrl = new URL(
      metadata.street_tiles_file ?? DATASETS.streetTiles,
      window.location.href,
    ).href;

    map.addSource('streets', {
      type: 'vector',
      url: `pmtiles://${streetTilesUrl}`,
      attribution: '© OpenStreetMap contributors',
      promoteId: 'i',
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
        'source-layer': 'streets',
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
    loadingCanFinish = true;
  } catch (error) {
    console.error(error);
    loadingOperation = null;
    updateStatus('Data missing', { isError: true });
    mapLoadingLabelEl.textContent = 'Map data could not be loaded';
    mapEl.setAttribute('aria-busy', 'false');
    featureSummaryEl.textContent = 'Run npm run build:data:cdmx, then refresh.';
  }
}

streetToggle.addEventListener('change', () => {
  runMapUpdate('Updating layers', () => {
    setLayerVisibility('street-proximity', streetToggle.checked);
  });
});

stationToggle.addEventListener('change', () => {
  runMapUpdate('Updating layers', syncStationVisibility);
});

futureStationToggle.addEventListener('change', () => {
  runMapUpdate('Updating layers', syncStationVisibility);
});

map.on('sourcedataloading', (event) => {
  if (event.sourceId !== 'streets' || !initialLoadComplete) return;

  if (!loadingOperation) {
    streetSourceLoaded = false;
    beginLoading('Loading area', 'area');
    loadingCanFinish = true;
  }
});

map.on('sourcedata', (event) => {
  if (
    event.sourceId === 'streets' &&
    event.isSourceLoaded
  ) {
    streetSourceLoaded = true;
  }
});

map.on('idle', finishLoading);
map.on('render', () => {
  if (
    window.__transitPerformance.firstStreetRenderMs === null &&
    map.getLayer('street-proximity') &&
    map.queryRenderedFeatures({ layers: ['street-proximity'] }).length > 0
  ) {
    window.__transitPerformance.firstStreetRenderMs =
      performance.now() - window.__transitPerformance.startedAt;
  }

  if (streetSourceLoaded && loadingOperation?.type !== 'filter') {
    loadingCanFinish = true;
    finishLoading();
  }
});
map.once('style.load', () => {
  window.__transitPerformance.styleLoadedMs =
    performance.now() - window.__transitPerformance.startedAt;
  initialize();
});
