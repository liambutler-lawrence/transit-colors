import maplibregl from 'maplibre-gl';
import type {
  Feature,
  FeatureCollection,
  GeoJsonProperties,
  Geometry,
  LineString,
  Point,
} from 'geojson';

import {
  activeCircumferenceLines,
  junctionContinuationLineLanes,
  scheduleCircumferenceMode,
  scheduleLineStateKey,
  selectCircumferenceCandidate,
  type JunctionContinuationLane,
} from '../circumference.js';
import {
  calculateLandmassCoverage,
  combinedLandmassArea,
  type LandmassCoverage,
} from '../circumference-landmass.js';
import { circumferenceGradientCoordinates } from '../circumference-gradient-source.js';
import {
  CIRCUMFERENCE_GRADIENT_COAST_LAYER_ID,
  circumferenceGradientBounds,
  renderCircumferenceGradient,
} from '../circumference-map.js';
import type {
  CircumferenceCandidate,
  CircumferenceGeometryMode,
  CircumferenceModeResult,
} from '../circumference/types.js';
import { lineColor } from '../line-colors.js';
import type { AreaKey, CircumferenceState, MetadataDetail } from './types.js';
import {
  AREAS,
  AREA_KEYS,
  activeStationModes,
  circumferenceCanvases,
  circumferenceMetadataEl,
  circumferenceNameEl,
  circumferenceResultsEl,
  circumferenceScheduleSummaryEl,
  circumferenceSelectionTypeEl,
  circumferenceState,
  circumferenceStates,
  circumferenceSummaryEl,
  compactPanelQuery,
  departureLabel,
  formatArea,
  formatRouteLength,
  geoJsonSource,
  imageSource,
  map,
  routeAreaToggle,
  routeAutoButton,
  routeAvoidSegmentButton,
  routeChoiceSelect,
  routeChoiceSummaryEl,
  routeClearSegmentsButton,
  routeGradientToggle,
  routeRequireSegmentButton,
  routeStationsToggle,
  routeTrackGeometryToggle,
  runtime,
  setActiveCircumferenceState,
  state,
  updateStatus,
} from './context.js';

export function activeAccessTransitTimes(): Map<string, number> {
  const result = new Map<string, number>();
  for (const [stationId, minutes] of state.transitTimes ?? []) {
    const stationMode = state.stationById.get(stationId)?.properties.mode;
    result.set(
      stationId,
      stationMode !== undefined && activeStationModes.has(stationMode) ? minutes : 90,
    );
  }
  return result;
}

export function firstSymbolLayerId(): string | undefined {
  return map.getStyle().layers.find((layer) => layer.type === 'symbol')?.id;
}

export function setLayerVisibility(id: string, visible: boolean): void {
  if (map.getLayer(id)) {
    map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }
}

export function replaceMetadata(
  element: Element,
  details: readonly MetadataDetail[],
): void {
  element.replaceChildren(
    ...details
      .filter(
        (detail) =>
          detail.value !== undefined && detail.value !== null && detail.value !== '',
      )
      .map((detail) => {
        const term = document.createElement('dt');
        term.textContent = detail.label;

        const description = document.createElement('dd');
        description.textContent = String(detail.value);

        const fragment = document.createDocumentFragment();
        fragment.append(term, description);
        return fragment;
      }),
  );
}

export function positionCircumferenceGradient(): void {
  // Keep the overlay below the detailed basemap water polygons. The stored
  // landmass masks remain the fallback and calculation boundary, while the
  // visible edge follows the same high-resolution shoreline as the map.
  const beforeLayer = map.getLayer(CIRCUMFERENCE_GRADIENT_COAST_LAYER_ID)
    ? CIRCUMFERENCE_GRADIENT_COAST_LAYER_ID
    : map.getLayer('street-proximity')
      ? 'street-proximity'
      : undefined;
  for (const areaKey of AREA_KEYS) {
    const layerId = `circumference-gradient-${areaKey}`;
    if (map.getLayer(layerId)) map.moveLayer(layerId, beforeLayer);
  }
}

