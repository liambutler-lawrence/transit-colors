import { GeoJSONSource, VectorTileSource } from 'maplibre-gl';
import { FetchSource, PMTiles } from 'pmtiles';
import watershedData from '../../data/north-america-watersheds-summary.json';
import { MultipartPMTilesSource } from '../multipart-pmtiles.js';
import {
  watershedExitBodies,
  watershedExitBody,
  watershedFillColor,
  unresolvedWatershedColor,
} from '../watershed-colors.js';
import { watershedDrainageLabel, watershedPropertiesSchema } from '../watersheds.js';
import {
  compactPanelQuery,
  map,
  pmtilesProtocol,
  requiredElement,
  runtime,
} from './context.js';
import {
  firstSymbolLayerId,
  replaceMetadata,
  setLayerVisibility,
} from './map-ui-utils.js';

let installed = false;
let selectedId: number | null = null;
let selectedOutlet: [number, number] | null = null;
const failedSources = new Set<string>();

function sourceId(): string {
  return 'watersheds-primary';
}

function boundaryURL(retry?: string): string {
  const url = new URL(`data/${watershedData.file}`, window.location.href);
  url.searchParams.set('v', watershedData.sha256);
  if (retry) url.searchParams.set('retry', retry);
  const parts = watershedData.parts.map((part) => {
    const partURL = new URL(`data/${part.file}`, window.location.href);
    if (retry) partURL.searchParams.set('retry', retry);
    return { source: new FetchSource(partURL.href), bytes: part.bytes };
  });
  pmtilesProtocol.add(
    new PMTiles(new MultipartPMTilesSource(url.href, parts, watershedData.sha256)),
  );
  return `pmtiles://${url.href}`;
}

function statusElement(): HTMLElement {
  return requiredElement('#watershed-status', HTMLElement);
}

function resetSelection(): void {
  selectedId = null;
  selectedOutlet = null;
  requiredElement('#watershed-outlet', HTMLButtonElement).disabled = true;
  const outletSource = map.getSource('watershed-outlet');
  if (outletSource instanceof GeoJSONSource)
    outletSource.setData({ type: 'FeatureCollection', features: [] });
  requiredElement('#watershed-name', HTMLElement).textContent =
    'Click a basin on the map';
  requiredElement('#watershed-metadata', HTMLElement).replaceChildren();
  const layer = `${sourceId()}-selected`;
  if (map.getLayer(layer)) map.setFilter(layer, ['==', ['get', 'id'], -1]);
}

function updateStatus(): void {
  if (runtime.activeProduct !== 'watersheds') return;
  const failed = failedSources.has(sourceId());
  statusElement().textContent = failed
    ? 'Boundary tiles could not load. Retry or return to North America.'
    : map.getSource(sourceId()) && map.isSourceLoaded(sourceId())
      ? 'Primary basins loaded · Click a basin to inspect its outlet.'
      : 'Loading primary basin boundaries…';
  requiredElement('#watershed-retry', HTMLButtonElement).hidden = !failed;
}

