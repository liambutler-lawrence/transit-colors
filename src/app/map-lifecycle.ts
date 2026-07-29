import type { FeatureIdentifier } from 'maplibre-gl';

import { selectCircumferenceCandidate } from '../circumference.js';
import { circumferenceGeometryVariantsSchema } from '../circumference/schema.js';
import type { CircumferenceGeometryVariants } from '../circumference/types.js';
import { createCircumferenceGradientSource } from '../circumference-gradient-source.js';
import { createStreetAccessScorer, splitStreetFeatures } from '../routing.js';
import {
  landmassDataSchema,
  mapFeaturePropertiesSchema,
  metadataSchema,
  scheduleSchema,
  stationCollectionSchema,
  stationPropertiesSchema,
  streetFeatureSchema,
  streetPropertiesSchema,
  type StationCollection,
  type StreetFeature,
} from '../domain.js';
import { fetchParsed } from '../parse.js';
import {
  segmentPropertiesSchema,
  styleSpecificationSchema,
  type AreaConfig,
  type AreaKey,
} from './types.js';
import {
  activeStationCollection,
  activeStreetSourceId,
  applyMapBounds,
  beginLoading,
  finishLoading,
  installBasemap,
  renderDestinationOptions,
  renderMetadata,
  resetDestinationRouting,
  resetSelection,
  runMapUpdate,
  setActiveProduct,
  streetColorExpression,
  syncStationFilters,
  syncStationVisibility,
  syncStreetColor,
  syncStreetVisibility,
  updateAreaChrome,
  updateViewportStatistics,
  visibleTiledStreets,
} from './access-controls.js';
import {
  focusCircumferenceArea,
  prepareCircumferenceRoute,
  renderCircumferenceCandidate,
  resetCircumferenceItemDetails,
  storeCircumferenceOverride,
  syncCircumferenceVisibility,
} from './circumference-ui.js';
import { installCircumferenceLayers } from './circumference-layers.js';
import {
  fitHighwayCircumference,
  installHighwayHover,
} from './highway-circumference-ui.js';
import { firstSymbolLayerId } from './map-ui-utils.js';
import {
  applyInspectedSegmentOverride,
  applyTimeScale,
  rebuildDestinationTransitGraph,
  selectDestination,
  showCircumferenceSegment,
  showStationFeature,
  showStreetFeature,
  updateScheduleContext,
  updateTimeScale,
} from './feature-details.js';
import {
  AREAS,
  AREA_KEYS,
  COLORS,
  LIVE_ROAD_CLASSES,
  MODE_LABELS,
  accessProductButton,
  activeStationModes,
  areaSelect,
  circumferenceCanvases,
  circumferenceProductButton,
  circumferenceResultsEl,
  circumferenceScheduleDaySelect,
  circumferenceScheduleTimeInput,
  circumferenceState,
  circumferenceStates,
  destinationSelect,
  featureSummaryEl,
  futureStationFilter,
  futureStationToggle,
  geoJsonSource,
  initialAreaKey,
  initialProduct,
  isAreaKey,
  isMode,
  map,
  mapEl,
  mapLoadingLabelEl,
  openStationFilter,
  routeAreaToggle,
  routeAutoButton,
  routeAvoidSegmentButton,
  routeChoiceSelect,
  routeClearSegmentsButton,
  routeCriterionSelect,
  routeGradientToggle,
  routeRequireSegmentButton,
  routeStationsToggle,
  routeTrackGeometryToggle,
  runtime,
  scheduleDaySelect,
  scheduleTimeInput,
  setActiveCircumferenceState,
  setCurrentDeparture,
  state,
  stationBreakdownEl,
  stationColor,
  stationToggle,
  streetToggle,
  timeScaleInput,
  updateStatus,
} from './context.js';