export function syncCircumferenceVisibility(): void {
  const visible =
    runtime.activeProduct === 'circumference' &&
    AREA_KEYS.some((areaKey) => Boolean(circumferenceStates[areaKey].selected));
  for (const areaKey of AREA_KEYS) {
    setLayerVisibility(
      `circumference-gradient-${areaKey}`,
      visible &&
        routeGradientToggle.checked &&
        Boolean(circumferenceStates[areaKey].selected),
    );
  }
  setLayerVisibility('circumference-area', visible && routeAreaToggle.checked);
  setLayerVisibility('circumference-network-casing', visible);
  setLayerVisibility('circumference-network-line', visible);
  setLayerVisibility('circumference-network-transfer-line', visible);
  setLayerVisibility('circumference-route-alternative-casing', visible);
  setLayerVisibility('circumference-route-alternative-line', visible);
  setLayerVisibility('circumference-route-casing', visible);
  setLayerVisibility('circumference-route-line', visible);
  setLayerVisibility('circumference-transfer-line', visible);
  setLayerVisibility(
    'circumference-network-stations',
    visible && routeStationsToggle.checked,
  );
  setLayerVisibility(
    'circumference-network-labels',
    visible && routeStationsToggle.checked,
  );
  setLayerVisibility(
    'circumference-route-stations',
    visible && routeStationsToggle.checked,
  );
  setLayerVisibility(
    'circumference-route-labels',
    visible && routeStationsToggle.checked,
  );
}

export function circumferenceStorageKey(areaKey: AreaKey): string {
  return `transit-colors:circumference-route:${areaKey}`;
}

export function storedCircumferenceOverride(areaKey: AreaKey): string {
  try {
    return window.localStorage.getItem(circumferenceStorageKey(areaKey)) ?? '';
  } catch {
    return '';
  }
}

export function storeCircumferenceOverride(areaKey: AreaKey, overrideId: string): void {
  try {
    if (overrideId) {
      window.localStorage.setItem(circumferenceStorageKey(areaKey), overrideId);
    } else {
      window.localStorage.removeItem(circumferenceStorageKey(areaKey));
    }
  } catch {
    // Storage can be unavailable in privacy modes; the in-memory override remains.
  }
}

export function hasSegmentOverrides(): boolean {
  return (
    circumferenceState.requiredSegmentIds.size > 0 ||
    circumferenceState.avoidedSegmentIds.size > 0
  );
}

export function selectedCircumferenceCandidate(): CircumferenceCandidate | null {
  return selectCircumferenceCandidate(
    circumferenceState.candidates,
    circumferenceState.overrideId,
    {
      requiredSegmentIds: [...circumferenceState.requiredSegmentIds],
      avoidedSegmentIds: [...circumferenceState.avoidedSegmentIds],
    },
  );
}

export function resetCircumferenceRoute(): void {
  for (const areaKey of AREA_KEYS) {
    const routeState = circumferenceStates[areaKey];
    routeState.activeLineNames = [];
    routeState.areaKey = null;
    routeState.candidates = [];
    routeState.network = {
      segments: [],
      stations: [],
    };
    routeState.selected = null;
    routeState.overrideId = '';
    routeState.methodology = null;
    routeState.inspectedSegmentId = '';
    routeState.requiredSegmentIds.clear();
    routeState.avoidedSegmentIds.clear();
    routeState.scheduleKey = '';
    routeState.geometryMode = null;
    routeState.geometryVariants = null;
  }
  circumferenceResultsEl.replaceChildren();
  resetCircumferenceItemDetails('Waiting for route data');
  routeChoiceSelect.replaceChildren(
    Object.assign(document.createElement('option'), {
      value: '',
      textContent: 'Automatic · largest inner area',
    }),
  );
  routeChoiceSelect.disabled = true;
  routeAutoButton.disabled = true;
  routeRequireSegmentButton.disabled = true;
  routeAvoidSegmentButton.disabled = true;
  routeClearSegmentsButton.disabled = true;
  routeChoiceSummaryEl.textContent = 'Building closed loops from the metro network…';

  const source = geoJsonSource('circumference-route');
  if (source) {
    source.setData({
      type: 'FeatureCollection',
      features: [],
    });
  }
  syncCircumferenceVisibility();
}

