import type {
  ExpressionSpecification,
  FilterSpecification,
  LngLatBoundsLike,
} from 'maplibre-gl';

import { bestStreetTravelTime, distanceMeters, timeScaleStops } from '../routing.js';
import type { AccessCandidate, AccessTravel } from '../routing/types.js';
import {
  streetPropertiesSchema,
  type Metadata,
  type Mode,
  type StationCollection,
  type StationFeature,
  type StreetProperties,
} from '../domain.js';
import {
  expressionSpecificationSchema,
  filterSpecificationSchema,
  type AreaKey,
  type DistanceProperties,
  type LoadingOperation,
  type Product,
} from './types.js';
import {
  activeAccessTransitTimes,
  fitCircumferenceCandidate,
  positionCircumferenceGradient,
  prepareCircumferenceRoute,
  setLayerVisibility,
  syncCircumferenceVisibility,
} from './circumference-ui.js';
import {
  AREAS,
  COLORS,
  FUTURE_MODE_ACCESS_PROPERTIES,
  FUTURE_MODE_DISTANCE_PROPERTIES,
  MODE_ACCESS_PROPERTIES,
  MODE_COLORS,
  MODE_DISTANCE_PROPERTIES,
  MODE_LABELS,
  accessResultAreaEl,
  accessProductButton,
  accessProductEl,
  activeStationModes,
  allStationModes,
  appShellEl,
  areaSelect,
  circumferenceProductButton,
  circumferenceProductEl,
  circumferenceState,
  compactPanelQuery,
  departureControlEl,
  destinationControlEl,
  destinationSelect,
  destinationSummaryEl,
  featureMetadataEl,
  featureNameEl,
  featureSummaryEl,
  filterableOpenStationLayers,
  formatInteger,
  futureStationFilter,
  futureStationLayers,
  futureStationModes,
  futureStationToggle,
  isMode,
  legendEl,
  legendLabelsEl,
  map,
  mapEl,
  mapLoadingEl,
  mapLoadingLabelEl,
  nearCountEl,
  nearCountLabelEl,
  openStationFilter,
  openStationLayers,
  routeBreakdownEl,
  runtime,
  scheduleSummaryEl,
  selectionTypeEl,
  state,
  stationBreakdownEl,
  stationCountEl,
  stationToggle,
  streetCountEl,
  streetToggle,
  timeScaleControlEl,
  timeStreetColor,
  updateStatus,
} from './context.js';

function requestLiveStreetRefresh(): void {
  window.dispatchEvent(new Event('transit:refresh-live-roads'));
}

export function setActiveProduct(
  product: Product,
  {
    fit = true,
    updateUrl = true,
  }: { readonly fit?: boolean; readonly updateUrl?: boolean } = {},
): void {
  runtime.activeProduct = product === 'circumference' ? 'circumference' : 'access';
  const circumferenceActive = runtime.activeProduct === 'circumference';
  appShellEl.classList.toggle('circumference-active', circumferenceActive);
  accessProductButton.setAttribute('aria-selected', String(!circumferenceActive));
  circumferenceProductButton.setAttribute('aria-selected', String(circumferenceActive));
  accessProductButton.tabIndex = circumferenceActive ? -1 : 0;
  circumferenceProductButton.tabIndex = circumferenceActive ? 0 : -1;
  accessProductEl.hidden = circumferenceActive;
  circumferenceProductEl.hidden = !circumferenceActive;

  syncStreetVisibility();
  syncStationVisibility();
  syncCircumferenceVisibility();
  if (updateUrl) updateAreaChrome(runtime.activeAreaKey);

  if (circumferenceActive) {
    prepareCircumferenceRoute();
    if (fit && circumferenceState.selected) {
      fitCircumferenceCandidate(circumferenceState.selected);
    }
    updateStatus(circumferenceState.selected ? 'Route ready' : 'Loading routes', {
      isLoading: !circumferenceState.selected,
    });
  } else {
    if (fit && state.metadata) applyMapBounds(state.metadata);
    if (AREAS[runtime.activeAreaKey].liveRoads) requestLiveStreetRefresh();
    updateStatus(state.destination ? 'Destination set' : 'Ready');
    updateViewportStatistics();
  }
}

