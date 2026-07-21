import {
  DEFAULT_TIME_SCALE_MINUTES,
  WALKING_METERS_PER_MINUTE,
  assignNearestStations,
  buildTransitGraph,
  calculateTransitTimes,
  scheduledWaitForStation,
  streetTravelTime,
  timeScaleStops,
} from './routing.js?v=20260721b';

const AREAS = {
  cdmx: {
    label: 'Mexico City',
    center: [-99.1332, 19.4326],
    zoom: 10.5,
    streetTiles: 'data/cdmx-streets.pmtiles',
    stations: 'data/cdmx-stations.geojson',
    metadata: 'data/cdmx-metadata.json',
    schedules: 'data/cdmx-schedules.json',
    timezone: 'America/Mexico_City',
    supportsDestination: true,
    buildCommand: 'npm run build:data:cdmx',
  },
  nyc: {
    label: 'New York City metro',
    center: [-73.98, 40.75],
    zoom: 9.5,
    liveRoads: true,
    stations: 'data/nyc-stations.geojson',
    metadata: 'data/nyc-metadata.json',
    schedules: 'data/nyc-schedules.json',
    timezone: 'America/New_York',
    supportsDestination: true,
    buildCommand: 'npm run build:data:nyc',
  },
};

const requestedAreaKey = new URLSearchParams(window.location.search).get('area');
const initialAreaKey = Object.hasOwn(AREAS, requestedAreaKey) ? requestedAreaKey : 'cdmx';

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

const appShellEl = document.querySelector('.app-shell');
const panelToggleButton = document.querySelector('#toggle-panel');
const panelToggleLabelEl = panelToggleButton.querySelector('.panel-toggle-label');
const compactPanelQuery = window.matchMedia('(max-width: 680px)');
let panelCollapsePreference = null;
let panelCollapsed = compactPanelQuery.matches;

function renderPanelState() {
  appShellEl.classList.toggle('panel-collapsed', panelCollapsed);
  panelToggleButton.setAttribute('aria-expanded', String(!panelCollapsed));
  panelToggleButton.setAttribute(
    'aria-label',
    panelCollapsed ? 'Show controls' : 'Hide controls',
  );
  panelToggleButton.title = panelCollapsed ? 'Show controls' : 'Hide controls';
  panelToggleLabelEl.textContent = panelCollapsed ? 'Show controls' : 'Hide controls';
}

renderPanelState();

const map = new maplibregl.Map({
  container: 'map',
  style: 'vendor/openfreemap-shell.json',
  center: AREAS[initialAreaKey].center,
  zoom: AREAS[initialAreaKey].zoom,
  maxZoom: 17,
});
window.__transitMap = map;

const FUTURE_MODE_DISTANCE_PROPERTIES = {
  subway: 'fs',
  brt: 'fb',
  light_rail: 'fl',
  cable_car: 'fc',
  commuter_rail: 'ft',
  regional_rail: 'fr',
  monorail: 'fm',
};

map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

const statusEl = document.querySelector('#status');
const mapEl = document.querySelector('#map');
const mapLoadingEl = document.querySelector('#map-loading');
const mapLoadingLabelEl = document.querySelector('#map-loading-label');
const streetCountEl = document.querySelector('#street-count');
const stationCountEl = document.querySelector('#station-count');
const nearCountEl = document.querySelector('#near-count');
const nearCountLabelEl = document.querySelector('#near-count-label');
const legendEl = document.querySelector('#legend');
const legendLabelsEl = document.querySelector('#legend-labels');
const stationBreakdownEl = document.querySelector('#station-breakdown');
const destinationSelect = document.querySelector('#destination-select');
const destinationSummaryEl = document.querySelector('#destination-summary');
const scheduleDaySelect = document.querySelector('#schedule-day');
const scheduleTimeInput = document.querySelector('#schedule-time');
const scheduleSummaryEl = document.querySelector('#schedule-summary');
const timeScaleInput = document.querySelector('#time-scale-minutes');
const timeScaleSummaryEl = document.querySelector('#time-scale-summary');
const destinationControlEl = document.querySelector('.destination-control');
const departureControlEl = document.querySelector('.departure-control');
const timeScaleControlEl = document.querySelector('.time-scale-control');
const selectionTypeEl = document.querySelector('#selection-type');
const featureNameEl = document.querySelector('#feature-name');
const featureSummaryEl = document.querySelector('#feature-summary');
const featureMetadataEl = document.querySelector('#feature-metadata');
const streetToggle = document.querySelector('#toggle-streets');
const stationToggle = document.querySelector('#toggle-stations');
const futureStationToggle = document.querySelector('#toggle-future-stations');
const areaSelect = document.querySelector('#metro-area');