export function resetCircumferenceItemDetails(
  heading = 'Click a line or walking link',
): void {
  circumferenceSelectionTypeEl.textContent = 'Nothing selected';
  circumferenceNameEl.textContent = heading;
  circumferenceSummaryEl.textContent =
    heading === 'Click a line or walking link'
      ? 'Any visible route can be inspected directly, in either city.'
      : 'The route results will appear as soon as their data is ready.';
  circumferenceMetadataEl.replaceChildren();
  circumferenceState.inspectedSegmentId = '';
  routeRequireSegmentButton.disabled = true;
  routeAvoidSegmentButton.disabled = true;
  routeClearSegmentsButton.disabled = !hasSegmentOverrides();
}

export function fitCircumferenceCandidate(
  candidate: CircumferenceCandidate | null,
  { animate = true }: { readonly animate?: boolean } = {},
): void {
  if (!candidate || candidate.coordinates.length === 0) return;
  const fullLineCoordinates = circumferenceState.network.segments.flatMap((segment) =>
    segment.display === false ? [] : segment.coordinates,
  );
  const bounds = [...candidate.coordinates, ...fullLineCoordinates].reduce(
    (result, coordinate) => result.extend(coordinate),
    new maplibregl.LngLatBounds(),
  );
  map.fitBounds(bounds, {
    padding: compactPanelQuery.matches ? 30 : 56,
    maxZoom: 12,
    duration: animate ? 520 : 0,
  });
}

function centeredLinePosition(index: number, count: number): number {
  return index - (count - 1) / 2;
}

function segmentEndpointKey(fromId: string, toId: string): string {
  return [fromId, toId].sort().join('\u0000');
}

function sortLineNames(first: string, second: string): number {
  return first.localeCompare(second, 'en', {
    numeric: true,
    sensitivity: 'base',
  });
}

