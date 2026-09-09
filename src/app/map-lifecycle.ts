import { VectorTileSource } from 'maplibre-gl';
import { ROAD_SOURCE } from '../transit-road-tiles.js';
import { atlasStationMetadata, createTransitAtlasLoader } from '../transit-atlas.js';

import { selectCircumferenceCandidate } from '../circumference.js';
import { createCircumferenceGradientSource } from '../circumference-gradient-source.js';
import {
  landmassDataSchema,
  scheduleSchema,
  stationPropertiesSchema,
  streetPropertiesSchema,
  type StationCollection,
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
  renderAccessResults,
  resetDestinationRouting,
  resetSelection,
  runMapUpdate,
  setActiveProduct,
  syncStationFilters,
  syncStationVisibility,
  syncStreetColor,
  syncStreetVisibility,
  updateAreaChrome,
  updateViewportStatistics,
  visibleTiledStreets,
} from './access-controls.js';
import { fetchCircumferenceGeometryVariants } from './circumference-data.js';
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
import { installJerseyCityLandUse } from './land-use-ui.js';
import { installTimezoneSkew } from './timezone-skew-ui.js';
import { fetchTimezoneMapData } from './timezone-data.js';
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
  MODE_LABELS,
  activeStationModes,
  accessResultsEl,
  areaSelect,
  circumferenceCanvases,
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
  heatmapRoadLayers,
  roadTileTemplates,
  transitRoadTiles,
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
  const inspectStreet = (point: { x: number; y: number }): boolean => {
    if (runtime.activeProduct !== 'access' || !streetToggle.checked) return false;
    const layers = [...heatmapRoadLayers.keys()];
    if (!layers.length) return false;
    const feature = map.queryRenderedFeatures([point.x, point.y], { layers })[0];
    const properties = streetPropertiesSchema.safeParse(feature?.properties);
    if (!feature || !properties.success) return false;
    showStreetFeature(properties.data);
    return true;
  };
  map.on('mousemove', (event) => {
    map.getCanvas().style.cursor = inspectStreet(event.point) ? 'pointer' : '';
  });
  map.on('click', (event) => {
    inspectStreet(event.point);
  });

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
      const inspect = (): void => {
        showStationFeature(properties.data);
        if (
          AREAS[runtime.activeAreaKey].supportsDestination &&
          properties.data.status === 'open' &&
          properties.data.name
        ) {
          selectDestination(properties.data.id);
        }
      };
      const areaKey = properties.data['area_key'];
      if (isAreaKey(areaKey) && areaKey !== runtime.activeAreaKey) {
        void loadArea(areaKey, { fit: false }).then(() => {
          if (runtime.activeAreaKey === areaKey) inspect();
        });
      } else {
        inspect();
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

export function scheduleLiveStreetRefresh(): void {
  if (!transitRoadTiles.setStations(activeStationCollection().features)) return;
  const source = map.getSource(ROAD_SOURCE);
  if (source instanceof VectorTileSource) {
    source.setTiles(transitRoadTiles.urls(roadTileTemplates));
  }
}

export function installMapData(stations: StationCollection): void {
  const existingStations = geoJsonSource('stations');

  if (existingStations) {
    existingStations.setData(stations);
    return;
  }

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
    'data/north-america-highways.pmtiles?v=20260909a',
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

    if (runtime.initialLoadComplete) {
      initializeDestination();
    } else if ('requestIdleCallback' in window) {
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

const loadTransitAtlas = createTransitAtlasLoader(AREAS, AREA_KEYS);

async function installTransitAtlas(): Promise<void> {
  const atlas = await loadTransitAtlas();
  if (runtime.transitAreas.size) return;
  runtime.transitAreas = atlas;
  runtime.loadedStations = {
    type: 'FeatureCollection',
    features: [...atlas.values()].flatMap((area) => area.stations.features),
  };
  renderMetadata(atlasStationMetadata(runtime.loadedStations));
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

  if (!initial && !runtime.transitAreas.size)
    beginLoading('Loading metro networks', 'area');
  runtime.activeAreaKey = areaKey;
  setActiveCircumferenceState(areaKey);
  if (initial) setCurrentDeparture(area);
  resetDestinationRouting();
  updateAreaChrome(areaKey);
  resetSelection();

  try {
    await installTransitAtlas();
    const data = runtime.transitAreas.get(areaKey);
    if (!data) throw new Error(`Missing transit data for ${areaKey}`);
    const { stations, metadata } = data;

    if (sequence !== runtime.loadSequence) return;

    state.metadata = metadata;
    state.stationById = new Map(
      runtime.loadedStations.features.map((feature) => [
        feature.properties.id,
        feature,
      ]),
    );

    runtime.streetAccessStationIds = stations.features
      .filter((feature) => feature.properties.status === 'open')
      .map((feature) => feature.properties.id);
    runtime.futureStreetAccessStationIds = stations.features
      .filter((feature) => feature.properties.status !== 'open')
      .map((feature) => feature.properties.id);
    renderAccessResults();
    if (!geoJsonSource('stations')) installMapData(runtime.loadedStations);
    if (fit) applyMapBounds(metadata);

    if (area.liveRoads && runtime.pendingBasemapStyle) installBasemap();
    syncStationFilters();
    syncStreetColor();
    syncStreetVisibility();
    syncStationVisibility();
    syncCircumferenceVisibility();
    updateViewportStatistics();
    if (runtime.activeProduct !== 'timezone' && runtime.activeProduct !== 'landuse') {
      prepareCircumferenceRoute(sequence);
    }
    window.__transitPerformance.dataFetchedMs =
      performance.now() - window.__transitPerformance.startedAt;
    scheduleDestinationSetup(areaKey, area, stations, sequence);

    if (area.liveRoads || runtime.activeProduct !== 'access') {
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
    const [basemapStyle, landmasses, timezoneMapData, circumferenceEntries] =
      await Promise.all([
        fetchParsed('vendor/openfreemap-liberty.json', styleSpecificationSchema),
        fetchParsed(
          'data/circumference-landmasses.json?v=20260727d',
          landmassDataSchema,
        ),
        fetchTimezoneMapData(),
        Promise.all(
          AREA_KEYS.map(async (areaKey) => ({
            areaKey,
            geometryVariants: await fetchCircumferenceGeometryVariants(
              AREAS[areaKey].circumference,
            ),
            schedules: await fetchParsed(
              AREAS[areaKey].schedules,
              scheduleSchema,
            ).catch(() => null),
          })),
        ),
        installTransitAtlas(),
      ]);
    runtime.pendingBasemapStyle = basemapStyle;
    runtime.circumferenceLandmasses = landmasses;
    installTimezoneSkew(timezoneMapData.zones, timezoneMapData.countries);
    installJerseyCityLandUse();
    for (const { areaKey, geometryVariants, schedules } of circumferenceEntries) {
      circumferenceStates[areaKey].geometryVariants = geometryVariants;
      runtime.circumferenceSchedules[areaKey] = schedules;
    }
    setActiveCircumferenceState(initialAreaKey);
    if (runtime.activeProduct === 'timezone' || runtime.activeProduct === 'landuse') {
      runtime.loadingCanFinish = true;
      requestAnimationFrame(() => requestAnimationFrame(finishLoading));
      return;
    }
    await loadArea(initialAreaKey, {
      initial: true,
      fit: true,
    });
  } catch (error) {
    console.error(error);
    runtime.loadingOperation = null;
    updateStatus('Map unavailable', { isError: true });
    mapLoadingLabelEl.textContent = 'Map could not be initialized';
    mapEl.setAttribute('aria-busy', 'false');
  }
}

window.addEventListener('transit:refresh-live-roads', scheduleLiveStreetRefresh);
window.addEventListener('transit:load-active-area', () => {
  if (state.metadata) return;
  void loadArea(runtime.activeAreaKey, {
    fit: runtime.activeProduct !== 'circumference',
  });
});

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
      runtime.activeProduct !== 'access')
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

accessResultsEl.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>('button[data-access-area]');
  if (!button || !accessResultsEl.contains(button)) return;
  const areaKey = button.dataset['accessArea'];
  if (!isAreaKey(areaKey)) return;
  if (areaKey === runtime.activeAreaKey && state.metadata) {
    applyMapBounds(state.metadata);
  } else {
    void loadArea(areaKey);
  }
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
    circumferenceStates[areaKey].resultCandidates = [];
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
  map.setProjection({ type: 'globe' });
  setActiveProduct(runtime.activeProduct, { updateUrl: false });
  void initialize();
});