function setPanelCollapsed(nextCollapsed, { remember = true } = {}) {
  panelCollapsed = nextCollapsed;
  if (remember) panelCollapsePreference = nextCollapsed;
  renderPanelState();
}

panelToggleButton.addEventListener('click', () => {
  setPanelCollapsed(!panelCollapsed);
});

compactPanelQuery.addEventListener('change', (event) => {
  if (panelCollapsePreference === null) {
    setPanelCollapsed(event.matches, { remember: false });
  }
});

new ResizeObserver(() => {
  map.resize();
  if (map.loaded()) updateViewportStatistics();
}).observe(mapEl);

let activeAreaKey = initialAreaKey;
let loadSequence = 0;
let loadedStations = { type: 'FeatureCollection', features: [] };
let liveStreetRefreshTimer = null;
let liveStreetRefreshSequence = 0;
let liveStreetRefreshInFlight = false;
let liveStreetRefreshPending = false;

const LIVE_ROAD_CLASSES = new Set([
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'minor',
  'service',
  'track',
]);

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
const openStationLayers = [
  'station-points-open',
  'station-destination',
  'station-labels-open',
];
const filterableOpenStationLayers = [
  'station-points-open',
  'station-labels-open',
];
const futureStationLayers = ['station-points-future', 'station-labels-future'];
const activeStationModes = new Set();
const allStationModes = new Set();
let maxDistanceMeters = 5000;
let selectedStreetProperties = null;
let streetSourceLoaded = false;
let pendingBasemapStyle = null;
let basemapInstallScheduled = false;
let basemapInstalled = false;
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

const state = {
  metadata: null,
  stationById: new Map(),
  transitGraph: null,
  transitTimes: null,
  destination: null,
  destinationChoiceByStationId: new Map(),
  schedules: null,
  scheduleWeekday: 0,
  scheduleMinute: 8 * 60,
  waitMinutesByStation: new Map(),
  waitDetailsByStation: new Map(),
  timeScaleMinutes: DEFAULT_TIME_SCALE_MINUTES,
};

const WEEKDAY_LABELS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