export function routeFeatureCollection(
  candidate: CircumferenceCandidate,
  areaKey: AreaKey,
  routeState = circumferenceStates[areaKey],
): FeatureCollection<Geometry, GeoJsonProperties> {
  const features: Feature<Geometry, GeoJsonProperties>[] = [
    {
      type: 'Feature',
      id: `${areaKey}:inside`,
      geometry: {
        type: 'Polygon',
        coordinates: [candidate.coordinates],
      },
      properties: { area_key: areaKey, kind: 'inside' },
    },
  ];
  let featureId = 0;
  const boundaryRideKeys = new Set(
    candidate.segments
      .filter((segment) => segment.type === 'ride')
      .map((segment) => segmentEndpointKey(segment.from.id, segment.to.id)),
  );
  const networkLinesByEdge = new Map<string, readonly string[]>();
  for (const segment of routeState.network.segments) {
    if (segment.type !== 'ride') continue;
    networkLinesByEdge.set(
      segmentEndpointKey(segment.from.id, segment.to.id),
      segment.lines,
    );
  }
  const boundaryLineLayouts = candidate.segments
    .filter((segment) => segment.type === 'ride')
    .map((segment) => {
      const displayedLines = [
        ...new Set([
          ...segment.lines,
          ...(networkLinesByEdge.get(
            segmentEndpointKey(segment.from.id, segment.to.id),
          ) ?? []),
        ]),
      ].sort(sortLineNames);
      return {
        coordinates: segment.coordinates,
        displayedLines,
        fromId: segment.from.id,
        primaryLine: segment.primaryLine ?? displayedLines[0] ?? '',
        toId: segment.to.id,
      };
    });
  const coordinatesByNodeId = new Map(
    routeState.network.stations.map((station) => [station.id, station.coordinate]),
  );

  for (const segment of routeState.network.segments) {
    if (segment.display === false) continue;
    if (
      segment.type === 'ride' &&
      boundaryRideKeys.has(segmentEndpointKey(segment.from.id, segment.to.id))
    ) {
      continue;
    }
    const displayedLines = segment.type === 'transfer' ? [''] : segment.lines;
    const continuationLanes: ReadonlyMap<string, JunctionContinuationLane> =
      segment.type === 'ride'
        ? junctionContinuationLineLanes(
            {
              coordinates: segment.coordinates,
              fromId: segment.from.id,
              lines: segment.lines,
              toId: segment.to.id,
            },
            boundaryLineLayouts,
            coordinatesByNodeId,
          )
        : new Map();
    for (const [index, lineName] of displayedLines.entries()) {
      const continuationLane = continuationLanes.get(lineName);
      const feature: Feature<LineString, GeoJsonProperties> = {
        type: 'Feature',
        id: `${areaKey}:${featureId}`,
        geometry: {
          type: 'LineString',
          coordinates: segment.coordinates,
        },
        properties: {
          kind:
            segment.type === 'transfer'
              ? 'network-transfer'
              : continuationLane === undefined
                ? 'network-segment'
                : 'segment-alternative',
          line: lineName,
          color: segment.type === 'transfer' ? '' : lineColor(areaKey, lineName),
          area_key: areaKey,
          line_position:
            segment.type === 'transfer'
              ? 0
              : (continuationLane?.index ??
                centeredLinePosition(index, displayedLines.length)),
          line_side: continuationLane?.side ?? 1,
          junction_continuation: continuationLane !== undefined,
        },
      };
      features.push(feature);
      featureId += 1;
    }
  }

  for (const station of routeState.network.stations) {
    const displayedLines = station.lineNames;
    const firstLine = displayedLines[0];
    if (firstLine === undefined) continue;
    const feature: Feature<Point, GeoJsonProperties> = {
      type: 'Feature',
      id: `${areaKey}:${featureId}`,
      geometry: {
        type: 'Point',
        coordinates: station.coordinate,
      },
      properties: {
        kind: 'network-station',
        name: station.name,
        label: `${station.name} · ${displayedLines.join('/')}`,
        lines: displayedLines.join(', '),
        area_key: areaKey,
        color: lineColor(areaKey, firstLine),
      },
    };
    features.push(feature);
    featureId += 1;
  }

  for (const segment of candidate.segments) {
    const displayedLines =
      segment.type === 'transfer'
        ? ['']
        : [
            ...new Set([
              ...segment.lines,
              ...(networkLinesByEdge.get(
                segmentEndpointKey(segment.from.id, segment.to.id),
              ) ?? []),
            ]),
          ].sort(sortLineNames);
    const primaryLine = segment.primaryLine ?? displayedLines[0] ?? '';
    const alternativeLines = displayedLines.filter(
      (lineName) => lineName !== primaryLine,
    );
    for (const lineName of displayedLines) {
      const isPrimaryLine = segment.type === 'ride' && lineName === primaryLine;
      const feature: Feature<LineString, GeoJsonProperties> = {
        type: 'Feature',
        id: `${areaKey}:${featureId}`,
        geometry: {
          type: 'LineString',
          coordinates: segment.coordinates,
        },
        properties: {
          kind:
            segment.type === 'transfer'
              ? 'transfer'
              : isPrimaryLine
                ? 'segment'
                : 'segment-alternative',
          from: segment.from.name,
          to: segment.to.name,
          from_label: segment.from.label ?? '',
          to_label: segment.to.label ?? '',
          line: lineName,
          lines: segment.lines.join(', '),
          area_key: areaKey,
          color: lineColor(areaKey, lineName),
          line_position:
            segment.type === 'transfer'
              ? 0
              : isPrimaryLine
                ? 0
                : alternativeLines.indexOf(lineName),
          line_side: 1,
          primary_line: primaryLine,
          segment_id: segment.id,
          segment_type: segment.type,
          distance_m: segment.distanceMeters,
          transfer_source: segment.transferSource ?? '',
          transfer_minutes: segment.transferMinutes ?? '',
        },
      };
      features.push(feature);
      featureId += 1;
    }
  }

  for (const [index, station] of candidate.stations.entries()) {
    const firstLine =
      candidate.segments[index]?.primaryLine ??
      candidate.segments[
        (index - 1 + candidate.segments.length) % candidate.segments.length
      ]?.primaryLine ??
      station.lineNames[0] ??
      '';
    const feature: Feature<Point, GeoJsonProperties> = {
      type: 'Feature',
      id: `${areaKey}:${featureId}`,
      geometry: {
        type: 'Point',
        coordinates: station.coordinate,
      },
      properties: {
        kind: 'station',
        name: station.name,
        label: station.label ?? '',
        lines: station.lineNames.join(', '),
        area_key: areaKey,
        color: lineColor(areaKey, firstLine),
      },
    };
    features.push(feature);
    featureId += 1;
  }

  return {
    type: 'FeatureCollection',
    features,
  };
}

