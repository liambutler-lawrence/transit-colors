import { VectorTileSource } from 'maplibre-gl';
import {
  WATERSHED_LEVELS,
  watershedDrainageLabel,
  watershedLevel,
  watershedPropertiesSchema,
} from '../watersheds.js';
import { compactPanelQuery, map, requiredElement, runtime } from './context.js';
import {
  firstSymbolLayerId,
  replaceMetadata,
  setLayerVisibility,
} from './map-ui-utils.js';

let installed = false;
let level = watershedLevel(
  new URLSearchParams(window.location.search).get('watershed-level'),
);
let selectedId: number | null = null;
const failedSources = new Set<string>();

function sourceId(): string {
  return `watersheds-${level}`;
}

function statusElement(): HTMLElement {
  return requiredElement('#watershed-status', HTMLElement);
}

function resetSelection(): void {
  selectedId = null;
  requiredElement('#watershed-name', HTMLElement).textContent =
    'Click a basin on the map';
  requiredElement('#watershed-metadata', HTMLElement).replaceChildren();
  for (const item of WATERSHED_LEVELS) {
    const layer = `watersheds-${item}-selected`;
    if (map.getLayer(layer)) map.setFilter(layer, ['==', ['get', 'id'], -1]);
  }
}

function updateStatus(): void {
  if (runtime.activeProduct !== 'watersheds') return;
  const failed = failedSources.has(sourceId());
  statusElement().textContent = failed
    ? 'Boundary tiles could not load. Retry or return to North America.'
    : map.getSource(sourceId()) && map.isSourceLoaded(sourceId())
      ? `Level ${level} boundaries loaded · Click a basin to inspect it.`
      : `Loading level ${level} boundaries…`;
  requiredElement('#watershed-retry', HTMLButtonElement).hidden = !failed;
}

function installLevel(): void {
  const id = sourceId();
  if (map.getSource(id)) return;
  const url = new URL(
    `data/north-america-watersheds-${level}.pmtiles`,
    window.location.href,
  );
  map.addSource(id, {
    type: 'vector',
    url: `pmtiles://${url.href}`,
    attribution:
      '<a href="https://www.hydrosheds.org/products/hydrobasins">HydroBASINS / WWF</a> · Lehner &amp; Grill (2013)',
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
        'fill-color': [
          'match',
          ['get', 'color'],
          0,
          '#2c8b83',
          1,
          '#6c8cbe',
          2,
          '#cfad64',
          3,
          '#b77c98',
          4,
          '#8fa961',
          5,
          '#ad8660',
          6,
          '#7d83b9',
          '#5babc0',
        ],
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
    setLayerVisibility(`${id}-selected`, true);
    map.setFilter(`${id}-selected`, ['==', ['get', 'id'], selectedId]);
    requiredElement('#watershed-name', HTMLElement).textContent =
      `Sub-basin ${basin.id}`;
    const area = (value: number): string =>
      `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} km²`;
    replaceMetadata(requiredElement('#watershed-metadata', HTMLElement), [
      { label: 'Boundary detail', value: `HydroBASINS level ${basin.level}` },
      { label: 'Basin area', value: area(basin.area_km2) },
      { label: 'Upstream area', value: area(basin.upstream_km2) },
      {
        label: 'Drainage',
        value: watershedDrainageLabel(basin.endorheic, basin.coastal),
      },
      { label: 'Next downstream ID', value: basin.next_down || 'No downstream basin' },
      { label: 'Main basin ID', value: basin.main_basin },
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
  for (const id of [
    ...WATERSHED_LEVELS.flatMap((item) =>
      ['fill', 'line', 'selected'].map((kind) => `watersheds-${item}-${kind}`),
    ),
  ]) {
    if (map.getLayer(id)) map.moveLayer(id, before);
  }
}

export function syncWatershedVisibility(): void {
  if (!installed) return;
  const active = runtime.activeProduct === 'watersheds';
  if (active) installLevel();
  const colors = requiredElement('#watershed-colors', HTMLInputElement).checked;
  setLayerVisibility(
    'watershed-hillshade',
    active && requiredElement('#watershed-terrain', HTMLInputElement).checked,
  );
  for (const item of WATERSHED_LEVELS) {
    const visible = active && item === level;
    setLayerVisibility(`watersheds-${item}-fill`, visible);
    if (map.getLayer(`watersheds-${item}-fill`)) {
      // Keep an invisible hit surface when colors are off.
      map.setPaintProperty(
        `watersheds-${item}-fill`,
        'fill-opacity',
        colors ? 0.25 : 0,
      );
    }
    setLayerVisibility(`watersheds-${item}-line`, visible);
    setLayerVisibility(`watersheds-${item}-selected`, visible && selectedId !== null);
  }
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
  const select = requiredElement('#watershed-level', HTMLSelectElement);
  select.value = String(level);
  select.addEventListener('change', () => {
    level = watershedLevel(select.value);
    resetSelection();
    const url = new URL(window.location.href);
    url.searchParams.set('watershed-level', String(level));
    window.history.replaceState({}, '', url);
    syncWatershedVisibility();
  });
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
        const url = new URL(
          `data/north-america-watersheds-${level}.pmtiles`,
          window.location.href,
        );
        url.searchParams.set('retry', String(Date.now()));
        source.setUrl(`pmtiles://${url.href}`);
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