function formatInteger(value) {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatDistance(meters) {
  if (!Number.isFinite(meters)) return '--';
  if (meters < 950) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

function formatMinutes(minutes) {
  if (!Number.isFinite(minutes)) return '--';
  if (minutes < 10) return `${Math.round(minutes)} min`;
  if (minutes >= 90) {
    const roundedMinutes = Math.round(minutes / 5) * 5;
    const hours = Math.floor(roundedMinutes / 60);
    const remainder = roundedMinutes % 60;
    return remainder > 0 ? `${hours} hr ${remainder} min` : `${hours} hr`;
  }
  return `${Math.round(minutes / 5) * 5} min`;
}

function formatTimeInput(minutes) {
  const hours = Math.floor(minutes / 60);
  const remainder = Math.round(minutes % 60);
  return `${String(hours).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function currentDeparture(timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date())
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  const weekdayByShortName = {
    Mon: 0,
    Tue: 1,
    Wed: 2,
    Thu: 3,
    Fri: 4,
    Sat: 5,
    Sun: 6,
  };

  return {
    weekday: weekdayByShortName[parts.weekday] ?? 0,
    minute: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function setCurrentDeparture(area) {
  const departure = currentDeparture(area.timezone);
  state.scheduleWeekday = departure.weekday;
  state.scheduleMinute = departure.minute;
  scheduleDaySelect.value = String(departure.weekday);
  scheduleTimeInput.value = formatTimeInput(departure.minute);
}

function departureLabel() {
  return `${WEEKDAY_LABELS[state.scheduleWeekday]} at ${formatTimeInput(
    state.scheduleMinute,
  )}`;
}

function timeStreetColor(transitTimes, scaleMinutes) {
  const stops = timeScaleStops(scaleMinutes);
  const stationTime = ['match', ['get', 's']];

  for (const [stationId, minutes] of transitTimes) {
    stationTime.push(stationId, Number(minutes.toFixed(2)));
  }
  stationTime.push(90);

  return [
    'interpolate',
    ['linear'],
    [
      '+',
      ['/', ['to-number', ['get', 'd']], WALKING_METERS_PER_MINUTE],
      stationTime,
    ],
    0,
    COLORS.near,
    stops.yellowMinutes,
    COLORS.midNear,
    stops.orangeMinutes,
    COLORS.midFar,
    stops.redMinutes,
    COLORS.far,
  ];
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
  for (const layerId of filterableOpenStationLayers) {
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
  if (AREAS[activeAreaKey].liveRoads) return ['get', 'd'];

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

function activeStationCollection() {
  return {
    type: 'FeatureCollection',
    features: (loadedStations.features ?? []).filter(
      (feature) =>
        activeStationModes.has(feature.properties.mode) &&
        (feature.properties.status === 'open' || futureStationToggle.checked),
    ),
  };
}

function activeStreetLayerId() {
  return AREAS[activeAreaKey].liveRoads
    ? 'live-street-proximity'
    : 'street-proximity';
}

function activeStreetSourceId() {
  return AREAS[activeAreaKey].liveRoads ? 'live-streets' : 'streets';
}

function syncStreetColor() {
  const layerId = activeStreetLayerId();
  if (map.getLayer(layerId)) {
    map.setPaintProperty(
      layerId,
      'line-color',
      state.destination && state.transitTimes
        ? timeStreetColor(state.transitTimes, state.timeScaleMinutes)
        : streetColorExpression(),
    );
  }
}

function streetDistanceFromProperties(properties) {
  if (AREAS[activeAreaKey].liveRoads) return Number(properties.d);

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

  let distance = Number.POSITIVE_INFINITY;
  for (const property of distanceProperties) {
    const value = Number(properties[property]);
    if (Number.isFinite(value)) distance = Math.min(distance, value);
  }
  return distance;
}

function visibleTiledStreets() {
  const layerId = activeStreetLayerId();
  const sourceId = activeStreetSourceId();
  if (
    !streetToggle.checked ||
    !map.getLayer(layerId) ||
    !map.getSource(sourceId) ||
    !map.isSourceLoaded(sourceId)
  ) {
    return [];
  }

  const byId = new Map();
  for (const feature of map.queryRenderedFeatures({ layers: [layerId] })) {
    const key = feature.properties?.i ?? feature.id;
    if (key !== undefined && !byId.has(key)) byId.set(key, feature.properties ?? {});
  }
  return [...byId.values()];
}

function updateViewportStatistics(tiledStreets = null) {
  const bounds = map.getBounds();
  const timeStops = timeScaleStops(state.timeScaleMinutes);
  const timeMode = state.destination && state.transitTimes;

  let visibleStationCount = 0;
  if (stationToggle.checked) {
    for (const feature of loadedStations.features ?? []) {
      const [lon, lat] = feature.geometry?.coordinates ?? [];
      const properties = feature.properties ?? {};
      const statusVisible =
        properties.status === 'open' || futureStationToggle.checked;
      if (
        statusVisible &&
        activeStationModes.has(properties.mode) &&
        bounds.contains([lon, lat])
      ) {
        visibleStationCount += 1;
      }
    }
  }
  stationCountEl.textContent = formatInteger(visibleStationCount);

  const sourceId = activeStreetSourceId();
  if (
    streetToggle.checked &&
    (!map.getSource(sourceId) || !map.isSourceLoaded(sourceId))
  ) {
    streetCountEl.textContent = '--';
    nearCountEl.textContent = '--';
    return;
  }

  const streets = tiledStreets ?? visibleTiledStreets();
  let nearCount = 0;
  for (const properties of streets) {
    const isNear = timeMode
      ? streetTravelTime(properties, state.transitTimes).totalMinutes <=
        timeStops.orangeMinutes
      : streetDistanceFromProperties(properties) <= 2500;
    if (isNear) nearCount += 1;
  }

  nearCountLabelEl.textContent = timeMode
    ? `Within ${timeStops.orangeMinutes} min`
    : 'Within 2.5 km';
  streetCountEl.textContent = formatInteger(streets.length);
  nearCountEl.textContent = formatInteger(nearCount);
}

function syncStreetVisibility() {
  const visible = streetToggle.checked;
  setLayerVisibility(
    'street-proximity',
    visible && !AREAS[activeAreaKey].liveRoads,
  );
  setLayerVisibility(
    'live-street-proximity',
    visible && AREAS[activeAreaKey].liveRoads,
  );
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
    basemapInstalled = true;
    if (AREAS[activeAreaKey].liveRoads) {
      scheduleLiveStreetRefresh();
      syncStreetVisibility();
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

function setLegend(mode) {
  const stops = timeScaleStops(state.timeScaleMinutes);
  const labels =
    mode === 'time'
      ? [
          '0 min',
          String(stops.yellowMinutes),
          String(stops.orangeMinutes),
          `${stops.redMinutes}+ min`,
        ]
      : ['0 km', '1', '2.5', '5 km'];
  legendEl.setAttribute(
    'aria-label',
    mode === 'time' ? 'Estimated travel time legend' : 'Distance legend',
  );
  legendEl.classList.toggle('time', mode === 'time');
  legendLabelsEl.replaceChildren(
    ...labels.map((label) => {
      const item = document.createElement('span');
      item.textContent = label;
      return item;
    }),
  );
}

function renderMetadata(metadata) {
  const streetCount = metadata.street_count ?? 0;
  const stationCount = metadata.open_station_count ?? metadata.station_count ?? 0;
  const futureStationCount = metadata.future_station_count ?? 0;
  const nearCount = metadata.histogram?.under_2500_m ?? 0;

  maxDistanceMeters = metadata.max_distance_m ?? maxDistanceMeters;

  streetCountEl.textContent = metadata.street_count == null ? 'Live' : formatInteger(streetCount);
  stationCountEl.textContent = formatInteger(stationCount);
  nearCountEl.textContent = metadata.histogram ? formatInteger(nearCount) : 'Live';
  futureStationToggle.disabled = futureStationCount === 0;
  if (futureStationCount === 0) futureStationToggle.checked = false;

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

  runMapUpdate('Updating filter', () => {
    syncStationFilters();
    if (AREAS[activeAreaKey].liveRoads) {
      scheduleLiveStreetRefresh();
    } else {
      syncStreetColor();
    }
    updateViewportStatistics();

    if (selectedStreetProperties) {
      showStreetFeature(selectedStreetProperties);
    }
  });
});

function renderDestinationOptions(stationFeatures) {
  const nearestOption = document.createElement('option');
  nearestOption.value = '';
  nearestOption.textContent = 'Nearest station only';
  destinationSelect.replaceChildren(nearestOption);
  state.destinationChoiceByStationId.clear();

  const destinationChoices = new Map();
  const openStations = stationFeatures
    .filter((feature) => feature.properties.status === 'open')
    .filter((feature) => feature.properties.name)
    .sort((first, second) =>
      (first.properties.name || 'Unnamed station').localeCompare(
        second.properties.name || 'Unnamed station',
        'es',
      ),
    );

  for (const feature of openStations) {
    const properties = feature.properties;
    const key = `${properties.name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()}|${properties.mode}`;
    const representative = destinationChoices.get(key) ?? feature;
    destinationChoices.set(key, representative);
    state.destinationChoiceByStationId.set(
      properties.id,
      representative.properties.id,
    );
  }

  const options = [...destinationChoices.values()].map((feature) => {
    const option = document.createElement('option');
    const properties = feature.properties;
    option.value = properties.id;
    option.textContent = `${properties.name || 'Unnamed station'} — ${
      properties.system || MODE_LABELS[properties.mode] || 'Transit'
    }`;
    return option;
  });

  destinationSelect.append(...options);
  destinationSelect.disabled = false;
}

function resetDestinationRouting() {
  state.metadata = null;
  state.stationById.clear();
  state.transitGraph = null;
  state.transitTimes = null;
  state.destination = null;
  state.destinationChoiceByStationId.clear();
  state.schedules = null;
  state.waitMinutesByStation.clear();
  state.waitDetailsByStation.clear();

  const nearestOption = document.createElement('option');
  nearestOption.value = '';
  nearestOption.textContent = 'Nearest station only';
  destinationSelect.replaceChildren(nearestOption);
  destinationSelect.disabled = true;
  destinationSummaryEl.textContent =
    'Choose a station here or click an open station on the map.';
  scheduleSummaryEl.textContent = 'Loading official weekly schedules…';
  setLegend('distance');

  if (map.getLayer('station-destination')) {
    map.setFilter('station-destination', ['==', ['get', 'id'], '']);
  }
}

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

  const padding = compactPanelQuery.matches ? 24 : 48;

  map.setMaxBounds(null);
  map.setMaxBounds(bounds);
  map.fitBounds(bounds, {
    padding,
    duration: 0,
  });
}

function resetSelection() {
  selectedStreetProperties = null;
  selectionTypeEl.textContent = 'Selected feature';
  featureNameEl.textContent = 'None';
  featureSummaryEl.textContent = 'Hover a highlighted street or station';
  featureMetadataEl.replaceChildren();
}

function updateAreaChrome(areaKey) {
  const area = AREAS[areaKey];
  areaSelect.value = areaKey;
  document.title = `Transit Colors — ${area.label}`;
  mapEl.setAttribute(
    'aria-label',
    area.supportsDestination
      ? `${area.label} transit access and travel time map`
      : `${area.label} transit proximity map`,
  );
  destinationControlEl.hidden = !area.supportsDestination;
  departureControlEl.hidden = !area.supportsDestination;
  timeScaleControlEl.hidden = !area.supportsDestination;

  const url = new URL(window.location.href);
  if (areaKey === 'cdmx') {
    url.searchParams.delete('area');
  } else {
    url.searchParams.set('area', areaKey);
  }
  window.history.replaceState({}, '', url);
}

function renderDetails(details) {
  featureMetadataEl.replaceChildren(
    ...details
      .filter(
        (detail) =>
          detail.value !== undefined && detail.value !== null && detail.value !== '',
      )
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

  if (state.destination && state.transitTimes) {
    const travel = streetTravelTime(props, state.transitTimes);
    const accessStation = state.stationById.get(props.s)?.properties;
    const waitDetails = state.waitDetailsByStation.get(props.s);
    const boardingWait = travel.transitMinutes > 0 ? waitDetails?.minutes ?? 0 : 0;
    featureSummaryEl.textContent = `${formatMinutes(travel.totalMinutes)} estimated to ${
      state.destination.properties.name
    }`;
    renderDetails([
      { label: 'Access station', value: accessStation?.name },
      {
        label: 'Access walk',
        value: `${formatMinutes(travel.walkingMinutes)} (${formatDistance(props.d)})`,
      },
      {
        label: 'Boarding wait',
        value:
          travel.transitMinutes === 0
            ? 'None — destination is the access station'
            : waitDetails?.scheduled
              ? `${formatMinutes(boardingWait)} (official weekly headway)`
              : `${formatMinutes(boardingWait)} (estimated)`,
      },
      {
        label: 'Ride + transfers',
        value: formatMinutes(Math.max(0, travel.transitMinutes - boardingWait)),
      },
      { label: 'OSM highway', value: props.h },
    ]);
    return;
  }

  if (activeStationModes.size === 0) {
    featureSummaryEl.textContent = 'No station types selected';
  } else {
    let distance = Number.POSITIVE_INFINITY;

    if (AREAS[activeAreaKey].liveRoads) {
      distance = Number(props.d);
    } else if (activeStationModes.size === allStationModes.size) {
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
    { label: 'Road class', value: props.class },
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
    { label: props.id?.startsWith('gtfs/') ? 'GTFS' : 'OSM', value: props.id },
  ]);
}

function updateDestinationSummary() {
  if (!state.destination) return;
  destinationSummaryEl.textContent = `Color shows access walk + schedule-adjusted transit to ${
    state.destination.properties.name
  }, departing ${departureLabel()}.`;
}

function applyScheduleContext() {
  if (!state.transitGraph) return;

  const waitMinutesByStation = new Map();
  const waitDetailsByStation = new Map();
  let scheduledStationCount = 0;

  for (const node of state.transitGraph.nodes) {
    const details = scheduledWaitForStation(
      state.schedules,
      node.id,
      state.scheduleWeekday,
      state.scheduleMinute,
    );
    waitMinutesByStation.set(node.id, details.minutes);
    waitDetailsByStation.set(node.id, details);
    if (details.scheduled) scheduledStationCount += 1;
  }

  state.waitMinutesByStation = waitMinutesByStation;
  state.waitDetailsByStation = waitDetailsByStation;
  scheduleSummaryEl.textContent = state.schedules
    ? `${state.schedules.source || 'Published GTFS'} weekly service covers ${formatInteger(
        scheduledStationCount,
      )} of ${formatInteger(
        state.transitGraph.nodes.length,
      )} open station records; the rest use a 4 min estimate.`
    : 'Schedule data unavailable; boarding waits use a 4 min estimate.';

  if (state.destination) {
    state.transitTimes = calculateTransitTimes(
      state.transitGraph,
      state.destination.properties.id,
      { waitMinutesByStation: state.waitMinutesByStation },
    );
    updateDestinationSummary();
    applyTimeScale();
  }
}

function updateScheduleContext() {
  const parsedDay = Number(scheduleDaySelect.value);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(scheduleTimeInput.value);
  if (Number.isInteger(parsedDay) && parsedDay >= 0 && parsedDay <= 6) {
    state.scheduleWeekday = parsedDay;
  }
  if (timeMatch) {
    state.scheduleMinute = Number(timeMatch[1]) * 60 + Number(timeMatch[2]);
  } else {
    scheduleTimeInput.value = formatTimeInput(state.scheduleMinute);
  }
  applyScheduleContext();
}

function applyTimeScale() {
  const stops = timeScaleStops(state.timeScaleMinutes);
  state.timeScaleMinutes = stops.yellowMinutes;
  timeScaleInput.value = String(stops.yellowMinutes);
  timeScaleSummaryEl.textContent = `Yellow at ${stops.yellowMinutes} min, orange at ${
    stops.orangeMinutes
  } min, and red at ${stops.redMinutes} min.`;

  if (!state.destination || !state.transitTimes) return;

  setLegend('time');
  syncStreetColor();
  updateViewportStatistics();
}

function updateTimeScale(value) {
  if (String(value).trim() === '') {
    timeScaleInput.value = String(state.timeScaleMinutes);
    return;
  }
  state.timeScaleMinutes = timeScaleStops(value).yellowMinutes;
  applyTimeScale();
}

function clearDestination() {
  state.destination = null;
  state.transitTimes = null;
  destinationSelect.value = '';
  destinationSummaryEl.textContent =
    'Choose a station here or click an open station on the map.';
  setLegend('distance');
  syncStreetColor();
  updateViewportStatistics();
  if (map.getLayer('station-destination')) {
    map.setFilter('station-destination', ['==', ['get', 'id'], '']);
  }
  updateStatus('Ready');
}

function selectDestination(stationId) {
  if (!stationId) {
    clearDestination();
    return;
  }

  if (!AREAS[activeAreaKey].supportsDestination || !state.transitGraph) return;

  const destinationId = state.destinationChoiceByStationId.get(stationId) ?? stationId;
  const destination = state.stationById.get(destinationId);
  if (!destination || destination.properties.status !== 'open') return;

  updateStatus('Calculating');
  const transitTimes = calculateTransitTimes(state.transitGraph, destinationId, {
    waitMinutesByStation: state.waitMinutesByStation,
  });
  state.destination = destination;
  state.transitTimes = transitTimes;
  destinationSelect.value = destinationId;
  updateDestinationSummary();
  applyTimeScale();
  map.setFilter('station-destination', ['==', ['get', 'id'], destinationId]);
  updateStatus('Destination set');
}

function installHover() {
  const stationLayerIds = ['station-points-open', 'station-points-future'];
  const streetLayers = [
    { id: 'street-proximity', source: 'streets', sourceLayer: 'streets' },
    { id: 'live-street-proximity', source: 'live-streets' },
  ];

  for (const layer of streetLayers) {
    let hoveredId = null;
    const target = (id) => ({
      source: layer.source,
      ...(layer.sourceLayer ? { sourceLayer: layer.sourceLayer } : {}),
      id,
    });

    map.on('mousemove', layer.id, (event) => {
      const feature = event.features?.[0];
      if (!feature) return;

      if (hoveredId !== null) {
        map.setFeatureState(target(hoveredId), { hover: false });
      }
      hoveredId = feature.id;
      map.setFeatureState(target(hoveredId), { hover: true });
      showStreetFeature(feature.properties);
      map.getCanvas().style.cursor = 'pointer';
    });

    map.on('mouseleave', layer.id, () => {
      if (hoveredId !== null) {
        map.setFeatureState(target(hoveredId), { hover: false });
      }
      hoveredId = null;
      map.getCanvas().style.cursor = '';
    });

    map.on('click', layer.id, (event) => {
      const feature = event.features?.[0];
      if (feature) showStreetFeature(feature.properties);
    });
  }

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
      if (!feature) return;
      showStationFeature(feature.properties);
      if (
        AREAS[activeAreaKey].supportsDestination &&
        feature.properties.status === 'open' &&
        feature.properties.name
      ) {
        selectDestination(feature.properties.id);
      }
    });
  }
}

function loadedLiveRoads() {
  const features = map.querySourceFeatures('openmaptiles', {
    sourceLayer: 'transportation',
  });
  const seen = new Set();
  const roads = [];

  for (const feature of features) {
    const properties = feature.properties ?? {};
    const roadClass = properties.class;
    if (!LIVE_ROAD_CLASSES.has(roadClass)) continue;

    const lines =
      feature.geometry?.type === 'LineString'
        ? [feature.geometry.coordinates]
        : feature.geometry?.type === 'MultiLineString'
          ? feature.geometry.coordinates
          : [];

    for (const coordinates of lines) {
      if (!Array.isArray(coordinates) || coordinates.length < 2) continue;
      const key = `${roadClass}|${properties.brunnel ?? ''}|${JSON.stringify(coordinates)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      roads.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates },
        properties: {
          n: properties.name || properties['name:latin'] || '',
          h: roadClass,
          class: roadClass,
          brunnel: properties.brunnel || '',
        },
      });
    }
  }

  return roads;
}