export function syncStationVisibility(): void {
  const showStations = runtime.activeProduct === 'access' && stationToggle.checked;
  const showFuture = showStations && futureStationToggle.checked;

  for (const layerId of openStationLayers) {
    setLayerVisibility(layerId, showStations);
  }

  for (const layerId of futureStationLayers) {
    setLayerVisibility(layerId, showFuture);
  }
}

export function filterByActiveModes(
  statusFilter: FilterSpecification,
): FilterSpecification {
  const activeModes = [...activeStationModes];

  if (activeModes.length === 0) {
    return filterSpecificationSchema.parse([
      'all',
      statusFilter,
      ['==', ['get', 'mode'], '__none__'],
    ]);
  }

  return filterSpecificationSchema.parse([
    'all',
    statusFilter,
    ['in', ['get', 'mode'], ['literal', activeModes]],
  ]);
}

export function syncStationFilters(): void {
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

export function streetDistanceExpression(): unknown {
  if (AREAS[runtime.activeAreaKey].liveRoads) return ['get', 'd'];

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
        .filter((mode) => futureStationModes.has(mode))
        .map((mode) => FUTURE_MODE_DISTANCE_PROPERTIES[mode])
        .filter(Boolean),
    );
  }

  const modeDistances = distanceProperties.map((property) => [
    'to-number',
    ['get', property],
    runtime.maxDistanceMeters,
  ]);

  if (modeDistances.length === 0) return runtime.maxDistanceMeters;
  if (modeDistances.length === 1) return modeDistances[0];
  return ['min', ...modeDistances];
}

export function streetColorExpression(): ExpressionSpecification {
  return expressionSpecificationSchema.parse([
    'interpolate',
    ['linear'],
    streetDistanceExpression(),
    0,
    COLORS.near,
    500,
    COLORS.nearMid,
    750,
    COLORS.midNear,
    1000,
    COLORS.mid,
    2500,
    COLORS.midFar,
    3750,
    COLORS.farMid,
    runtime.maxDistanceMeters,
    COLORS.far,
  ]);
}

export function activeStationCollection(): StationCollection {
  return {
    type: 'FeatureCollection',
    features: (runtime.loadedStations.features ?? []).filter(
      (feature) =>
        activeStationModes.has(feature.properties.mode) &&
        (feature.properties.status === 'open' || futureStationToggle.checked),
    ),
  };
}

export function activeStreetLayerId(): string {
  return AREAS[runtime.activeAreaKey].liveRoads
    ? 'live-street-proximity'
    : 'street-proximity';
}

export function activeStreetSourceId(): string {
  return AREAS[runtime.activeAreaKey].liveRoads ? 'live-streets' : 'streets';
}

export function syncStreetColor(): void {
  const layerId = activeStreetLayerId();
  if (map.getLayer(layerId)) {
    map.setPaintProperty(
      layerId,
      'line-color',
      state.destination && state.transitTimes
        ? timeStreetColor(activeAccessTransitTimes(), state.timeScaleMinutes)
        : streetColorExpression(),
    );
  }
}

