const DATASETS = {
  streets: 'data/cdmx-streets.geojson',
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
  trolleybus: 'Trolleybus',
  monorail: 'Monorail',
};

const MODE_COLORS = {
  subway: '#f05a28',
  brt: '#8b2bb1',
  light_rail: '#1a9d8f',
  cable_car: '#0072ce',
  commuter_rail: '#5c6f82',
  regional_rail: '#b35a00',
  trolleybus: '#2e7d32',
  monorail: '#111827',
};

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: [-99.1332, 19.4326],
  zoom: 10.5,
  maxBounds: [
    [-99.55, 18.88],
    [-98.72, 19.76],
  ],
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

const streetColor = [
  'interpolate',
  ['linear'],
  ['get', 'd'],
  0,
  COLORS.near,
  1000,
  COLORS.midNear,
  2500,
  COLORS.midFar,
  5000,
  COLORS.far,
];

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
  'trolleybus',
  MODE_COLORS.trolleybus,
  'monorail',
  MODE_COLORS.monorail,
  '#18222c',
];

const openStationFilter = ['==', ['get', 'status'], 'open'];
const futureStationFilter = ['!=', ['get', 'status'], 'open'];
const openStationLayers = ['station-points-open', 'station-labels-open'];
const futureStationLayers = ['station-points-future', 'station-labels-future'];

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

function updateStatus(label, isError = false) {
  statusEl.textContent = label;
  statusEl.classList.toggle('error', isError);
}

function renderMetadata(metadata) {
  const streetCount = metadata.street_count ?? 0;
  const stationCount = metadata.open_station_count ?? metadata.station_count ?? 0;
  const futureStationCount = metadata.future_station_count ?? 0;
  const nearCount = metadata.histogram?.under_2500_m ?? 0;

  streetCountEl.textContent = formatInteger(streetCount);
  stationCountEl.textContent = formatInteger(stationCount);
  nearCountEl.textContent = formatInteger(nearCount);

  const stationModes = metadata.station_modes_open ?? metadata.station_modes ?? {};
  stationBreakdownEl.replaceChildren(
    ...Object.entries(stationModes)
      .sort((a, b) => b[1] - a[1])
      .map(([mode, count]) => {
        const item = document.createElement('span');
        item.className = 'mode-pill';
        item.style.setProperty('--mode-color', MODE_COLORS[mode] ?? '#18222c');
        item.textContent = `${MODE_LABELS[mode] ?? mode}: ${formatInteger(count)}`;
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
  selectionTypeEl.textContent = 'Selected street';
  featureNameEl.textContent = streetName;
  featureSummaryEl.textContent = `${formatDistance(props.d)} from nearest station`;
  renderDetails([
    { label: 'OSM highway', value: props.h },
  ]);
}

function showStationFeature(props) {
  selectionTypeEl.textContent = 'Selected station';
  featureNameEl.textContent = props.name || 'Unnamed station';
  featureSummaryEl.textContent = props.system || MODE_LABELS[props.mode] || 'Transit station';
  renderDetails([
    { label: 'Status', value: props.status_detail || props.status },
    { label: 'Mode', value: props.system || MODE_LABELS[props.mode] },
    { label: 'Network', value: props.network },
    { label: 'Operator', value: props.operator },
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
    const [streets, stations, metadata] = await Promise.all([
      fetchJson(DATASETS.streets),
      fetchJson(DATASETS.stations),
      fetchJson(DATASETS.metadata),
    ]);

    renderMetadata(metadata);

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
          'line-color': streetColor,
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
    syncStationVisibility();
    updateStatus('Ready');
  } catch (error) {
    console.error(error);
    updateStatus('Data missing', true);
    featureSummaryEl.textContent = 'Run npm run build:data:cdmx, then refresh.';
  }
}

streetToggle.addEventListener('change', () => {
  setLayerVisibility('street-proximity', streetToggle.checked);
});

stationToggle.addEventListener('change', () => {
  syncStationVisibility();
});

futureStationToggle.addEventListener('change', () => {
  syncStationVisibility();
});

map.on('load', initialize);