async function refreshLiveStreetData(refreshSequence, areaSequence) {
  if (
    refreshSequence !== liveStreetRefreshSequence ||
    areaSequence !== loadSequence ||
    !AREAS[activeAreaKey].liveRoads ||
    !map.getSource('live-streets')
  ) {
    return;
  }

  if (liveStreetRefreshInFlight) {
    liveStreetRefreshPending = true;
    return;
  }

  liveStreetRefreshInFlight = true;
  try {
    const roadFeatures = loadedLiveRoads();
    if (roadFeatures.length === 0) return;

    const activeStations = activeStationCollection().features;
    updateStatus('Indexing streets');

    if (activeStations.length > 0) {
      await assignNearestStations(roadFeatures, activeStations);
    } else {
      for (const feature of roadFeatures) {
        feature.properties.d = maxDistanceMeters;
        feature.properties.s = '';
      }
    }

    if (
      refreshSequence !== liveStreetRefreshSequence ||
      areaSequence !== loadSequence ||
      !AREAS[activeAreaKey].liveRoads
    ) {
      return;
    }

    map.getSource('live-streets').setData({
      type: 'FeatureCollection',
      features: roadFeatures,
    });
    syncStreetColor();
    syncStreetVisibility();
    updateViewportStatistics();
    updateStatus(state.destination ? 'Destination set' : 'Ready');
  } finally {
    liveStreetRefreshInFlight = false;
    if (liveStreetRefreshPending) {
      liveStreetRefreshPending = false;
      scheduleLiveStreetRefresh();
    }
  }
}