export function installHover(): void {
  const stationLayerIds = ['station-points-open', 'station-points-future'];
  const streetLayers = [
    { id: 'street-proximity', source: 'streets', sourceLayer: 'streets' },
    { id: 'live-street-proximity', source: 'live-streets' },
  ];

  for (const layer of streetLayers) {
    let hoveredId: string | number | null = null;
    const target = (id: string | number): FeatureIdentifier => ({
      source: layer.source,
      ...(layer.sourceLayer ? { sourceLayer: layer.sourceLayer } : {}),
      id,
    });

    map.on('mousemove', layer.id, (event) => {
      const feature = event.features?.[0];
      if (!feature || feature.id === undefined) return;
      const properties = streetPropertiesSchema.safeParse(feature.properties);
      if (!properties.success) return;

      if (hoveredId !== null) {
        map.setFeatureState(target(hoveredId), { hover: false });
      }
      hoveredId = feature.id;
      map.setFeatureState(target(hoveredId), { hover: true });
      showStreetFeature(properties.data);
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
      const properties = streetPropertiesSchema.safeParse(feature?.properties);
      if (properties.success) showStreetFeature(properties.data);
    });
  }

  for (const layerId of stationLayerIds) {
    map.on('mousemove', layerId, (event) => {
      const feature = event.features?.[0];
      if (!feature) return;
      const properties = stationPropertiesSchema.safeParse(feature.properties);
      if (!properties.success) return;

      showStationFeature(properties.data);
      map.getCanvas().style.cursor = 'pointer';
    });

    map.on('mouseleave', layerId, () => {
      map.getCanvas().style.cursor = '';
    });

    map.on('click', layerId, (event) => {
      const feature = event.features?.[0];
      if (!feature) return;
      const properties = stationPropertiesSchema.safeParse(feature.properties);
      if (!properties.success) return;
      showStationFeature(properties.data);
      if (
        AREAS[runtime.activeAreaKey].supportsDestination &&
        properties.data.status === 'open' &&
        properties.data.name
      ) {
        selectDestination(properties.data.id);
      }
    });
  }

  let hoveredCircumferenceSegmentId: string | number | null = null;
  const circumferenceSegmentLayerIds = [
    'circumference-route-alternative-line',
    'circumference-route-line',
    'circumference-transfer-line',
  ];
  for (const layerId of circumferenceSegmentLayerIds) {
    map.on('mousemove', layerId, (event) => {
      const feature = event.features?.[0];
      if (!feature || feature.id === undefined) return;
      const properties = segmentPropertiesSchema.safeParse(feature.properties);
      if (!properties.success) return;
      if (hoveredCircumferenceSegmentId !== null) {
        map.setFeatureState(
          {
            source: 'circumference-route',
            id: hoveredCircumferenceSegmentId,
          },
          { hover: false },
        );
      }
      hoveredCircumferenceSegmentId = feature.id;
      map.setFeatureState(
        { source: 'circumference-route', id: feature.id },
        { hover: true },
      );
      showCircumferenceSegment(properties.data);
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', layerId, () => {
      if (hoveredCircumferenceSegmentId !== null) {
        map.setFeatureState(
          {
            source: 'circumference-route',
            id: hoveredCircumferenceSegmentId,
          },
          { hover: false },
        );
      }
      hoveredCircumferenceSegmentId = null;
      map.getCanvas().style.cursor = '';
    });
    map.on('click', layerId, (event) => {
      const feature = event.features?.[0];
      const properties = segmentPropertiesSchema.safeParse(feature?.properties);
      if (!properties.success) return;
      if (properties.data.area_key !== runtime.activeAreaKey) {
        areaSelect.value = properties.data.area_key;
        areaSelect.dispatchEvent(new Event('change'));
      }
      showCircumferenceSegment(properties.data);
    });
  }

  installHighwayHover();
}