function installBasins(): void {
  const id = sourceId();
  if (map.getSource(id)) return;
  map.addSource(id, {
    type: 'vector',
    url: boundaryURL(),
    attribution:
      '<a href="https://www.hydrosheds.org/hydrosheds-v2">HydroSHEDS v2 / WWF / DLR</a> · Lehner et al. (2022) · CC BY 4.0',
    promoteId: 'id',
  });
  const before = firstSymbolLayerId();
  map.addLayer(
    {
      id: `${id}-fill`,
      type: 'fill',
      source: id,
      'source-layer': 'basins',
      layout: { visibility: 'none' },
      paint: {
        'fill-color': watershedFillColor(),
        'fill-opacity': 0.25,
      },
    },
    before,
  );
  map.addLayer(
    {
      id: `${id}-line`,
      type: 'line',
      source: id,
      'source-layer': 'basins',
      layout: { visibility: 'none' },
      paint: {
        'line-color': '#24645f',
        'line-opacity': 0.85,
        'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.5, 6, 1.2, 10, 2],
      },
    },
    before,
  );
  map.addLayer(
    {
      id: `${id}-selected`,
      type: 'line',
      source: id,
      'source-layer': 'basins',
      layout: { visibility: 'none' },
      filter: ['==', ['get', 'id'], -1],
      paint: { 'line-color': '#d05b24', 'line-width': 3 },
    },
    before,
  );
  map.on('click', `${id}-fill`, (event) => {
    if (runtime.activeProduct !== 'watersheds' || sourceId() !== id) return;
    const parsed = watershedPropertiesSchema.safeParse(event.features?.[0]?.properties);
    if (!parsed.success) return;
    const basin = parsed.data;
    selectedId = basin.id;
    selectedOutlet = [basin.outlet_lon, basin.outlet_lat];
    requiredElement('#watershed-outlet', HTMLButtonElement).disabled = false;
    const outletSource = map.getSource('watershed-outlet');
    if (outletSource instanceof GeoJSONSource)
      outletSource.setData({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Point', coordinates: selectedOutlet },
      });
    setLayerVisibility(`${id}-selected`, true);
    setLayerVisibility('watershed-outlet', true);
    map.setFilter(`${id}-selected`, ['==', ['get', 'id'], selectedId]);
    requiredElement('#watershed-name', HTMLElement).textContent =
      basin.name || `Primary basin ${basin.id}`;
    const area = (value: number): string =>
      `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} km²`;
    replaceMetadata(requiredElement('#watershed-metadata', HTMLElement), [
      { label: 'Drainage', value: watershedDrainageLabel(basin.drainage) },
      { label: 'Receiving body', value: watershedExitBody(basin.id, basin.drainage) },
      ...(basin.karst_connections
        ? [
            {
              label: 'Underground connections',
              value: `${basin.karst_connections} source basins joined using documented drainage`,
            },
          ]
        : []),
      { label: 'Basin area', value: area(basin.area_km2) },
      { label: 'Joined catchments', value: basin.catchments.toLocaleString() },
      {
        label: 'Terminal outlet',
        value: `${basin.outlet_lat.toFixed(5)}°, ${basin.outlet_lon.toFixed(5)}°`,
      },
      { label: 'Terminal node ID', value: basin.terminal_node },
      { label: 'Joined source basins', value: basin.source_basins },
      { label: 'Boundary source', value: 'HydroSHEDS v2 · 1 arc-second (~30 m)' },
      { label: 'Accuracy', value: '100 m everywhere is not verified' },
    ]);
  });
  map.on('mousemove', `${id}-fill`, () => {
    if (runtime.activeProduct === 'watersheds' && sourceId() === id)
      map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', `${id}-fill`, () => {
    map.getCanvas().style.cursor = '';
  });
}

export function positionWatershedLayers(): void {
  const before = firstSymbolLayerId();
  if (map.getLayer('watershed-hillshade')) {
    map.moveLayer('watershed-hillshade', map.getLayer('water') ? 'water' : before);
  }
  for (const kind of ['fill', 'line', 'selected']) {
    const id = `${sourceId()}-${kind}`;
    if (map.getLayer(id)) map.moveLayer(id, before);
  }
  if (map.getLayer('watershed-outlet')) map.moveLayer('watershed-outlet');
}