export function streetDistanceFromProperties(properties: StreetProperties): number {
  if (AREAS[runtime.activeAreaKey].liveRoads) return Number(properties.d);

  const distanceProperties = [...activeStationModes]
    .map((mode) => MODE_DISTANCE_PROPERTIES[mode])
    .filter(Boolean);

  if (futureStationToggle.checked) {
    distanceProperties.push(
      ...[...activeStationModes]
        .filter((mode) => futureStationModes.has(mode))
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

export function streetAccessCandidates(
  properties: StreetProperties,
): AccessCandidate[] {
  const candidates: AccessCandidate[] = [];

  for (let candidateIndex = 0; candidateIndex < 5; candidateIndex += 1) {
    const suffix = candidateIndex === 0 ? '' : String(candidateIndex + 1);
    const stationId = properties[`s${suffix}`];
    const distanceMeters = Number(properties[`d${suffix}`]);
    if (typeof stationId !== 'string') continue;
    const mode = state.stationById.get(stationId)?.properties.mode;
    if (
      mode !== undefined &&
      Number.isFinite(distanceMeters) &&
      activeStationModes.has(mode)
    ) {
      candidates.push({ stationId, distanceMeters });
    }
  }

  const appendCandidates = (
    distanceProperties: DistanceProperties,
    accessProperties: DistanceProperties,
    stationIds: readonly string[],
    availableModes?: ReadonlySet<Mode>,
  ): void => {
    for (const mode of activeStationModes) {
      if (availableModes && !availableModes.has(mode)) continue;
      const distanceMeters = Number(properties[distanceProperties[mode]]);
      const stationIndex = Number(properties[accessProperties[mode]]);
      const stationId = stationIds[stationIndex];
      if (!stationId || !Number.isFinite(distanceMeters)) continue;
      candidates.push({ stationId, distanceMeters });
    }
  };

  if (!AREAS[runtime.activeAreaKey].liveRoads) {
    appendCandidates(
      MODE_DISTANCE_PROPERTIES,
      MODE_ACCESS_PROPERTIES,
      runtime.streetAccessStationIds,
    );
    if (futureStationToggle.checked) {
      appendCandidates(
        FUTURE_MODE_DISTANCE_PROPERTIES,
        FUTURE_MODE_ACCESS_PROPERTIES,
        runtime.futureStreetAccessStationIds,
        futureStationModes,
      );
    }
  }

  return candidates;
}

export function selectedStreetTravelTime(
  properties: StreetProperties,
  transitTimes: ReadonlyMap<string, number> = activeAccessTransitTimes(),
): AccessTravel | null {
  return bestStreetTravelTime(streetAccessCandidates(properties), transitTimes);
}

export function visibleTiledStreets(): StreetProperties[] {
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

  const byId = new Map<string | number, StreetProperties>();
  for (const feature of map.queryRenderedFeatures({ layers: [layerId] })) {
    const properties = streetPropertiesSchema.safeParse(feature.properties);
    if (!properties.success) continue;
    const propertyId = properties.data['i'];
    const key =
      typeof propertyId === 'string' || typeof propertyId === 'number'
        ? propertyId
        : feature.id;
    if (key !== undefined && !byId.has(key)) byId.set(key, properties.data);
  }
  return [...byId.values()];
}

export function updateViewportStatistics(
  tiledStreets: readonly StreetProperties[] | null = null,
): void {
  const bounds = map.getBounds();
  const timeStops = timeScaleStops(state.timeScaleMinutes);
  const timeMode = state.destination !== null && state.transitTimes !== null;
  const accessTransitTimes = timeMode ? activeAccessTransitTimes() : null;

  let visibleStationCount = 0;
  if (stationToggle.checked) {
    for (const feature of runtime.loadedStations.features ?? []) {
      const [lon, lat] = feature.geometry?.coordinates ?? [];
      const properties = feature.properties ?? {};
      const statusVisible = properties.status === 'open' || futureStationToggle.checked;
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
      ? (selectedStreetTravelTime(properties, accessTransitTimes ?? undefined)
          ?.totalMinutes ?? Number.POSITIVE_INFINITY) <= timeStops.orangeMinutes
      : streetDistanceFromProperties(properties) <= 2500;
    if (isNear) nearCount += 1;
  }

  nearCountLabelEl.textContent = timeMode
    ? `Within ${timeStops.orangeMinutes} min`
    : 'Within 2.5 km';
  streetCountEl.textContent = formatInteger(streets.length);
  nearCountEl.textContent = formatInteger(nearCount);
}

export function syncStreetVisibility(): void {
  const visible = runtime.activeProduct === 'access' && streetToggle.checked;
  setLayerVisibility(
    'street-proximity',
    visible && !AREAS[runtime.activeAreaKey].liveRoads,
  );
  setLayerVisibility(
    'live-street-proximity',
    visible && Boolean(AREAS[runtime.activeAreaKey].liveRoads),
  );
}

export function beginLoading(label: string, type: LoadingOperation['type']): void {
  runtime.loadingOperation = {
    type,
    label,
    startedAt: performance.now(),
  };
  runtime.loadingCanFinish = false;
  updateStatus(label, { isLoading: true });
  mapLoadingLabelEl.textContent = `${label}…`;
  mapLoadingEl.hidden = false;
  mapEl.setAttribute('aria-busy', 'true');
}

export function finishLoading(): void {
  if (!runtime.loadingOperation || !runtime.loadingCanFinish) return;

  const completedOperation = {
    ...runtime.loadingOperation,
    durationMs: performance.now() - runtime.loadingOperation.startedAt,
  };
  window.__transitPerformance.operations.push(completedOperation);

  if (completedOperation.type === 'initial') {
    runtime.initialLoadComplete = true;
    window.__transitPerformance.initialReadyMs = completedOperation.durationMs;
    scheduleBasemapInstall();
  } else {
    window.__transitPerformance.lastInteractionMs = completedOperation.durationMs;
  }

  runtime.loadingOperation = null;
  runtime.loadingCanFinish = false;
  updateStatus('Ready');
  mapLoadingEl.hidden = true;
  mapEl.setAttribute('aria-busy', 'false');
  window.dispatchEvent(
    new CustomEvent('transit:ready', { detail: completedOperation }),
  );
}

export function installBasemap(): void {
  if (!runtime.pendingBasemapStyle) return;

  try {
    for (const [sourceId, source] of Object.entries(
      runtime.pendingBasemapStyle.sources ?? {},
    )) {
      if (!map.getSource(sourceId)) map.addSource(sourceId, source);
    }

    for (const layer of runtime.pendingBasemapStyle.layers ?? []) {
      if (layer.type !== 'background' && !map.getLayer(layer.id)) {
        const beforeLayer =
          layer.type === 'symbol' ? 'station-points-open' : 'street-proximity';
        map.addLayer(layer, beforeLayer);
      }
    }
    positionCircumferenceGradient();
    if (AREAS[runtime.activeAreaKey].liveRoads) {
      requestLiveStreetRefresh();
      syncStreetVisibility();
    }
  } catch (error) {
    console.error('Basemap could not be installed.', error);
  } finally {
    runtime.pendingBasemapStyle = null;
  }
}

export function scheduleBasemapInstall(): void {
  if (!runtime.pendingBasemapStyle || runtime.basemapInstallScheduled) return;
  runtime.basemapInstallScheduled = true;
  setTimeout(installBasemap, 1000);
}

export function runMapUpdate(label: string, callback: () => void): void {
  beginLoading(label, 'filter');
  callback();

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      runtime.loadingCanFinish = true;
      finishLoading();
    });
  });
}

