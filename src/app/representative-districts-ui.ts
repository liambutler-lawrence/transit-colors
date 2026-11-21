import { LngLatBounds, type ExpressionSpecification } from 'maplibre-gl';

import {
  defaultDistrictState,
  districtState,
  districtStateBounds,
  districtStates,
} from '../district-states.js';
import {
  districtRequestSchema,
  isKnifeMethod,
  type DistrictPlan,
  type DistrictRequest,
  type DistrictResponse,
} from '../representative-districts.js';
import {
  compactPanelQuery,
  formatArea,
  formatDistance,
  formatInteger,
  geoJsonSource,
  initialSearchParams,
  map,
  requiredElement,
  runtime,
} from './context.js';
import { firstSymbolLayerId, setLayerVisibility } from './map-ui-utils.js';

const COLORS = [
  '#b6405a',
  '#197b79',
  '#a05c09',
  '#6552a5',
  '#246da9',
  '#558023',
  '#9c468b',
  '#886243',
];
const SOURCE = 'representative-districts';
const OUTLINE = 'district-study-outline';
const FILL = 'representative-district-fill';
const LINE = 'representative-district-line';
const SELECTED = 'representative-district-selected';
const LAYERS = [FILL, LINE, OUTLINE, SELECTED];
const color: ExpressionSpecification = [
  'to-color',
  ['at', ['-', ['number', ['get', 'number']], 1], ['literal', COLORS]],
  '#495461',
];
const percent = new Intl.NumberFormat('en-US', {
  style: 'percent',
  maximumFractionDigits: 1,
});
const deviation = new Intl.NumberFormat('en-US', {
  style: 'percent',
  maximumFractionDigits: 3,
  signDisplay: 'exceptZero',
});

const stateSelect = requiredElement('#district-state', HTMLSelectElement);
const methodSelect = requiredElement('#district-method', HTMLSelectElement);
const seatsSelect = requiredElement('#district-seats', HTMLSelectElement);
const status = requiredElement('#district-status', HTMLElement);
const overview = requiredElement('#district-overview', HTMLElement);
const results = requiredElement('#district-results', HTMLElement);
const retry = requiredElement('#district-retry', HTMLButtonElement);

let worker: Worker | undefined;
let requestId = 0;

const methodSchema = districtRequestSchema.shape.method;
stateSelect.replaceChildren(
  ...districtStates.map(({ code, name }) => new Option(name, code)),
);
stateSelect.value =
  districtState(initialSearchParams.get('district-state'))?.code ??
  defaultDistrictState;
const initialMethod = methodSchema.safeParse(
  initialSearchParams.get('district-method'),
);
if (initialMethod.success) methodSelect.value = initialMethod.data;
const initialSeats = initialSearchParams.get('district-seats');
if (Array.from(seatsSelect.options).some((option) => option.value === initialSeats)) {
  seatsSelect.value = initialSeats ?? seatsSelect.value;
}

function settings(): DistrictRequest {
  const method = methodSchema.safeParse(methodSelect.value);
  return {
    method: method.success ? method.data : 'knife',
    seats: Number(seatsSelect.value),
  };
}

export function selectedDistrictStateName(): string {
  return districtState(stateSelect.value)?.name ?? 'Connecticut';
}

export function writeDistrictSettings(url: URL): void {
  const { method, seats } = settings();
  if (
    runtime.activeProduct === 'districts' &&
    stateSelect.value !== defaultDistrictState
  ) {
    url.searchParams.set('district-state', stateSelect.value);
  } else {
    url.searchParams.delete('district-state');
  }
  if (runtime.activeProduct === 'districts' && method !== 'knife') {
    url.searchParams.set('district-method', method);
  } else {
    url.searchParams.delete('district-method');
  }
  if (runtime.activeProduct === 'districts' && seats !== 5) {
    url.searchParams.set('district-seats', String(seats));
  } else {
    url.searchParams.delete('district-seats');
  }
}

