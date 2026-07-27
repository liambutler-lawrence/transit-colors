import maplibregl, {
  type ExpressionSpecification,
  type GeoJSONSource,
  type ImageSource,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';

import { CIRCUMFERENCE_GRADIENT_TEXTURE_SIZE } from '../circumference-map.js';
import {
  expressionSpecificationSchema,
  filterSpecificationSchema,
  type AppRuntime,
  type AppState,
  type AreaConfig,
  type AreaKey,
  type CircumferenceState,
  type DistanceProperties,
  type LoadingOperation,
  type Product,
} from './types.js';

import {
  DEFAULT_TIME_SCALE_MINUTES,
  WALKING_METERS_PER_MINUTE,
  timeScaleStops,
} from '../routing.js';
import type { Mode } from '../domain.js';

export const AREAS: Record<AreaKey, AreaConfig> = {
  cdmx: {
    label: 'Mexico City',
    center: [-99.1332, 19.4326],
    zoom: 10.5,
    circumference: 'data/cdmx-circumference.json?v=20260726a',
    streetTiles: 'data/cdmx-streets.pmtiles?v=20260725h',
    stations: 'data/cdmx-stations.geojson?v=20260725h',
    metadata: 'data/cdmx-metadata.json?v=20260725h',
    schedules: 'data/cdmx-schedules.json?v=20260725h',
    timezone: 'America/Mexico_City',
    supportsDestination: true,
    buildCommand: 'npm run build:data:cdmx',
  },
  nyc: {
    label: 'New York City metro',
    center: [-73.98, 40.75],
    zoom: 9.5,
    circumference: 'data/nyc-circumference.json?v=20260726a',
    liveRoads: true,
    stations: 'data/nyc-stations.geojson?v=20260726a',
    metadata: 'data/nyc-metadata.json?v=20260726a',
    schedules: 'data/nyc-schedules.json?v=20260726a',
    timezone: 'America/New_York',
    supportsDestination: true,
    buildCommand: 'npm run build:data:nyc',
  },
};

export function isAreaKey(value: string | null): value is AreaKey {
  return value === 'cdmx' || value === 'nyc';
}

export function isMode(value: unknown): value is Mode {
  return typeof value === 'string' && Object.hasOwn(MODE_LABELS, value);
}

export const initialSearchParams = new URLSearchParams(window.location.search);
export const requestedAreaKey = initialSearchParams.get('area');
export const initialAreaKey: AreaKey = isAreaKey(requestedAreaKey)
  ? requestedAreaKey
  : 'cdmx';
export const initialProduct: Product =
  initialSearchParams.get('product') === 'circumference' ? 'circumference' : 'access';

export const COLORS = {
  near: '#006837',
  nearMid: '#39b54a',
  midNear: '#c7e62c',
  mid: '#ffe34d',
  midFar: '#ff9f1c',
  farMid: '#ef476f',
  far: '#7a001f',
  future: '#64748b',
};

export const MODE_LABELS = {
  subway: 'Metro',
  brt: 'BRT',
  light_rail: 'Light rail',
  cable_car: 'Cable car',
  commuter_rail: 'Commuter rail',
  regional_rail: 'Regional rail',
  monorail: 'Monorail',
} satisfies Record<Mode, string>;

export const MODE_COLORS = {
  subway: '#f05a28',
  brt: '#8b2bb1',
  light_rail: '#1a9d8f',
  cable_car: '#0072ce',
  commuter_rail: '#5c6f82',
  regional_rail: '#b35a00',
  monorail: '#111827',
} satisfies Record<Mode, string>;

export const MODE_DISTANCE_PROPERTIES = {
  subway: 'ds',
  brt: 'db',
  light_rail: 'dl',
  cable_car: 'dc',
  commuter_rail: 'dt',
  regional_rail: 'dr',
  monorail: 'dm',
} satisfies DistanceProperties;

export const pmtilesProtocol = new Protocol();
maplibregl.addProtocol('pmtiles', pmtilesProtocol.tile);

export type ElementConstructor<T extends Element> = new () => T;

export function requiredElement<T extends Element>(
  selector: string,
  constructor: ElementConstructor<T>,
  parent: ParentNode = document,
): T {
  const element = parent.querySelector(selector);
  if (!(element instanceof constructor)) {
    throw new Error(`Required element is missing or invalid: ${selector}`);
  }
  return element;
}

export const appShellEl = requiredElement('.app-shell', HTMLElement);
export const panelToggleButton = requiredElement('#toggle-panel', HTMLButtonElement);
export const panelToggleLabelEl = requiredElement(
  '.panel-toggle-label',
  HTMLSpanElement,
  panelToggleButton,
);
export const compactPanelQuery = window.matchMedia('(max-width: 680px)');
let panelCollapsePreference: boolean | null = null;
let panelCollapsed = compactPanelQuery.matches;

export function renderPanelState(): void {
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

export const map = new maplibregl.Map({
  container: 'map',
  style: 'vendor/openfreemap-shell.json',
  center: AREAS[initialAreaKey].center,
  zoom: AREAS[initialAreaKey].zoom,
  maxZoom: 17,
});
window.__transitMap = map;

export function geoJsonSource(id: string): GeoJSONSource | null {
  const source = map.getSource(id);
  return source instanceof maplibregl.GeoJSONSource ? source : null;
}

export function imageSource(id: string): ImageSource | null {
  const source = map.getSource(id);
  return source instanceof maplibregl.ImageSource ? source : null;
}

export const FUTURE_MODE_DISTANCE_PROPERTIES = {
  subway: 'fs',
  brt: 'fb',
  light_rail: 'fl',
  cable_car: 'fc',
  commuter_rail: 'ft',
  regional_rail: 'fr',
  monorail: 'fm',
} satisfies DistanceProperties;

export const MODE_ACCESS_PROPERTIES = {
  subway: 'as',
  brt: 'ab',
  light_rail: 'al',
  cable_car: 'ac',
  commuter_rail: 'at',
  regional_rail: 'ar',
  monorail: 'am',
} satisfies DistanceProperties;

export const FUTURE_MODE_ACCESS_PROPERTIES = {
  subway: 'us',
  brt: 'ub',
  light_rail: 'ul',
  cable_car: 'uc',
  commuter_rail: 'ut',
  regional_rail: 'ur',
  monorail: 'um',
} satisfies DistanceProperties;
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

export const statusEl = requiredElement('#status', HTMLElement);

export function updateStatus(
  label: string,
  {
    isError = false,
    isLoading = false,
  }: { readonly isError?: boolean; readonly isLoading?: boolean } = {},
): void {
  statusEl.textContent = label;
  statusEl.classList.toggle('error', isError);
  statusEl.classList.toggle('loading', isLoading);
}

export const mapEl = requiredElement('#map', HTMLElement);
export const mapLoadingEl = requiredElement('#map-loading', HTMLElement);
export const mapLoadingLabelEl = requiredElement('#map-loading-label', HTMLSpanElement);
export const streetCountEl = requiredElement('#street-count', HTMLElement);
export const stationCountEl = requiredElement('#station-count', HTMLElement);
export const nearCountEl = requiredElement('#near-count', HTMLElement);
export const nearCountLabelEl = requiredElement('#near-count-label', HTMLElement);
export const legendEl = requiredElement('#legend', HTMLElement);
export const legendLabelsEl = requiredElement('#legend-labels', HTMLElement);
export const stationBreakdownEl = requiredElement('#station-breakdown', HTMLElement);
export const destinationSelect = requiredElement(
  '#destination-select',
  HTMLSelectElement,
);
export const destinationSummaryEl = requiredElement(
  '#destination-summary',
  HTMLElement,
);
export const scheduleDaySelect = requiredElement('#schedule-day', HTMLSelectElement);
export const scheduleTimeInput = requiredElement('#schedule-time', HTMLInputElement);
export const scheduleSummaryEl = requiredElement('#schedule-summary', HTMLElement);
export const timeScaleInput = requiredElement('#time-scale-minutes', HTMLInputElement);
export const timeScaleSummaryEl = requiredElement('#time-scale-summary', HTMLElement);
export const destinationControlEl = requiredElement(
  '.destination-control',
  HTMLElement,
);
export const departureControlEl = requiredElement('.departure-control', HTMLElement);
export const timeScaleControlEl = requiredElement('.time-scale-control', HTMLElement);
export const selectionTypeEl = requiredElement('#selection-type', HTMLElement);
export const featureNameEl = requiredElement('#feature-name', HTMLElement);
export const featureSummaryEl = requiredElement('#feature-summary', HTMLElement);
export const featureMetadataEl = requiredElement('#feature-metadata', HTMLElement);
export const routeBreakdownEl = requiredElement('#route-breakdown', HTMLElement);
export const streetToggle = requiredElement('#toggle-streets', HTMLInputElement);
export const stationToggle = requiredElement('#toggle-stations', HTMLInputElement);
export const futureStationToggle = requiredElement(
  '#toggle-future-stations',
  HTMLInputElement,
);
export const areaSelect = requiredElement('#metro-area', HTMLSelectElement);
export const productTitleEl = requiredElement('#product-title', HTMLElement);
export const accessProductButton = requiredElement(
  '#product-access',
  HTMLButtonElement,
);
export const circumferenceProductButton = requiredElement(
  '#product-circumference',
  HTMLButtonElement,
);
export const accessProductEl = requiredElement('#access-product', HTMLElement);
export const circumferenceProductEl = requiredElement(
  '#circumference-product',
  HTMLElement,
);
export const circumferenceInnerAreaEl = requiredElement(
  '#circumference-inner-area',
  HTMLElement,
);
export const circumferenceOuterAreaEl = requiredElement(
  '#circumference-outer-area',
  HTMLElement,
);
export const circumferenceOuterLabelEl = requiredElement(
  '#circumference-outer-label',
  HTMLElement,
);
export const circumferenceLengthEl = requiredElement(
  '#circumference-length',
  HTMLElement,
);
export const circumferenceLandmassBreakdownEl = requiredElement(
  '#circumference-landmass-breakdown',
  HTMLElement,
);
export const routeChoiceSelect = requiredElement('#route-choice', HTMLSelectElement);
export const routeAutoButton = requiredElement('#route-auto', HTMLButtonElement);
export const routeChoiceSummaryEl = requiredElement(
  '#route-choice-summary',
  HTMLElement,
);
export const routeTrackGeometryToggle = requiredElement(
  '#toggle-track-geometry',
  HTMLInputElement,
);
export const routeGradientToggle = requiredElement(
  '#toggle-route-gradient',
  HTMLInputElement,
);
export const routeStationsToggle = requiredElement(
  '#toggle-route-stations',
  HTMLInputElement,
);
export const routeAreaToggle = requiredElement('#toggle-route-area', HTMLInputElement);
export const circumferenceNameEl = requiredElement('#circumference-name', HTMLElement);
export const circumferenceSummaryEl = requiredElement(
  '#circumference-summary',
  HTMLElement,
);
export const circumferenceMetadataEl = requiredElement(
  '#circumference-metadata',
  HTMLElement,
);
export const routeRequireSegmentButton = requiredElement(
  '#route-require-segment',
  HTMLButtonElement,
);
export const routeAvoidSegmentButton = requiredElement(
  '#route-avoid-segment',
  HTMLButtonElement,
);
export const routeClearSegmentsButton = requiredElement(
  '#route-clear-segments',
  HTMLButtonElement,
);

export function setPanelCollapsed(
  nextCollapsed: boolean,
  { remember = true }: { readonly remember?: boolean } = {},
): void {
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
}).observe(mapEl);

export const initialLoadingOperation: LoadingOperation = {
  type: 'initial',
  label: 'Loading map',
  startedAt: performance.now(),
};

export const runtime: AppRuntime = {
  activeAreaKey: initialAreaKey,
  activeProduct: initialProduct,
  basemapInstallScheduled: false,
  circumferenceLandmasses: null,
  futureStreetAccessStationIds: [],
  initialLoadComplete: false,
  liveStreetRefreshInFlight: false,
  liveStreetRefreshPending: false,
  liveStreetRefreshSequence: 0,
  liveStreetRefreshTimer: undefined,
  loadingCanFinish: false,
  loadingOperation: initialLoadingOperation,
  loadedStations: {
    features: [],
    type: 'FeatureCollection',
  },
  loadSequence: 0,
  maxDistanceMeters: 5000,
  pendingBasemapStyle: null,
  selectedStreetProperties: null,
  streetAccessStationIds: [],
};

export const circumferenceCanvas = document.createElement('canvas');
circumferenceCanvas.id = 'circumference-gradient-canvas';
circumferenceCanvas.width = CIRCUMFERENCE_GRADIENT_TEXTURE_SIZE;
circumferenceCanvas.height = CIRCUMFERENCE_GRADIENT_TEXTURE_SIZE;
circumferenceCanvas.hidden = true;
document.body.append(circumferenceCanvas);

export const circumferenceState: CircumferenceState = {
  areaKey: null,
  candidates: [],
  geometryMode: null,
  geometryVariants: null,
  network: {
    segments: [],
    stations: [],
  },
  selected: null,
  overrideId: '',
  methodology: null,
  inspectedSegmentId: '',
  requiredSegmentIds: new Set<string>(),
  avoidedSegmentIds: new Set<string>(),
};

export const LIVE_ROAD_CLASSES = new Set([
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'minor',
  'service',
  'track',
]);

export const stationColor = expressionSpecificationSchema.parse([
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
]);

export const openStationFilter = filterSpecificationSchema.parse([
  '==',
  ['get', 'status'],
  'open',
]);
export const futureStationFilter = filterSpecificationSchema.parse([
  '!=',
  ['get', 'status'],
  'open',
]);
export const openStationLayers = [
  'station-points-open',
  'station-destination',
  'station-labels-open',
];
export const filterableOpenStationLayers = [
  'station-points-open',
  'station-labels-open',
];
export const futureStationLayers = ['station-points-future', 'station-labels-future'];
export const activeStationModes = new Set<Mode>();
export const allStationModes = new Set<Mode>();
export const futureStationModes = new Set<Mode>();
window.__transitPerformance = {
  startedAt: initialLoadingOperation.startedAt,
  circumferenceReadyMs: null,
  initialReadyMs: null,
  styleLoadedMs: null,
  dataFetchedMs: null,
  firstStreetRenderMs: null,
  lastInteractionMs: null,
  operations: [],
};

export const state: AppState = {
  metadata: null,
  stationById: new Map(),
  transitGraph: null,
  transitTimes: null,
  destination: null,
  destinationStationIds: [],
  destinationChoiceByStationId: new Map(),
  destinationIdsByChoice: new Map(),
  schedules: null,
  scheduleWeekday: 0,
  scheduleMinute: 8 * 60,
  waitMinutesByStation: new Map(),
  waitMinutesByService: new Map(),
  waitDetailsByStation: new Map(),
  waitDetailsByService: new Map(),
  timeScaleMinutes: DEFAULT_TIME_SCALE_MINUTES,
};

export const WEEKDAY_LABELS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

export function formatInteger(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return '--';
  if (meters < 950) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

export function formatMinutes(minutes: number): string {
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

export function formatArea(squareMeters: number): string {
  if (!Number.isFinite(squareMeters)) return '--';
  const squareKilometers = squareMeters / 1_000_000;
  if (squareKilometers >= 1_000_000) {
    return `${(squareKilometers / 1_000_000).toFixed(2)}M km²`;
  }
  if (squareKilometers >= 10_000) {
    return `${formatInteger(Math.round(squareKilometers))} km²`;
  }
  if (squareKilometers >= 100) {
    return `${formatInteger(Math.round(squareKilometers))} km²`;
  }
  return `${squareKilometers.toFixed(2)} km²`;
}

export function formatRouteLength(meters: number): string {
  if (!Number.isFinite(meters)) return '--';
  return `${(meters / 1000).toFixed(1)} km`;
}

export function formatTimeInput(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainder = Math.round(minutes % 60);
  return `${String(hours).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

export function currentDeparture(timeZone: string): {
  readonly minute: number;
  readonly weekday: number;
} {
  const parts = new Map(
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
  const weekdayByShortName: Readonly<Record<string, number>> = {
    Mon: 0,
    Tue: 1,
    Wed: 2,
    Thu: 3,
    Fri: 4,
    Sat: 5,
    Sun: 6,
  };

  return {
    weekday: weekdayByShortName[parts.get('weekday') ?? ''] ?? 0,
    minute: Number(parts.get('hour') ?? '0') * 60 + Number(parts.get('minute') ?? '0'),
  };
}

export function setCurrentDeparture(area: AreaConfig): void {
  const departure = currentDeparture(area.timezone);
  state.scheduleWeekday = departure.weekday;
  state.scheduleMinute = departure.minute;
  scheduleDaySelect.value = String(departure.weekday);
  scheduleTimeInput.value = formatTimeInput(departure.minute);
}

export function departureLabel(): string {
  return `${WEEKDAY_LABELS[state.scheduleWeekday] ?? 'Monday'} at ${formatTimeInput(
    state.scheduleMinute,
  )}`;
}

export function timeStreetColor(
  transitTimes: ReadonlyMap<string, number>,
  scaleMinutes: number,
): ExpressionSpecification {
  const stops = timeScaleStops(scaleMinutes);
  const candidateTimes: unknown[][] = [];

  const appendDirectCandidates = (): void => {
    for (let candidateIndex = 0; candidateIndex < 5; candidateIndex += 1) {
      const suffix = candidateIndex === 0 ? '' : String(candidateIndex + 1);
      const stationTime: unknown[] = ['match', ['get', `s${suffix}`]];
      for (const [stationId, minutes] of transitTimes) {
        stationTime.push(stationId, Number(minutes.toFixed(2)));
      }
      stationTime.push(90);
      candidateTimes.push([
        '+',
        [
          '/',
          ['to-number', ['coalesce', ['get', `d${suffix}`], 7_200]],
          WALKING_METERS_PER_MINUTE,
        ],
        stationTime,
      ]);
    }
  };

  const appendIndexedCandidates = (
    distanceProperties: DistanceProperties,
    accessProperties: DistanceProperties,
    stationIds: readonly string[],
    availableModes: ReadonlySet<Mode> | null = null,
  ): void => {
    for (const mode of activeStationModes) {
      if (availableModes && !availableModes.has(mode)) continue;
      const distanceProperty = distanceProperties[mode];
      const accessProperty = accessProperties[mode];
      if (!distanceProperty || !accessProperty) continue;

      const stationTime: unknown[] = [
        'match',
        ['to-number', ['get', accessProperty], -1],
      ];
      for (const [stationIndex, stationId] of stationIds.entries()) {
        if (state.stationById.get(stationId)?.properties.mode !== mode) continue;
        const minutes = transitTimes.get(stationId);
        if (minutes !== undefined && Number.isFinite(minutes)) {
          stationTime.push(stationIndex, Number(minutes.toFixed(2)));
        }
      }
      stationTime.push(90);
      candidateTimes.push([
        '+',
        [
          '/',
          ['to-number', ['get', distanceProperty], runtime.maxDistanceMeters],
          WALKING_METERS_PER_MINUTE,
        ],
        stationTime,
      ]);
    }
  };

  appendDirectCandidates();
  if (!AREAS[runtime.activeAreaKey].liveRoads) {
    appendIndexedCandidates(
      MODE_DISTANCE_PROPERTIES,
      MODE_ACCESS_PROPERTIES,
      runtime.streetAccessStationIds,
    );
    if (futureStationToggle.checked) {
      appendIndexedCandidates(
        FUTURE_MODE_DISTANCE_PROPERTIES,
        FUTURE_MODE_ACCESS_PROPERTIES,
        runtime.futureStreetAccessStationIds,
        futureStationModes,
      );
    }
  }

  const totalTime =
    candidateTimes.length === 0
      ? 90
      : candidateTimes.length === 1
        ? candidateTimes[0]
        : ['min', ...candidateTimes];

  return expressionSpecificationSchema.parse([
    'interpolate',
    ['linear'],
    totalTime,
    0,
    COLORS.near,
    stops.yellowMinutes / 2,
    COLORS.nearMid,
    stops.yellowMinutes * 0.75,
    COLORS.midNear,
    stops.yellowMinutes,
    COLORS.mid,
    stops.orangeMinutes,
    COLORS.midFar,
    (stops.orangeMinutes + stops.redMinutes) / 2,
    COLORS.farMid,
    stops.redMinutes,
    COLORS.far,
  ]);
}