function scheduleLiveStreetRefresh() {
  if (!AREAS[activeAreaKey].liveRoads) return;

  window.clearTimeout(liveStreetRefreshTimer);
  const refreshSequence = ++liveStreetRefreshSequence;
  const areaSequence = loadSequence;
  liveStreetRefreshTimer = window.setTimeout(() => {
    const refresh = () => refreshLiveStreetData(refreshSequence, areaSequence);
    if (map.areTilesLoaded()) {
      refresh();
    } else {
      map.once('idle', refresh);
    }
  }, 120);
}

function installMapData(stations) {
  const existingStations = map.getSource('stations');

  if (existingStations) {
    existingStations.setData(stations);
    return;
  }

  const labelLayerId = firstSymbolLayerId();
  const streetTilesUrl = new URL(AREAS.cdmx.streetTiles, window.location.href).href;

  map.addSource('streets', {
    type: 'vector',
    url: `pmtiles://${streetTilesUrl}`,
    attribution: '© OpenStreetMap contributors',
    promoteId: 'i',
  });

  map.addSource('live-streets', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
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
      'source-layer': 'streets',
      layout: {
        visibility: 'none',
      },
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
    labelLayerId ?? undefined,
  );

  map.addLayer(
    {
      id: 'live-street-proximity',
      type: 'line',
      source: 'live-streets',
      layout: {
        visibility: 'none',
      },
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
    labelLayerId ?? undefined,
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
    id: 'station-destination',
    type: 'circle',
    source: 'stations',
    filter: ['==', ['get', 'id'], ''],
    paint: {
      'circle-color': 'rgba(255,255,255,0.35)',
      'circle-stroke-color': '#18222c',
      'circle-stroke-width': 3,
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 7, 13, 12],
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
}

function scheduleDestinationSetup(area, stations, sequence) {
  if (!area.supportsDestination) return;

  const start = async () => {
    const schedules = area.schedules
      ? await fetchJson(area.schedules).catch(() => null)
      : null;
    if (sequence !== loadSequence) return;

    const initializeDestination = () => {
      if (sequence !== loadSequence) return;
      state.schedules = schedules;
      state.transitGraph = buildTransitGraph(stations.features);
      applyScheduleContext();
      renderDestinationOptions(stations.features);
    };

    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(initializeDestination, { timeout: 2_000 });
    } else {
      setTimeout(initializeDestination, 0);
    }
  };

  if (loadingOperation) {
    window.addEventListener('transit:ready', start, { once: true });
  } else {
    start();
  }
}

async function loadArea(areaKey, { initial = false } = {}) {
  const area = AREAS[areaKey];
  const sequence = ++loadSequence;
  liveStreetRefreshSequence += 1;
  window.clearTimeout(liveStreetRefreshTimer);

  if (!initial) beginLoading(`Loading ${area.label}`, 'area');
  activeAreaKey = areaKey;
  streetSourceLoaded = false;
  setCurrentDeparture(area);
  resetDestinationRouting();
  updateAreaChrome(areaKey);
  resetSelection();

  try {
    const [stations, metadata] = await Promise.all([
      fetchJson(area.stations),
      fetchJson(area.metadata),
    ]);

    if (sequence !== loadSequence) return;

    state.metadata = metadata;
    state.stationById = new Map(
      stations.features.map((feature) => [feature.properties.id, feature]),
    );

    loadedStations = stations;
    renderMetadata(metadata);
    installMapData(stations);
    applyMapBounds(metadata);

    if (area.liveRoads && pendingBasemapStyle) installBasemap();
    syncStationFilters();
    syncStreetColor();
    syncStreetVisibility();
    syncStationVisibility();
    updateViewportStatistics();
    window.__transitPerformance.dataFetchedMs =
      performance.now() - window.__transitPerformance.startedAt;
    scheduleDestinationSetup(area, stations, sequence);

    if (area.liveRoads) {
      scheduleLiveStreetRefresh();
      loadingCanFinish = true;
      requestAnimationFrame(() => requestAnimationFrame(finishLoading));
    }
  } catch (error) {
    if (sequence !== loadSequence) return;
    console.error(error);
    loadingOperation = null;
    loadingCanFinish = false;
    updateStatus('Data missing', { isError: true });
    mapLoadingLabelEl.textContent = 'Map data could not be loaded';
    mapEl.setAttribute('aria-busy', 'false');
    featureSummaryEl.textContent = `Run ${area.buildCommand}, then refresh.`;
  }
}

async function initialize() {
  try {
    pendingBasemapStyle = await fetchJson('vendor/openfreemap-liberty.json');
    await loadArea(initialAreaKey, { initial: true });
  } catch (error) {
    console.error(error);
    loadingOperation = null;
    updateStatus('Map unavailable', { isError: true });
    mapLoadingLabelEl.textContent = 'Map could not be initialized';
    mapEl.setAttribute('aria-busy', 'false');
  }
}

streetToggle.addEventListener('change', () => {
  runMapUpdate('Updating layers', () => {
    syncStreetVisibility();
    updateViewportStatistics();
    if (streetToggle.checked) scheduleLiveStreetRefresh();
  });
});

stationToggle.addEventListener('change', () => {
  runMapUpdate('Updating layers', () => {
    syncStationVisibility();
    updateViewportStatistics();
  });
});

futureStationToggle.addEventListener('change', () => {
  runMapUpdate('Updating layers', () => {
    syncStationVisibility();
    if (AREAS[activeAreaKey].liveRoads) {
      scheduleLiveStreetRefresh();
    } else {
      syncStreetColor();
    }
    updateViewportStatistics();

    if (selectedStreetProperties) {
      showStreetFeature(selectedStreetProperties);
    }
  });
});

map.on('sourcedataloading', (event) => {
  if (
    event.sourceId !== 'streets' ||
    AREAS[activeAreaKey].liveRoads ||
    !initialLoadComplete
  ) {
    return;
  }

  if (!loadingOperation) {
    streetSourceLoaded = false;
    beginLoading('Loading area', 'area');
  }
});

map.on('sourcedata', (event) => {
  if (event.sourceId === 'streets' && event.isSourceLoaded) {
    streetSourceLoaded = true;
  }
  if (
    event.sourceId === 'openmaptiles' &&
    event.isSourceLoaded &&
    AREAS[activeAreaKey].liveRoads
  ) {
    scheduleLiveStreetRefresh();
  }
});

map.on('moveend', () => {
  scheduleLiveStreetRefresh();
});
map.on('idle', () => {
  const sourceId = activeStreetSourceId();
  if (!map.getSource(sourceId) || !map.isSourceLoaded(sourceId)) return;

  const renderedStreets = visibleTiledStreets();
  updateViewportStatistics(renderedStreets);
  if (
    window.__transitPerformance.firstStreetRenderMs === null &&
    renderedStreets.length > 0
  ) {
    window.__transitPerformance.firstStreetRenderMs =
      performance.now() - window.__transitPerformance.startedAt;
  }

  if (
    loadingOperation?.type !== 'filter' &&
    (renderedStreets.length > 0 || !streetToggle.checked)
  ) {
    streetSourceLoaded = true;
    loadingCanFinish = true;
    finishLoading();
  }
});
areaSelect.addEventListener('change', () => {
  const areaKey = areaSelect.value;
  if (areaKey !== activeAreaKey) loadArea(areaKey);
});

destinationSelect.addEventListener('change', () => {
  selectDestination(destinationSelect.value);
});

scheduleDaySelect.addEventListener('change', updateScheduleContext);
scheduleTimeInput.addEventListener('change', updateScheduleContext);

timeScaleInput.addEventListener('input', () => {
  if (timeScaleInput.value === '') return;
  updateTimeScale(timeScaleInput.value);
});

timeScaleInput.addEventListener('change', () => {
  updateTimeScale(timeScaleInput.value);
});

setCurrentDeparture(AREAS[initialAreaKey]);
applyTimeScale();

map.once('style.load', () => {
  window.__transitPerformance.styleLoadedMs =
    performance.now() - window.__transitPerformance.startedAt;
  initialize();
});