function selectDistrict(number: number): void {
  map.setFilter(SELECTED, ['==', ['get', 'number'], number]);
  for (const button of results.querySelectorAll('button')) {
    button.setAttribute(
      'aria-pressed',
      String(Number(button.dataset['district']) === number),
    );
  }
}

function renderResults(result: DistrictPlan, method: DistrictRequest['method']): void {
  const { districts, target, totalPopulation, totalAreaSquareMeters } = result;
  requiredElement('#district-target', HTMLElement).textContent = formatInteger(
    Math.round(target),
  );
  requiredElement('#district-population', HTMLElement).textContent =
    formatInteger(totalPopulation);
  requiredElement('#district-area-label', HTMLElement).textContent = isKnifeMethod(
    method,
  )
    ? 'Total district area'
    : 'Sum of circle areas';
  requiredElement('#district-area', HTMLElement).textContent =
    formatArea(totalAreaSquareMeters);

  const buttons = districts.features.map(({ properties }) => {
    const {
      number,
      areaSquareMeters,
      population,
      urbanPopulation,
      reock,
      radiusMeters,
    } = properties;
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset['district'] = String(number);
    button.className = 'district-result';
    button.setAttribute('aria-pressed', 'false');
    const swatch = document.createElement('span');
    swatch.className = 'district-swatch';
    swatch.setAttribute('aria-hidden', 'true');
    swatch.style.backgroundColor = COLORS[number - 1] ?? '';
    const label = document.createElement('strong');
    label.textContent = `District ${number}`;
    const people = document.createElement('span');
    people.textContent = `${formatInteger(population)} residents · ${deviation.format((population - target) / target)} vs. target`;
    const geography = document.createElement('span');
    const area = formatArea(areaSquareMeters);
    geography.textContent =
      `${area}${radiusMeters === null ? '' : ' circle'}` +
      (population === 0
        ? ''
        : ` · ${percent.format(urbanPopulation / population)} urban`);
    const metric = document.createElement('span');
    metric.textContent = [
      reock === null ? '' : `Reock ${reock.toFixed(3)}`,
      radiusMeters === null ? '' : `${formatDistance(radiusMeters)} radius`,
    ]
      .filter(Boolean)
      .join(' · ');
    button.append(swatch, label, people, geography, metric);
    return button;
  });
  results.replaceChildren(...buttons);
  overview.hidden = false;
  status.textContent = '';
}

function focusDistrictPlan(): void {
  const state = districtState(stateSelect.value);
  if (!state) return;
  const bounds = new LngLatBounds(districtStateBounds(state));
  // At these longitudes the statewide viewport can straddle the antimeridian.
  const projection = bounds.getWest() < -170 ? 'mercator' : 'globe';
  if (map.getProjection()?.type !== projection) map.setProjection({ type: projection });
  map.setMaxBounds(null);
  map.fitBounds(bounds, {
    bearing: 0,
    pitch: 0,
    duration: 0,
    padding: compactPanelQuery.matches ? 24 : 54,
  });
}

function showFailure(message: string): void {
  status.textContent = message;
  retry.hidden = false;
}

function createWorker(): Worker {
  const instance = new Worker(
    new URL('../representative-districts.worker.ts', import.meta.url),
    {
      type: 'module',
    },
  );
  instance.onmessage = ({ data }: MessageEvent<DistrictResponse>) => {
    if (data.id !== requestId) return;
    if ('error' in data) {
      showFailure(data.error);
      return;
    }
    const { plan } = data;
    geoJsonSource(OUTLINE)?.setData(plan.outline);
    geoJsonSource(SOURCE)?.setData(plan.districts);
    renderResults(plan, settings().method);
  };
  instance.onerror = () => {
    instance.terminate();
    worker = undefined;
    showFailure('The district map could not load.');
  };
  return instance;
}