function circumferenceCandidateOptions(
  routeState: CircumferenceState,
): HTMLOptionElement[] {
  const automaticOption = document.createElement('option');
  automaticOption.value = '';
  automaticOption.textContent = 'Automatic · largest contained area';
  const rankingCandidates =
    routeState.geometryVariants?.straight.candidates ?? routeState.candidates;
  return [
    automaticOption,
    ...routeState.candidates.map((candidate, index) => {
      const option = document.createElement('option');
      const rankingCandidate =
        rankingCandidates.find(({ id }) => id === candidate.id) ?? candidate;
      option.value = candidate.id;
      option.textContent = `#${index + 1} · ${formatArea(
        rankingCandidate.areaSquareMeters,
      )} · ${candidate.lines.join(', ')}`;
      return option;
    }),
  ];
}

function createCircumferenceResult(areaKey: AreaKey): HTMLElement {
  const routeState = circumferenceStates[areaKey];
  const candidate = routeState.selected;
  const result = document.createElement('article');
  result.className = 'circumference-result';
  result.dataset['focused'] = String(areaKey === runtime.activeAreaKey);

  const focusButton = document.createElement('button');
  focusButton.type = 'button';
  focusButton.className = 'result-focus-button';
  focusButton.dataset['focusArea'] = areaKey;
  focusButton.setAttribute(
    'aria-label',
    `Focus map on ${AREAS[areaKey].label} circumference result`,
  );
  const name = document.createElement('h3');
  name.textContent = AREAS[areaKey].label;
  const description = document.createElement('small');
  description.textContent = candidate
    ? `${candidate.lines.length} lines · ${candidate.stations.length} platform nodes`
    : routeState.areaKey === null
      ? 'Loading route result…'
      : routeState.activeLineNames.length === 0
        ? 'No scheduled metro service'
        : `${routeState.activeLineNames.length} lines · no closed loop`;
  const focusAction = document.createElement('span');
  focusAction.className = 'focus-action';
  focusAction.textContent = areaKey === runtime.activeAreaKey ? 'Focused' : 'Focus map';
  focusButton.append(name, description, focusAction);
  result.append(focusButton);

  if (!candidate) return result;
  const landmassArea = runtime.circumferenceLandmasses?.areas[areaKey];
  const coverage = landmassArea
    ? calculateLandmassCoverage(candidate.coordinates, landmassArea)
    : [];
  const outerArea = combinedLandmassArea(coverage, 'outsideAreaSquareMeters');
  const metrics = document.createElement('div');
  metrics.className = 'result-metrics';
  const metricValues: readonly (readonly [string, string])[] = [
    ['Inside', formatArea(candidate.areaSquareMeters)],
    [
      coverage.length === 1
        ? 'Outside · 1 landmass'
        : `Outside · ${coverage.length} landmasses`,
      formatArea(outerArea),
    ],
    ['Route', formatRouteLength(candidate.lengthMeters)],
  ];
  for (const [label, value] of metricValues) {
    const metric = document.createElement('div');
    metric.className = 'result-metric';
    const metricLabel = document.createElement('span');
    metricLabel.textContent = label;
    const metricValue = document.createElement('strong');
    metricValue.textContent = value;
    metric.append(metricLabel, metricValue);
    metrics.append(metric);
  }
  result.append(metrics);

  const landmasses = document.createElement('div');
  landmasses.className = 'result-landmasses';
  for (const landmass of coverage) {
    const row = document.createElement('div');
    row.className = 'result-landmass';
    const landmassName = document.createElement('strong');
    landmassName.textContent = landmass.label;
    const inside = document.createElement('span');
    inside.textContent = `${formatArea(landmass.insideAreaSquareMeters)} inside`;
    const outside = document.createElement('span');
    outside.textContent = `${formatArea(
      landmass.outsideAreaSquareMeters,
    )} outside to coast`;
    row.append(landmassName, inside, outside);
    landmasses.append(row);
  }
  result.append(landmasses);

  const routeControl = document.createElement('div');
  routeControl.className = 'result-route-control';
  const routeLabel = document.createElement('label');
  const selectId = `circumference-result-route-${areaKey}`;
  routeLabel.htmlFor = selectId;
  routeLabel.textContent = 'Route variant';
  const routeSelect = document.createElement('select');
  routeSelect.id = selectId;
  routeSelect.dataset['routeArea'] = areaKey;
  routeSelect.replaceChildren(...circumferenceCandidateOptions(routeState));
  routeSelect.value = routeState.overrideId;
  routeSelect.disabled = routeState.candidates.length === 0;
  routeControl.append(routeLabel, routeSelect);
  result.append(routeControl);

  const methodology = routeState.methodology;
  const summary = document.createElement('p');
  summary.className = 'result-summary';
  const choiceSummary = routeState.overrideId
    ? 'Pinned ranked result'
    : routeState.requiredSegmentIds.size || routeState.avoidedSegmentIds.size
      ? 'Largest result matching segment edits'
      : methodology?.optimizationStatus === 'optimal'
        ? 'Proven global maximum'
        : 'Automatic area maximum';
  summary.textContent = `${choiceSummary} · ${candidate.transferCount} walking ${
    candidate.transferCount === 1 ? 'transfer' : 'transfers'
  } · ${methodology?.trackGeometryEnabled ? 'track geography' : 'straight edges'}`;
  result.append(summary);
  return result;
}