export function syncWatershedVisibility(): void {
  if (!installed) return;
  const active = runtime.activeProduct === 'watersheds';
  if (active) installBasins();
  const colors = requiredElement('#watershed-colors', HTMLInputElement).checked;
  setLayerVisibility(
    'watershed-hillshade',
    active && requiredElement('#watershed-terrain', HTMLInputElement).checked,
  );
  const id = sourceId();
  setLayerVisibility(`${id}-fill`, active);
  if (map.getLayer(`${id}-fill`)) {
    // Keep an invisible hit surface when colors are off.
    map.setPaintProperty(`${id}-fill`, 'fill-opacity', colors ? 0.25 : 0);
  }
  setLayerVisibility(`${id}-line`, active);
  setLayerVisibility(`${id}-selected`, active && selectedId !== null);
  setLayerVisibility('watershed-outlet', active && selectedOutlet !== null);
  if (!active) map.getCanvas().style.cursor = '';
  updateStatus();
}

export function focusWatersheds(): void {
  map.setMaxBounds(null);
  map.fitBounds(
    [
      [-169, 7],
      [-48, 76],
    ],
    {
      bearing: 0,
      pitch: 0,
      duration: 0,
      padding: compactPanelQuery.matches ? 20 : 38,
    },
  );
}

export function installWatersheds(): void {
  if (installed) return;
  installed = true;
  const legend = requiredElement('#watershed-exit-key', HTMLElement);
  for (const body of [
    ...watershedExitBodies,
    { name: 'Unresolved', color: unresolvedWatershedColor },
  ]) {
    const item = document.createElement('span');
    const swatch = document.createElement('i');
    swatch.style.backgroundColor = body.color;
    swatch.setAttribute('aria-hidden', 'true');
    item.append(swatch, body.name);
    legend.append(item);
  }
  map.addSource('watershed-dem', {
    type: 'raster-dem',
    encoding: 'terrarium',
    tileSize: 256,
    maxzoom: 15,
    tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
    attribution:
      '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">Terrain: Mapzen + contributors</a>',
  });
  map.addLayer(
    {
      id: 'watershed-hillshade',
      type: 'hillshade',
      source: 'watershed-dem',
      layout: { visibility: 'none' },
      paint: { 'hillshade-exaggeration': 0.45, 'hillshade-shadow-color': '#536556' },
    },
    firstSymbolLayerId(),
  );
  map.addSource('watershed-outlet', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer({
    id: 'watershed-outlet',
    type: 'circle',
    source: 'watershed-outlet',
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': 6,
      'circle-color': '#d05b24',
      'circle-stroke-color': '#fff',
      'circle-stroke-width': 2,
    },
  });
  requiredElement('#watershed-outlet', HTMLButtonElement).addEventListener(
    'click',
    () => {
      if (selectedOutlet)
        map.flyTo({ center: selectedOutlet, zoom: 11, duration: 800 });
    },
  );
  for (const selector of ['#watershed-colors', '#watershed-terrain']) {
    requiredElement(selector, HTMLInputElement).addEventListener(
      'change',
      syncWatershedVisibility,
    );
  }
  requiredElement('#watershed-reset', HTMLButtonElement).addEventListener(
    'click',
    focusWatersheds,
  );
  requiredElement('#watershed-clear', HTMLButtonElement).addEventListener(
    'click',
    resetSelection,
  );
  requiredElement('#watershed-retry', HTMLButtonElement).addEventListener(
    'click',
    () => {
      const source = map.getSource(sourceId());
      if (source instanceof VectorTileSource) {
        failedSources.delete(sourceId());
        source.setUrl(boundaryURL(String(Date.now())));
        updateStatus();
      }
    },
  );
  map.on('idle', updateStatus);
  map.on('sourcedata', (event) => {
    if (event.sourceId === sourceId()) updateStatus();
  });
  map.on('error', (event) => {
    const failedSource =
      'sourceId' in event && typeof event.sourceId === 'string' ? event.sourceId : '';
    if (failedSource.startsWith('watersheds-')) {
      failedSources.add(failedSource);
      updateStatus();
    } else if (failedSource === 'watershed-dem') {
      requiredElement('#watershed-terrain-status', HTMLElement).textContent =
        'Terrain shading is unavailable. Basin boundaries still work.';
    }
  });
  syncWatershedVisibility();
}