export function setLegend(mode: 'distance' | 'time'): void {
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

export function renderMetadata(metadata: Metadata): void {
  const streetCount = metadata.street_count ?? 0;
  const stationCount = metadata.open_station_count ?? metadata.station_count ?? 0;
  const futureStationCount = metadata.future_station_count ?? 0;
  const nearCount = metadata.histogram?.under_2500_m ?? 0;

  runtime.maxDistanceMeters = metadata.max_distance_m ?? runtime.maxDistanceMeters;

  streetCountEl.textContent =
    metadata.street_count == null ? 'Live' : formatInteger(streetCount);
  stationCountEl.textContent = formatInteger(stationCount);
  nearCountEl.textContent = metadata.histogram ? formatInteger(nearCount) : 'Live';
  futureStationToggle.disabled = futureStationCount === 0;
  if (futureStationCount === 0) futureStationToggle.checked = false;

  const stationModes = metadata.station_modes_open ?? metadata.station_modes;
  const sortedStationModes = Object.entries(stationModes)
    .flatMap(([mode, count]) =>
      isMode(mode) && count !== undefined ? [{ count, mode }] : [],
    )
    .sort((first, second) => second.count - first.count);

  activeStationModes.clear();
  allStationModes.clear();
  futureStationModes.clear();
  for (const { mode } of sortedStationModes) {
    activeStationModes.add(mode);
    allStationModes.add(mode);
  }
  for (const [mode, count] of Object.entries(metadata.station_modes_future ?? {})) {
    if (isMode(mode) && count !== undefined && count > 0) {
      futureStationModes.add(mode);
    }
  }

  stationBreakdownEl.replaceChildren(
    ...sortedStationModes.map(({ count, mode }) => {
      const label = MODE_LABELS[mode];
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'mode-pill';
      item.dataset['mode'] = mode;
      item.setAttribute('aria-pressed', 'true');
      item.setAttribute('aria-label', `${label} stations: ${formatInteger(count)}`);
      item.title = `Hide ${label} stations`;
      item.style.setProperty('--mode-color', MODE_COLORS[mode]);
      item.textContent = `${label}: ${formatInteger(count)}`;
      return item;
    }),
  );
}

export interface DestinationChoice {
  readonly representative: StationFeature;
  readonly stationIds: string[];
}

export function renderDestinationOptions(
  stationFeatures: readonly StationFeature[],
): void {
  const nearestOption = document.createElement('option');
  nearestOption.value = '';
  nearestOption.textContent = 'Nearest station only';
  destinationSelect.replaceChildren(nearestOption);
  state.destinationChoiceByStationId.clear();
  state.destinationIdsByChoice.clear();

  const openStations = stationFeatures
    .filter((feature) => feature.properties.status === 'open')
    .filter((feature) => feature.properties.name)
    .sort((first, second) =>
      (first.properties.name || 'Unnamed station').localeCompare(
        second.properties.name || 'Unnamed station',
        'es',
      ),
    );

  const featureById = new Map<string, StationFeature>(
    openStations.map((feature) => [feature.properties.id, feature]),
  );
  const parentById = new Map<string, string>(
    openStations.map((feature) => [feature.properties.id, feature.properties.id]),
  );
  const findRoot = (stationId: string): string => {
    const parent = parentById.get(stationId);
    if (!parent || parent === stationId) return stationId;
    const root = findRoot(parent);
    parentById.set(stationId, root);
    return root;
  };
  const union = (firstId: string, secondId: string): void => {
    const firstRoot = findRoot(firstId);
    const secondRoot = findRoot(secondId);
    if (firstRoot !== secondRoot) parentById.set(secondRoot, firstRoot);
  };

  // Published transfers are the authoritative definition of a station
  // complex. CDMX does not publish transfers, so tightly co-located records
  // with the same name and mode are also grouped.
  for (const [fromStationId, transfers] of Object.entries(
    state.schedules?.graph?.t ?? {},
  )) {
    if (!featureById.has(fromStationId)) continue;
    for (const [toStationId] of transfers) {
      if (featureById.has(toStationId)) union(fromStationId, toStationId);
    }
  }

  const sameNameBuckets = new Map<string, StationFeature[]>();
  for (const feature of openStations) {
    const properties = feature.properties;
    const key = `${properties.name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()}|${properties.mode}`;
    const bucket = sameNameBuckets.get(key) ?? [];
    bucket.push(feature);
    sameNameBuckets.set(key, bucket);
  }
  for (const bucket of sameNameBuckets.values()) {
    for (let firstIndex = 0; firstIndex < bucket.length; firstIndex += 1) {
      for (
        let secondIndex = firstIndex + 1;
        secondIndex < bucket.length;
        secondIndex += 1
      ) {
        if (
          distanceMeters(
            bucket[firstIndex]?.geometry.coordinates ?? [0, 0],
            bucket[secondIndex]?.geometry.coordinates ?? [0, 0],
          ) <= 180
        ) {
          const first = bucket[firstIndex];
          const second = bucket[secondIndex];
          if (first !== undefined && second !== undefined) {
            union(first.properties.id, second.properties.id);
          }
        }
      }
    }
  }

  const destinationChoices = new Map<string, DestinationChoice>();
  for (const feature of openStations) {
    const root = findRoot(feature.properties.id);
    const choice = destinationChoices.get(root) ?? {
      representative: feature,
      stationIds: [],
    };
    choice.stationIds.push(feature.properties.id);
    destinationChoices.set(root, choice);
  }

  const options = [...destinationChoices.values()].map((choice) => {
    const option = document.createElement('option');
    const feature = choice.representative;
    const properties = feature.properties;
    option.value = properties.id;
    option.textContent = `${properties.name || 'Unnamed station'} — ${
      properties.system || MODE_LABELS[properties.mode] || 'Transit'
    }`;
    state.destinationIdsByChoice.set(properties.id, choice.stationIds);
    for (const stationId of choice.stationIds) {
      state.destinationChoiceByStationId.set(stationId, properties.id);
    }
    return option;
  });

  destinationSelect.append(...options);
  destinationSelect.disabled = false;
}

export function resetDestinationRouting(): void {
  state.metadata = null;
  state.stationById.clear();
  state.transitGraph = null;
  state.transitTimes = null;
  state.destination = null;
  state.destinationStationIds = [];
  state.destinationChoiceByStationId.clear();
  state.destinationIdsByChoice.clear();
  state.schedules = null;
  state.waitMinutesByStation.clear();
  state.waitMinutesByService.clear();
  state.waitDetailsByStation.clear();
  state.waitDetailsByService.clear();
  runtime.streetAccessStationIds = [];
  runtime.futureStreetAccessStationIds = [];

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

export function metadataBounds(metadata: Metadata): LngLatBoundsLike {
  const bounds = metadata.bbox;
  if (
    !bounds ||
    !Number.isFinite(bounds.west) ||
    !Number.isFinite(bounds.south) ||
    !Number.isFinite(bounds.east) ||
    !Number.isFinite(bounds.north)
  ) {
    throw new Error('Validated metadata contains invalid bounds');
  }

  return [
    [bounds.west, bounds.south],
    [bounds.east, bounds.north],
  ];
}

export function applyMapBounds(metadata: Metadata): void {
  const bounds = metadataBounds(metadata);

  const padding = compactPanelQuery.matches ? 24 : 48;

  // Keep the selected metro area as the camera target without fencing the
  // user into its bounding box. Globe mode remains freely pannable and can be
  // zoomed all the way out, then automatically flattens again at street scale.
  map.setMaxBounds(null);
  map.fitBounds(bounds, {
    padding,
    duration: 0,
  });
}

export function resetSelection(): void {
  runtime.selectedStreetProperties = null;
  selectionTypeEl.textContent = 'Nothing selected';
  featureNameEl.textContent = 'Click a street or station';
  featureSummaryEl.textContent =
    'Move anywhere on the map—visible items work directly.';
  featureMetadataEl.replaceChildren();
  routeBreakdownEl.replaceChildren();
  routeBreakdownEl.hidden = true;
}

export function updateAreaChrome(areaKey: AreaKey): void {
  const area = AREAS[areaKey];
  areaSelect.value = areaKey;
  accessResultAreaEl.textContent = area.label;
  document.title =
    runtime.activeProduct === 'circumference'
      ? `Circumference Lab — ${area.label}`
      : `Transit Colors — ${area.label}`;
  mapEl.setAttribute(
    'aria-label',
    runtime.activeProduct === 'circumference'
      ? `All maximum-area circumferential routes map, focused on ${area.label}`
      : area.supportsDestination
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
  if (runtime.activeProduct === 'circumference') {
    url.searchParams.set('product', 'circumference');
  } else {
    url.searchParams.delete('product');
  }
  window.history.replaceState({}, '', url);
}