export function renderCircumferenceResults(): void {
  circumferenceResultsEl.replaceChildren(
    ...AREA_KEYS.map((areaKey) => createCircumferenceResult(areaKey)),
  );
}

export function combinedRouteFeatureCollection(): FeatureCollection<
  Geometry,
  GeoJsonProperties
> {
  return {
    type: 'FeatureCollection',
    features: AREA_KEYS.flatMap((areaKey) => {
      const routeState = circumferenceStates[areaKey];
      return routeState.selected
        ? routeFeatureCollection(routeState.selected, areaKey, routeState).features
        : [];
    }),
  };
}

function updateCombinedCircumferenceSource(): void {
  geoJsonSource('circumference-route')?.setData(combinedRouteFeatureCollection());
}

function updateCircumferenceGradient(
  areaKey: AreaKey,
  candidate: CircumferenceCandidate,
  coverage?: readonly LandmassCoverage[],
): void {
  const landmassArea = runtime.circumferenceLandmasses?.areas[areaKey];
  if (!landmassArea) return;
  const landmassCoverage =
    coverage ?? calculateLandmassCoverage(candidate.coordinates, landmassArea);
  const canvas = circumferenceCanvases[areaKey];
  const gradientBounds = circumferenceGradientBounds(candidate.coordinates);
  renderCircumferenceGradient(
    canvas,
    candidate.coordinates,
    gradientBounds,
    landmassCoverage.flatMap((landmass) => landmass.mask ?? []),
  );
  imageSource(`circumference-gradient-${areaKey}`)?.updateImage({
    coordinates: circumferenceGradientCoordinates(gradientBounds),
    url: canvas.toDataURL('image/png'),
  });
}

