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
const streetNameEl = document.querySelector('#street-name');
const streetDistanceEl = document.querySelector('#street-distance');
const streetToggle = document.querySelector('#toggle-streets');
const stationToggle = document.querySelector('#toggle-stations');

const streetColor = [
  'interpolate',
  ['linear'],
  ['get', 'd'],
  0,
  COLORS.near,
  2500,
  COLORS.midNear,
  5000,
  COLORS.midFar,
  10000,
  COLORS.far,
];

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

function updateStatus(label, isError = false) {
  statusEl.textContent = label;
  statusEl.classList.toggle('error', isError);
}

function renderMetadata(metadata) {
  const streetCount = metadata.street_count ?? 0;
  const stationCount = metadata.station_count ?? 0;
  const nearCount = metadata.histogram?.under_2500_m ?? 0;

  streetCountEl.textContent = formatInteger(streetCount);
  stationCountEl.textContent = formatInteger(stationCount);
  nearCountEl.textContent = formatInteger(nearCount);
}

function installHover() {
  let hoveredId = null;

  map.on('mousemove', 'street-proximity', (event) => {
    const feature = event.features?.[0];
    if (!feature) return;

    if (hoveredId !== null) {
      map.setFeatureState({ source: 'streets', id: hoveredId }, { hover: false });
    }

    hoveredId = feature.id;
    map.setFeatureState({ source: 'streets', id: hoveredId }, { hover: true });

    const props = feature.properties;
    const streetName = props.n || props.h || 'Unnamed street';
    streetNameEl.textContent = streetName;
    streetDistanceEl.textContent = `${formatDistance(props.d)} from nearest station`;
    map.getCanvas().style.cursor = 'pointer';
  });

  map.on('mouseleave', 'street-proximity', () => {
    if (hoveredId !== null) {
      map.setFeatureState({ source: 'streets', id: hoveredId }, { hover: false });
    }
    hoveredId = null;
    map.getCanvas().style.cursor = '';
  });
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
      id: 'station-points',
      type: 'circle',
      source: 'stations',
      paint: {
        'circle-color': '#ffffff',
        'circle-stroke-color': '#18222c',
        'circle-stroke-width': 1.5,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 2.5, 13, 5.5],
      },
    });

    installHover();
    updateStatus('Ready');
  } catch (error) {
    console.error(error);
    updateStatus('Data missing', true);
    streetDistanceEl.textContent = 'Run npm run build:data:cdmx, then refresh.';
  }
}

streetToggle.addEventListener('change', () => {
  setLayerVisibility('street-proximity', streetToggle.checked);
});

stationToggle.addEventListener('change', () => {
  setLayerVisibility('station-points', stationToggle.checked);
});

map.on('load', initialize);