export function loadedLiveRoads(): StreetFeature[] {
  const roadLayerIds = map
    .getStyle()
    .layers.filter(
      (layer) =>
        layer.type === 'line' &&
        layer.source === 'openmaptiles' &&
        layer['source-layer'] === 'transportation' &&
        !/(?:_casing$|rail|hatching|path|pedestrian)/.test(layer.id),
    )
    .map((layer) => layer.id);
  const features = map.queryRenderedFeatures({ layers: roadLayerIds });
  const seen = new Set<string>();
  const roads: StreetFeature[] = [];

  for (const feature of features) {
    const propertyPayload: unknown = feature.properties;
    const parsedProperties = mapFeaturePropertiesSchema.safeParse(propertyPayload);
    if (!parsedProperties.success) continue;
    const properties = parsedProperties.data;
    const roadClass = properties['class'];
    if (typeof roadClass !== 'string') continue;
    if (!LIVE_ROAD_CLASSES.has(roadClass)) continue;

    const lines =
      feature.geometry?.type === 'LineString'
        ? [feature.geometry.coordinates]
        : feature.geometry?.type === 'MultiLineString'
          ? feature.geometry.coordinates
          : [];

    for (const coordinates of lines) {
      if (!Array.isArray(coordinates) || coordinates.length < 2) continue;
      const candidate = streetFeatureSchema.safeParse({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates },
        properties: {
          n:
            typeof properties['name'] === 'string'
              ? properties['name']
              : typeof properties['name:latin'] === 'string'
                ? properties['name:latin']
                : '',
          h: roadClass,
          class: roadClass,
          brunnel:
            typeof properties['brunnel'] === 'string' ? properties['brunnel'] : '',
          d: 0,
        },
      });
      if (!candidate.success) continue;
      const key = `${roadClass}|${candidate.data.properties['brunnel'] ?? ''}|${JSON.stringify(coordinates)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      roads.push(candidate.data);
    }
  }

  // Always split shared junctions so one source feature cannot give several
  // blocks one score. A looser cap keeps the generalized overview lightweight;
  // local zooms use the same 200m block-scale cap as the precomputed tiles.
  return splitStreetFeatures(roads, {
    maxLengthMeters: map.getZoom() < 12 ? 400 : 200,
  });
}

export async function refreshLiveStreetData(
  refreshSequence: number,
  areaSequence: number,
): Promise<void> {
  if (
    refreshSequence !== runtime.liveStreetRefreshSequence ||
    areaSequence !== runtime.loadSequence ||
    !AREAS[runtime.activeAreaKey].liveRoads ||
    !map.getSource('live-streets')
  ) {
    return;
  }

  if (runtime.liveStreetRefreshInFlight) {
    runtime.liveStreetRefreshPending = true;
    return;
  }

  runtime.liveStreetRefreshInFlight = true;
  try {
    const roadFeatures = loadedLiveRoads();
    if (roadFeatures.length === 0) return;

    const activeStations = activeStationCollection().features;
    updateStatus('Indexing streets');

    if (activeStations.length > 0) {
      await createStreetAccessScorer(activeStations, {
        exhaustive: true,
        stationFilter: () => true,
      }).scoreAsync(roadFeatures, { batchSize: 500, candidateCount: 5 });
    } else {
      for (const feature of roadFeatures) {
        feature.properties.d = runtime.maxDistanceMeters;
        feature.properties['s'] = '';
      }
    }

    if (
      refreshSequence !== runtime.liveStreetRefreshSequence ||
      areaSequence !== runtime.loadSequence ||
      !AREAS[runtime.activeAreaKey].liveRoads
    ) {
      return;
    }

    geoJsonSource('live-streets')?.setData({
      type: 'FeatureCollection',
      features: roadFeatures,
    });
    syncStreetColor();
    syncStreetVisibility();
    updateViewportStatistics();
    updateStatus(state.destination ? 'Destination set' : 'Ready');
  } finally {
    runtime.liveStreetRefreshInFlight = false;
    if (runtime.liveStreetRefreshPending) {
      runtime.liveStreetRefreshPending = false;
      scheduleLiveStreetRefresh();
    }
  }
}

export function scheduleLiveStreetRefresh(): void {
  if (runtime.activeProduct !== 'access' || !AREAS[runtime.activeAreaKey].liveRoads)
    return;

  window.clearTimeout(runtime.liveStreetRefreshTimer);
  const refreshSequence = ++runtime.liveStreetRefreshSequence;
  const areaSequence = runtime.loadSequence;
  runtime.liveStreetRefreshTimer = window.setTimeout(() => {
    const refresh = (): void => {
      void refreshLiveStreetData(refreshSequence, areaSequence);
    };
    if (map.areTilesLoaded()) {
      refresh();
    } else {
      void map.once('idle', refresh);
    }
  }, 120);
}

export function installMapData(stations: StationCollection): void {
  const existingStations = geoJsonSource('stations');

  if (existingStations) {
    existingStations.setData(stations);
    return;
  }

  const labelLayerId = firstSymbolLayerId();
  const streetTiles = AREAS['cdmx'].streetTiles;
  if (streetTiles === undefined) {
    throw new Error('CDMX street tile URL is not configured');
  }
  const streetTilesUrl = new URL(streetTiles, window.location.href).href;

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

  map.addSource('circumference-route', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  map.addSource('highway-circumference', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
    generateId: true,
  });

  const highwayTilesUrl = new URL(
    'data/north-america-highways.pmtiles?v=20260728d',
    window.location.href,
  ).href;
  map.addSource('highway-network', {
    type: 'vector',
    url: `pmtiles://${highwayTilesUrl}`,
    attribution: '© OpenStreetMap contributors',
    promoteId: 'id',
  });

  for (const areaKey of AREA_KEYS) {
    const sourceId = `circumference-gradient-${areaKey}`;
    const fallbackGradientBounds: Record<AreaKey, [number, number, number, number]> = {
      cdmx: [-99.42, 19.18, -98.84, 19.66],
      nyc: [-74.08, 40.54, -73.7, 40.9],
      singapore: [103.55, 1.15, 104.1, 1.5],
      atlanta: [-84.6, 33.55, -84.15, 34.05],
      athens: [23.55, 37.78, 24.05, 38.2],
    };
    const gradientBounds =
      runtime.circumferenceLandmasses?.areas[areaKey].gradient_bounds ??
      fallbackGradientBounds[areaKey];
    map.addSource(
      sourceId,
      createCircumferenceGradientSource(
        circumferenceCanvases[areaKey].toDataURL('image/png'),
        gradientBounds,
      ),
    );
    map.addLayer({
      id: sourceId,
      type: 'raster',
      source: sourceId,
      layout: { visibility: 'none' },
      paint: {
        'raster-opacity': 0.9,
        'raster-fade-duration': 0,
        'raster-resampling': 'linear',
      },
    });
  }

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
        'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.75, 12, 1.8, 15, 4.2],
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
        'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.75, 12, 1.8, 15, 4.2],
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

  installCircumferenceLayers();

  installHover();
  syncCircumferenceVisibility();
}