export function renderCircumferenceCandidate(
  candidate: CircumferenceCandidate | null,
  { fit = false }: { readonly fit?: boolean } = {},
): void {
  if (!candidate) return;
  const landmassArea = runtime.circumferenceLandmasses?.areas[runtime.activeAreaKey];
  if (!landmassArea) return;
  const candidateChanged = circumferenceState.selected?.id !== candidate.id;
  const landmassCoverage = calculateLandmassCoverage(
    candidate.coordinates,
    landmassArea,
  );
  circumferenceState.selected = candidate;
  if (candidateChanged) resetCircumferenceItemDetails();

  updateCombinedCircumferenceSource();
  updateCircumferenceGradient(runtime.activeAreaKey, candidate, landmassCoverage);

  const isManual = Boolean(circumferenceState.overrideId);
  const isSegmentEdited = !isManual && hasSegmentOverrides();
  const methodology = circumferenceState.methodology;
  if (!methodology) return;
  routeChoiceSummaryEl.textContent = isManual
    ? 'This ranked loop is pinned as a manual override for this metro area.'
    : isSegmentEdited
      ? 'Largest-area ranked loop that satisfies the required and avoided segments.'
      : methodology.optimizationStatus === 'optimal'
        ? 'Precomputed exact winner; track mode preserves its topology and recalculates precise track area.'
        : `Automatic winner from ${methodology.generatedCandidateCount} valid loops, ranked by contained area.`;

  renderCircumferenceResults();
  positionCircumferenceGradient();
  syncCircumferenceVisibility();
  if (fit && runtime.activeProduct === 'circumference') {
    fitCircumferenceCandidate(candidate);
  }
}

export function renderCircumferenceOptions(): void {
  const automaticOption = document.createElement('option');
  automaticOption.value = '';
  automaticOption.textContent = 'Automatic · proven largest straight-edge area';
  const rankingCandidates =
    circumferenceState.geometryVariants?.straight.candidates ??
    circumferenceState.candidates;
  const candidateOptions = circumferenceState.candidates.map((candidate, index) => {
    const option = document.createElement('option');
    const rankingCandidate =
      rankingCandidates.find(({ id }) => id === candidate.id) ?? candidate;
    option.value = candidate.id;
    option.textContent = `#${index + 1} · ranked ${formatArea(
      rankingCandidate.areaSquareMeters,
    )} · Lines ${candidate.lines.join(', ')}`;
    return option;
  });
  routeChoiceSelect.replaceChildren(automaticOption, ...candidateOptions);
  routeChoiceSelect.disabled = candidateOptions.length === 0;
  routeChoiceSelect.value = circumferenceState.overrideId;
  routeAutoButton.disabled = !circumferenceState.overrideId && !hasSegmentOverrides();
}

function selectedCandidateForState(
  routeState: typeof circumferenceState,
): CircumferenceCandidate | null {
  return selectCircumferenceCandidate(routeState.candidates, routeState.overrideId, {
    requiredSegmentIds: [...routeState.requiredSegmentIds],
    avoidedSegmentIds: [...routeState.avoidedSegmentIds],
  });
}

function prepareCircumferenceArea(
  areaKey: AreaKey,
  geometryMode: CircumferenceGeometryMode,
): boolean {
  const routeState = circumferenceStates[areaKey];
  if (!routeState.geometryVariants) return false;
  const baseResult = routeState.geometryVariants[geometryMode];
  const activeLines = activeCircumferenceLines(
    runtime.circumferenceSchedules[areaKey],
    state.scheduleWeekday,
    state.scheduleMinute,
  );
  const scheduleKey = scheduleLineStateKey(baseResult.network, activeLines);
  if (
    routeState.areaKey === areaKey &&
    routeState.geometryMode === geometryMode &&
    routeState.scheduleKey === scheduleKey
  ) {
    return false;
  }

  const result: CircumferenceModeResult = scheduleCircumferenceMode(
    baseResult,
    activeLines,
    geometryMode,
  );
  routeState.areaKey = areaKey;
  routeState.geometryMode = geometryMode;
  routeState.scheduleKey = scheduleKey;
  routeState.candidates = result.candidates;
  routeState.network = result.network;
  routeState.methodology = result.methodology;
  routeState.activeLineNames = [
    ...new Set(
      result.network.segments.flatMap((segment) =>
        segment.type === 'ride' ? segment.lines : [],
      ),
    ),
  ].sort(sortLineNames);

  const storedOverride = storedCircumferenceOverride(areaKey);
  routeState.overrideId = result.candidates.some(
    (candidate) => candidate.id === storedOverride,
  )
    ? storedOverride
    : '';
  if (
    !routeState.overrideId &&
    storedOverride &&
    !baseResult.candidates.some((candidate) => candidate.id === storedOverride)
  ) {
    storeCircumferenceOverride(areaKey, '');
  }
  routeState.selected = selectedCandidateForState(routeState);
  if (routeState.selected) {
    updateCircumferenceGradient(areaKey, routeState.selected);
  }
  return true;
}