function loadDistrictPlan(): void {
  const request = settings();
  for (const method of methodSchema.options) {
    requiredElement(`#district-${method}-method`, HTMLElement).hidden =
      method !== request.method;
  }
  status.textContent = `Loading ${selectedDistrictStateName()} district plan…`;
  overview.hidden = true;
  retry.hidden = true;
  results.replaceChildren();
  selectDistrict(0);
  geoJsonSource(SOURCE)?.setData({ type: 'FeatureCollection', features: [] });
  geoJsonSource(OUTLINE)?.setData({ type: 'FeatureCollection', features: [] });
  try {
    worker ??= createWorker();
    const baseUrl = new URL(import.meta.env.BASE_URL, document.baseURI).href;
    worker.postMessage({
      ...request,
      id: ++requestId,
      state: stateSelect.value,
      baseUrl,
    });
  } catch {
    showFailure('The district map could not load.');
  }
}

function installDistrictMap(): void {
  map.addSource(SOURCE, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addSource(OUTLINE, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  const before = firstSymbolLayerId();
  map.addLayer(
    {
      id: FILL,
      type: 'fill',
      source: SOURCE,
      layout: { 'fill-sort-key': ['-', 0, ['number', ['get', 'number']]] },
      paint: { 'fill-color': color, 'fill-opacity': 0.29 },
    },
    before,
  );
  map.addLayer(
    {
      id: LINE,
      type: 'line',
      source: SOURCE,
      paint: { 'line-color': color, 'line-width': 2 },
    },
    before,
  );
  map.addLayer(
    {
      id: OUTLINE,
      type: 'line',
      source: OUTLINE,
      paint: { 'line-color': '#232b37', 'line-width': 1, 'line-dasharray': [3, 2] },
    },
    before,
  );
  map.addLayer(
    {
      id: SELECTED,
      type: 'line',
      source: SOURCE,
      filter: ['==', ['get', 'number'], 0],
      paint: { 'line-color': color, 'line-width': 4 },
    },
    before,
  );
  map.on('click', FILL, (event) => {
    if (runtime.activeProduct !== 'districts') return;
    const number: unknown = event.features?.[0]?.properties['number'];
    if (typeof number === 'number') selectDistrict(number);
  });
  void map.once('remove', () => worker?.terminate());
  focusDistrictPlan();
  loadDistrictPlan();
}

export function syncDistrictVisibility({ fit }: { readonly fit: boolean }): void {
  const active = runtime.activeProduct === 'districts';
  if (
    active &&
    !map.getSource(SOURCE) &&
    window.__transitPerformance.styleLoadedMs !== null
  ) {
    installDistrictMap();
  }
  for (const layer of LAYERS) setLayerVisibility(layer, active);
  if (active && fit && map.getSource(SOURCE)) focusDistrictPlan();
}

export function positionDistrictLayers(): void {
  const before = firstSymbolLayerId();
  for (const layer of LAYERS) {
    if (map.getLayer(layer)) map.moveLayer(layer, before);
  }
}

for (const select of [stateSelect, methodSelect, seatsSelect]) {
  select.addEventListener('change', () => {
    const url = new URL(window.location.href);
    writeDistrictSettings(url);
    window.history.replaceState({}, '', url);
    if (select === stateSelect) {
      const name = selectedDistrictStateName();
      document.title = `Representative districts — ${name} · Maps`;
      map
        .getContainer()
        .setAttribute(
          'aria-label',
          `Interactive map of representative districts in ${name}`,
        );
      if (map.getSource(SOURCE)) focusDistrictPlan();
    }
    if (map.getSource(SOURCE)) loadDistrictPlan();
  });
}
results.addEventListener('click', (event) => {
  const button =
    event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>('button[data-district]')
      : null;
  if (button) selectDistrict(Number(button.dataset['district']));
});
retry.addEventListener('click', loadDistrictPlan);