export function scheduleDestinationSetup(
  areaKey: AreaKey,
  area: AreaConfig,
  stations: StationCollection,
  sequence: number,
): void {
  if (!area.supportsDestination) return;

  const start = (): void => {
    const schedules = runtime.circumferenceSchedules[areaKey];
    if (sequence !== runtime.loadSequence) return;

    const initializeDestination = (): void => {
      if (sequence !== runtime.loadSequence) return;
      state.schedules = schedules;
      rebuildDestinationTransitGraph();
      renderDestinationOptions(stations.features);
      prepareCircumferenceRoute(sequence);
    };

    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(initializeDestination, { timeout: 2_000 });
    } else {
      setTimeout(initializeDestination, 0);
    }
  };

  if (runtime.loadingOperation) {
    window.addEventListener(
      'transit:ready',
      () => {
        start();
      },
      { once: true },
    );
  } else {
    start();
  }
}

async function fetchCircumferenceGeometryVariants(
  url: string,
): Promise<CircumferenceGeometryVariants> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to load precomputed circumference data: ${response.status} ${response.statusText}`,
    );
  }
  return circumferenceGeometryVariantsSchema.parse(await response.json());
}

export async function loadArea(
  areaKey: AreaKey,
  {
    fit = true,
    initial = false,
  }: { readonly fit?: boolean; readonly initial?: boolean } = {},
): Promise<void> {
  const area = AREAS[areaKey];
  const sequence = ++runtime.loadSequence;
  runtime.liveStreetRefreshSequence += 1;
  window.clearTimeout(runtime.liveStreetRefreshTimer);

  if (!initial) beginLoading(`Loading ${area.label}`, 'area');
  runtime.activeAreaKey = areaKey;
  setActiveCircumferenceState(areaKey);
  if (initial) setCurrentDeparture(area);
  resetDestinationRouting();
  updateAreaChrome(areaKey);
  resetSelection();

  try {
    const [stations, metadata] = await Promise.all([
      fetchParsed(area.stations, stationCollectionSchema),
      fetchParsed(area.metadata, metadataSchema),
    ]);

    if (sequence !== runtime.loadSequence) return;

    state.metadata = metadata;
    state.stationById = new Map(
      stations.features.map((feature) => [feature.properties.id, feature]),
    );

    runtime.loadedStations = stations;
    runtime.streetAccessStationIds = stations.features
      .filter((feature) => feature.properties.status === 'open')
      .map((feature) => feature.properties.id);
    runtime.futureStreetAccessStationIds = stations.features
      .filter((feature) => feature.properties.status !== 'open')
      .map((feature) => feature.properties.id);
    renderMetadata(metadata);
    installMapData(stations);
    if (fit) applyMapBounds(metadata);

    if (area.liveRoads && runtime.pendingBasemapStyle) installBasemap();
    syncStationFilters();
    syncStreetColor();
    syncStreetVisibility();
    syncStationVisibility();
    syncCircumferenceVisibility();
    updateViewportStatistics();
    prepareCircumferenceRoute(sequence);
    window.__transitPerformance.dataFetchedMs =
      performance.now() - window.__transitPerformance.startedAt;
    scheduleDestinationSetup(areaKey, area, stations, sequence);

    if (area.liveRoads || runtime.activeProduct === 'circumference') {
      scheduleLiveStreetRefresh();
      runtime.loadingCanFinish = true;
      requestAnimationFrame(() => requestAnimationFrame(finishLoading));
    }
  } catch (error) {
    if (sequence !== runtime.loadSequence) return;
    console.error(error);
    runtime.loadingOperation = null;
    runtime.loadingCanFinish = false;
    updateStatus('Data missing', { isError: true });
    mapLoadingLabelEl.textContent = 'Map data could not be loaded';
    mapEl.setAttribute('aria-busy', 'false');
    featureSummaryEl.textContent = `Run ${area.buildCommand}, then refresh.`;
  }
}

export async function initialize(): Promise<void> {
  try {
    const [basemapStyle, landmasses, circumferenceEntries] = await Promise.all([
      fetchParsed('vendor/openfreemap-liberty.json', styleSpecificationSchema),
      fetchParsed('data/circumference-landmasses.json?v=20260727d', landmassDataSchema),
      Promise.all(
        AREA_KEYS.map(async (areaKey) => ({
          areaKey,
          geometryVariants: await fetchCircumferenceGeometryVariants(
            AREAS[areaKey].circumference,
          ),
          schedules: await fetchParsed(AREAS[areaKey].schedules, scheduleSchema).catch(
            () => null,
          ),
        })),
      ),
    ]);
    runtime.pendingBasemapStyle = basemapStyle;
    runtime.circumferenceLandmasses = landmasses;
    for (const { areaKey, geometryVariants, schedules } of circumferenceEntries) {
      circumferenceStates[areaKey].geometryVariants = geometryVariants;
      runtime.circumferenceSchedules[areaKey] = schedules;
    }
    setActiveCircumferenceState(initialAreaKey);
    await loadArea(initialAreaKey, { initial: true });
  } catch (error) {
    console.error(error);
    runtime.loadingOperation = null;
    updateStatus('Map unavailable', { isError: true });
    mapLoadingLabelEl.textContent = 'Map could not be initialized';
    mapEl.setAttribute('aria-busy', 'false');
  }
}

window.addEventListener('transit:refresh-live-roads', scheduleLiveStreetRefresh);

stationBreakdownEl.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest('.mode-pill[data-mode]');
  if (!(button instanceof HTMLButtonElement) || !stationBreakdownEl.contains(button)) {
    return;
  }

  const { mode } = button.dataset;
  if (!isMode(mode)) return;
  const nextActive = button.getAttribute('aria-pressed') !== 'true';

  button.setAttribute('aria-pressed', String(nextActive));
  button.title = `${nextActive ? 'Hide' : 'Show'} ${MODE_LABELS[mode]} stations`;

  if (nextActive) {
    activeStationModes.add(mode);
  } else {
    activeStationModes.delete(mode);
  }

  runMapUpdate('Updating filter', () => {
    syncStationFilters();
    if (AREAS[runtime.activeAreaKey].liveRoads) {
      scheduleLiveStreetRefresh();
    } else {
      syncStreetColor();
    }
    updateViewportStatistics();

    if (runtime.selectedStreetProperties) {
      showStreetFeature(runtime.selectedStreetProperties);
    }
  });
});

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
    rebuildDestinationTransitGraph();
    if (AREAS[runtime.activeAreaKey].liveRoads) {
      scheduleLiveStreetRefresh();
    } else {
      syncStreetColor();
    }
    updateViewportStatistics();

    if (runtime.selectedStreetProperties) {
      showStreetFeature(runtime.selectedStreetProperties);
    }
  });
});

map.on('sourcedataloading', (event) => {
  if (
    event.sourceId !== 'streets' ||
    AREAS[runtime.activeAreaKey].liveRoads ||
    !runtime.initialLoadComplete
  ) {
    return;
  }

  if (!runtime.loadingOperation) {
    beginLoading('Loading area', 'area');
  }
});

map.on('sourcedata', (event) => {
  if (
    event.sourceId === 'openmaptiles' &&
    event.isSourceLoaded &&
    AREAS[runtime.activeAreaKey].liveRoads
  ) {
    scheduleLiveStreetRefresh();
  }
});

function nearestConfiguredArea(): AreaKey | null {
  if (map.getZoom() < 7) return null;
  const center = map.getCenter();
  let nearest: { readonly areaKey: AreaKey; readonly distance: number } | null = null;
  for (const areaKey of AREA_KEYS) {
    const [longitude, latitude] = AREAS[areaKey].center;
    const longitudeScale = Math.cos((center.lat * Math.PI) / 180);
    const distance = Math.hypot(
      (center.lng - longitude) * longitudeScale,
      center.lat - latitude,
    );
    if (!nearest || distance < nearest.distance) {
      nearest = { areaKey, distance };
    }
  }
  return nearest && nearest.distance <= 4 ? nearest.areaKey : null;
}

function followAccessMapFocus(): void {
  if (runtime.activeProduct !== 'access' || runtime.loadingOperation?.type === 'area') {
    return;
  }
  const areaKey = nearestConfiguredArea();
  if (!areaKey || areaKey === runtime.activeAreaKey) return;
  void loadArea(areaKey, { fit: false });
}

map.on('moveend', () => {
  scheduleLiveStreetRefresh();
  followAccessMapFocus();
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
    runtime.loadingOperation?.type !== 'filter' &&
    (renderedStreets.length > 0 ||
      !streetToggle.checked ||
      runtime.activeProduct === 'circumference')
  ) {
    runtime.loadingCanFinish = true;
    finishLoading();
  }
});
areaSelect.addEventListener('change', () => {
  const areaKey = areaSelect.value;
  if (!isAreaKey(areaKey) || areaKey === runtime.activeAreaKey) return;
  if (runtime.activeProduct === 'circumference') {
    runtime.activeAreaKey = areaKey;
    updateAreaChrome(areaKey);
    resetCircumferenceItemDetails();
    focusCircumferenceArea(areaKey);
  }
  void loadArea(areaKey, { fit: runtime.activeProduct !== 'circumference' });
});

circumferenceResultsEl.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const highwayFocusButton = target.closest<HTMLButtonElement>(
    'button[data-focus-highway]',
  );
  if (highwayFocusButton && circumferenceResultsEl.contains(highwayFocusButton)) {
    fitHighwayCircumference();
    return;
  }
  const focusButton = target.closest<HTMLButtonElement>(
    'button[data-focus-area][data-focus-candidate]',
  );
  if (!focusButton || !circumferenceResultsEl.contains(focusButton)) return;
  const areaKey = focusButton.dataset['focusArea'];
  const candidateId = focusButton.dataset['focusCandidate'];
  if (!isAreaKey(areaKey)) return;
  if (
    !candidateId ||
    !circumferenceStates[areaKey].candidates.some(
      (candidate) => candidate.id === candidateId,
    )
  ) {
    return;
  }
  if (areaKey !== runtime.activeAreaKey) {
    areaSelect.value = areaKey;
    areaSelect.dispatchEvent(new Event('change'));
  }
  routeChoiceSelect.value = candidateId;
  routeChoiceSelect.dispatchEvent(new Event('change'));
});

accessProductButton.addEventListener('click', () => {
  setActiveProduct('access');
});

circumferenceProductButton.addEventListener('click', () => {
  setActiveProduct('circumference');
});

routeCriterionSelect.addEventListener('change', () => {
  resetCircumferenceItemDetails(
    routeCriterionSelect.value === 'motorway'
      ? 'Loading controlled-access highways'
      : 'Click a line or walking link',
  );
  updateAreaChrome(runtime.activeAreaKey);
  prepareCircumferenceRoute();
});

routeChoiceSelect.addEventListener('change', () => {
  circumferenceState.requiredSegmentIds.clear();
  circumferenceState.avoidedSegmentIds.clear();
  circumferenceState.overrideId = routeChoiceSelect.value;
  storeCircumferenceOverride(runtime.activeAreaKey, circumferenceState.overrideId);
  routeAutoButton.disabled = !circumferenceState.overrideId;
  const candidate = selectCircumferenceCandidate(
    circumferenceState.candidates,
    circumferenceState.overrideId,
  );
  renderCircumferenceCandidate(candidate, { fit: true });
  updateStatus(circumferenceState.overrideId ? 'Route pinned' : 'Route ready');
});

routeAutoButton.addEventListener('click', () => {
  routeChoiceSelect.value = '';
  routeChoiceSelect.dispatchEvent(new Event('change'));
});

routeRequireSegmentButton.addEventListener('click', () => {
  applyInspectedSegmentOverride('require');
});

routeAvoidSegmentButton.addEventListener('click', () => {
  applyInspectedSegmentOverride('avoid');
});

routeClearSegmentsButton.addEventListener('click', () => {
  routeChoiceSelect.value = '';
  routeChoiceSelect.dispatchEvent(new Event('change'));
});

for (const toggle of [routeGradientToggle, routeStationsToggle, routeAreaToggle]) {
  toggle.addEventListener('change', () => {
    syncCircumferenceVisibility();
  });
}

routeTrackGeometryToggle.addEventListener('change', () => {
  updateStatus(
    routeTrackGeometryToggle.checked ? 'Following track paths' : 'Using straight edges',
    { isLoading: true },
  );
  for (const areaKey of AREA_KEYS) {
    circumferenceStates[areaKey].candidates = [];
  }
  requestAnimationFrame(() => {
    prepareCircumferenceRoute();
  });
});

destinationSelect.addEventListener('change', () => {
  selectDestination(destinationSelect.value);
});

scheduleDaySelect.addEventListener('change', () => {
  updateScheduleContext('access');
});
scheduleTimeInput.addEventListener('change', () => {
  updateScheduleContext('access');
});
circumferenceScheduleDaySelect.addEventListener('change', () => {
  updateScheduleContext('circumference');
});
circumferenceScheduleTimeInput.addEventListener('change', () => {
  updateScheduleContext('circumference');
});

timeScaleInput.addEventListener('input', () => {
  if (timeScaleInput.value === '') return;
  updateTimeScale(timeScaleInput.value);
});

timeScaleInput.addEventListener('change', () => {
  updateTimeScale(timeScaleInput.value);
});

setCurrentDeparture(AREAS[initialAreaKey]);
applyTimeScale();
setActiveProduct(initialProduct, { fit: false, updateUrl: false });

void map.once('style.load', () => {
  window.__transitPerformance.styleLoadedMs =
    performance.now() - window.__transitPerformance.startedAt;
  void initialize();
});