function renderFocusedCircumferenceArea({ fit = false } = {}): void {
  setActiveCircumferenceState(runtime.activeAreaKey);
  renderCircumferenceOptions();
  const candidate = selectedCircumferenceCandidate();
  if (!candidate) {
    const noService = circumferenceState.activeLineNames.length === 0;
    circumferenceNameEl.textContent = noService
      ? 'No scheduled metro service'
      : 'No closed metro loop found';
    circumferenceSummaryEl.textContent = noService
      ? `${AREAS[runtime.activeAreaKey].label} has no eligible metro lines operating ${departureLabel()}.`
      : 'The scheduled lines at this time do not produce a valid simple route.';
    routeChoiceSummaryEl.textContent = noService
      ? 'All lines and route overlays are hidden for this schedule period.'
      : 'No ranked routes are available for this schedule period.';
    renderCircumferenceResults();
    syncCircumferenceVisibility();
    if (runtime.activeProduct === 'circumference') {
      updateStatus(noService ? 'No scheduled service' : 'No loop');
    }
    return;
  }

  renderCircumferenceCandidate(candidate, { fit });
  if (window.__transitPerformance.circumferenceReadyMs === null) {
    window.__transitPerformance.circumferenceReadyMs =
      performance.now() - window.__transitPerformance.startedAt;
    document.documentElement.dataset['circumferenceReadyMs'] =
      window.__transitPerformance.circumferenceReadyMs.toFixed(1);
  }
  if (runtime.activeProduct === 'circumference') updateStatus('Route ready');
}

export function focusCircumferenceArea(
  areaKey: AreaKey,
  { fit = true }: { readonly fit?: boolean } = {},
): void {
  setActiveCircumferenceState(areaKey);
  renderFocusedCircumferenceArea({
    fit: fit && runtime.activeProduct === 'circumference',
  });
}

export function prepareCircumferenceRoute(
  sequence: number = runtime.loadSequence,
): void {
  if (sequence !== runtime.loadSequence || !runtime.circumferenceLandmasses) {
    return;
  }

  if (runtime.activeProduct === 'circumference') {
    updateStatus('Finding loops', { isLoading: true });
  }
  const geometryMode: CircumferenceGeometryMode = routeTrackGeometryToggle.checked
    ? 'track'
    : 'straight';
  let changed = false;
  for (const areaKey of AREA_KEYS) {
    changed = prepareCircumferenceArea(areaKey, geometryMode) || changed;
  }
  circumferenceScheduleSummaryEl.textContent = `${departureLabel()} local time · ${AREA_KEYS.map(
    (areaKey) => {
      const lineCount = circumferenceStates[areaKey].activeLineNames.length;
      return `${AREAS[areaKey].label}: ${
        lineCount === 0 ? 'no service' : `${lineCount} lines`
      }`;
    },
  ).join(' · ')}`;
  routeTrackGeometryToggle.disabled = !AREA_KEYS.every(
    (areaKey) =>
      circumferenceStates[areaKey].methodology?.trackGeometryAvailable === true,
  );
  updateCombinedCircumferenceSource();
  renderFocusedCircumferenceArea({
    fit: changed && runtime.activeProduct === 'circumference',
  });
  if (runtime.activeProduct === 'circumference' && circumferenceState.selected) {
    updateStatus('Route ready');
  }
}
