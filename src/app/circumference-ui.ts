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
  activeCircumferenceService,
  junctionContinuationLineLanes,
  junctionContinuationSections,
  scheduleCircumferenceMode,
  scheduleLineStateKey,
  selectCircumferenceCandidate,
  selectIndependentCircumferenceCandidates,
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
import type { LandmassArea } from '../domain.js';
import { lineColor } from '../line-colors.js';
import type { AreaKey } from './types.js';
import {
  AREAS,
  AREA_KEYS,
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
import {
  highwayCriterionActive,
  highwayDataLoaded,
  prepareHighwayCircumference,
  renderHighwayResults,
  syncCircumferenceCriterionControls,
} from './highway-circumference-ui.js';
import { setLayerVisibility } from './map-ui-utils.js';

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
  const highwayMode = highwayCriterionActive();
  const networkVisible =
    runtime.activeProduct === 'circumference' &&
    !highwayMode &&
    AREA_KEYS.some(
      (areaKey) => circumferenceStates[areaKey].network.segments.length > 0,
    );
  const routeVisible =
    runtime.activeProduct === 'circumference' &&
    !highwayMode &&
    AREA_KEYS.some((areaKey) => Boolean(circumferenceStates[areaKey].selected));
  const highwayVisible =
    runtime.activeProduct === 'circumference' && highwayMode && highwayDataLoaded();
  for (const areaKey of AREA_KEYS) {
    setLayerVisibility(
      `circumference-gradient-${areaKey}`,
      routeGradientToggle.checked &&
        ((highwayVisible && areaKey === 'cdmx') ||
          (routeVisible && Boolean(circumferenceStates[areaKey].selected))),
    );
  }
  setLayerVisibility('circumference-area', routeVisible && routeAreaToggle.checked);
  setLayerVisibility(
    'highway-circumference-area',
    highwayVisible && routeAreaToggle.checked,
  );
  setLayerVisibility('highway-circumference-network-casing', highwayVisible);
  setLayerVisibility('highway-circumference-network-line', highwayVisible);
  setLayerVisibility('highway-circumference-network-connector-casing', highwayVisible);
  setLayerVisibility('highway-circumference-network-connector-line', highwayVisible);
  setLayerVisibility('highway-circumference-route-casing', highwayVisible);
  setLayerVisibility('highway-circumference-route-line', highwayVisible);
  setLayerVisibility('highway-circumference-route-connector-casing', highwayVisible);
  setLayerVisibility('highway-circumference-route-connector-line', highwayVisible);
  setLayerVisibility('circumference-network-casing', networkVisible);
  setLayerVisibility('circumference-network-line', networkVisible);
  setLayerVisibility('circumference-network-transfer-line', networkVisible);
  setLayerVisibility('circumference-route-alternative-casing', routeVisible);
  setLayerVisibility('circumference-route-alternative-line', routeVisible);
  setLayerVisibility('circumference-route-casing', routeVisible);
  setLayerVisibility('circumference-route-line', routeVisible);
  setLayerVisibility('circumference-transfer-line', routeVisible);
  setLayerVisibility(
    'circumference-network-stations',
    networkVisible && routeStationsToggle.checked,
  );
  setLayerVisibility(
    'circumference-network-labels',
    networkVisible && routeStationsToggle.checked,
  );
  setLayerVisibility(
    'circumference-route-stations',
    routeVisible && routeStationsToggle.checked,
  );
  setLayerVisibility(
    'circumference-route-labels',
    routeVisible && routeStationsToggle.checked,
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
      ? 'Any visible route can be inspected directly, in any city.'
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
  const fullLineCoordinates = circumferenceState.network.segments.flatMap((segment) =>
    segment.display === false ? [] : segment.coordinates,
  );
  const focusCoordinates = [...(candidate?.coordinates ?? []), ...fullLineCoordinates];
  if (focusCoordinates.length === 0) return;
  const bounds = focusCoordinates.reduce(
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

interface LineOffsets {
  readonly atZoom8: number;
  readonly atZoom12: number;
  readonly atZoom15: number;
}

function networkLineOffsets(position: number): LineOffsets {
  return {
    atZoom8: position * 1.8,
    atZoom12: position * 3.2,
    atZoom15: position * 5.2,
  };
}

function boundaryAlternativeLineOffsets(position: number, side: -1 | 1): LineOffsets {
  return {
    atZoom8: side * (4.4 + position * 1.8),
    atZoom12: side * (7.3 + position * 3.2),
    atZoom15: side * (10.5 + position * 5.2),
  };
}

function interpolatedLineOffsets(
  continuation: LineOffsets,
  normal: LineOffsets,
  continuationFraction: number,
): LineOffsets {
  return {
    atZoom8:
      normal.atZoom8 + (continuation.atZoom8 - normal.atZoom8) * continuationFraction,
    atZoom12:
      normal.atZoom12 +
      (continuation.atZoom12 - normal.atZoom12) * continuationFraction,
    atZoom15:
      normal.atZoom15 +
      (continuation.atZoom15 - normal.atZoom15) * continuationFraction,
  };
}

function lineOffsetProperties(offsets: LineOffsets): GeoJsonProperties {
  return {
    line_offset_8: offsets.atZoom8,
    line_offset_12: offsets.atZoom12,
    line_offset_15: offsets.atZoom15,
  };
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
  candidate: CircumferenceCandidate | null,
  areaKey: AreaKey,
  routeState = circumferenceStates[areaKey],
): FeatureCollection<Geometry, GeoJsonProperties> {
  const features: Feature<Geometry, GeoJsonProperties>[] = candidate
    ? [
        {
          type: 'Feature',
          id: `${areaKey}:inside`,
          geometry: {
            type: 'Polygon',
            coordinates: [candidate.coordinates],
          },
          properties: { area_key: areaKey, kind: 'inside' },
        },
      ]
    : [];
  const candidateSegments = candidate?.segments ?? [];
  let featureId = 0;
  const boundaryRideKeys = new Set(
    candidateSegments
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
  const boundaryLineLayouts = candidateSegments
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
  const networkLineLayouts = routeState.network.segments
    .filter((segment) => segment.type === 'ride' && segment.display !== false)
    .map((segment) => ({
      coordinates: segment.coordinates,
      fromId: segment.from.id,
      lines: segment.lines,
      toId: segment.to.id,
    }));
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
            networkLineLayouts,
          )
        : new Map();
    for (const [index, lineName] of displayedLines.entries()) {
      const continuationLane = continuationLanes.get(lineName);
      const normalPosition =
        segment.type === 'transfer'
          ? 0
          : centeredLinePosition(index, displayedLines.length);
      const normalOffsets = networkLineOffsets(normalPosition);
      const nodeCoordinate = continuationLane
        ? coordinatesByNodeId.get(continuationLane.nodeId)
        : undefined;
      const continuationSections =
        continuationLane && nodeCoordinate
          ? junctionContinuationSections(
              segment.coordinates,
              nodeCoordinate,
              continuationLane,
            )
          : [
              {
                continuationFraction: 0,
                coordinates: segment.coordinates,
              },
            ];
      const continuationOffsets =
        continuationLane?.style === 'boundary-alternative'
          ? boundaryAlternativeLineOffsets(
              continuationLane.index,
              continuationLane.side,
            )
          : continuationLane
            ? networkLineOffsets(continuationLane.index * continuationLane.side)
            : normalOffsets;

      for (const section of continuationSections) {
        if (section.coordinates.length < 2) continue;
        const offsets = interpolatedLineOffsets(
          continuationOffsets,
          normalOffsets,
          section.continuationFraction,
        );
        const feature: Feature<LineString, GeoJsonProperties> = {
          type: 'Feature',
          id: `${areaKey}:${featureId}`,
          geometry: {
            type: 'LineString',
            coordinates: [...section.coordinates],
          },
          properties: {
            kind:
              segment.type === 'transfer'
                ? 'network-transfer'
                : continuationLane?.style === 'boundary-alternative' &&
                    section.continuationFraction > 0
                  ? 'segment-alternative'
                  : 'network-segment',
            line: lineName,
            color: segment.type === 'transfer' ? '' : lineColor(areaKey, lineName),
            area_key: areaKey,
            line_position: continuationLane?.index ?? normalPosition,
            line_side: continuationLane?.side ?? 1,
            junction_continuation: continuationLane !== undefined,
            continuation_fraction: section.continuationFraction,
            ...lineOffsetProperties(offsets),
          },
        };
        features.push(feature);
        featureId += 1;
      }
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

  for (const segment of candidateSegments) {
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
      const linePosition =
        segment.type === 'transfer'
          ? 0
          : isPrimaryLine
            ? 0
            : alternativeLines.indexOf(lineName);
      const offsets = isPrimaryLine
        ? networkLineOffsets(0)
        : boundaryAlternativeLineOffsets(linePosition, 1);
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
          line_position: linePosition,
          line_side: 1,
          ...lineOffsetProperties(offsets),
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

  for (const [index, station] of (candidate?.stations ?? []).entries()) {
    const firstLine =
      candidateSegments[index]?.primaryLine ??
      candidateSegments[
        (index - 1 + candidateSegments.length) % candidateSegments.length
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

interface CircumferenceCircleResult {
  readonly areaKey: AreaKey;
  readonly areaRank: number;
  readonly candidate: CircumferenceCandidate;
  readonly metroCircleCount: number;
}

const landmassCoverageCache = new WeakMap<
  CircumferenceCandidate,
  {
    readonly coverage: LandmassCoverage[];
    readonly landmassArea: LandmassArea;
  }
>();

function compareCircleArea(
  first: CircumferenceCandidate,
  second: CircumferenceCandidate,
): number {
  return (
    second.areaSquareMeters - first.areaSquareMeters ||
    first.id.localeCompare(second.id)
  );
}

/**
 * Treat circles—not metro areas—as the result entity. Metros without a valid
 * cycle contribute no card, while every valid scheduled cycle is globally
 * ordered by its precise area in the currently selected geometry mode.
 */
export function circumferenceCircleResults(): CircumferenceCircleResult[] {
  return AREA_KEYS.flatMap((areaKey) => {
    const candidates = selectIndependentCircumferenceCandidates(
      circumferenceStates[areaKey].candidates,
    );
    return candidates.map((candidate, index) => ({
      areaKey,
      areaRank: index + 1,
      candidate,
      metroCircleCount: candidates.length,
    }));
  }).sort(
    (first, second) =>
      compareCircleArea(first.candidate, second.candidate) ||
      AREAS[first.areaKey].label.localeCompare(AREAS[second.areaKey].label) ||
      first.areaRank - second.areaRank,
  );
}

function candidateLandmassCoverage(
  candidate: CircumferenceCandidate,
  landmassArea: LandmassArea,
): LandmassCoverage[] {
  const cached = landmassCoverageCache.get(candidate);
  if (cached?.landmassArea === landmassArea) return cached.coverage;
  const coverage = calculateLandmassCoverage(candidate.coordinates, landmassArea);
  landmassCoverageCache.set(candidate, { coverage, landmassArea });
  return coverage;
}

function createCircumferenceResult({
  areaKey,
  areaRank,
  candidate,
  metroCircleCount,
}: CircumferenceCircleResult): HTMLElement {
  const routeState = circumferenceStates[areaKey];
  const isFocused =
    areaKey === runtime.activeAreaKey && routeState.selected?.id === candidate.id;
  const result = document.createElement('article');
  result.className = 'circumference-result';
  result.dataset['focused'] = String(isFocused);

  const focusButton = document.createElement('button');
  focusButton.type = 'button';
  focusButton.className = 'result-focus-button';
  focusButton.dataset['focusArea'] = areaKey;
  focusButton.dataset['focusCandidate'] = candidate.id;
  focusButton.setAttribute(
    'aria-label',
    `Focus map on ${AREAS[areaKey].label} circle ${areaRank} of ${metroCircleCount}`,
  );
  const name = document.createElement('h3');
  name.textContent = `${AREAS[areaKey].label} · Circle ${areaRank}`;
  const description = document.createElement('small');
  description.textContent = `${candidate.lines.length} lines · ${candidate.stations.length} platform nodes`;
  const focusAction = document.createElement('span');
  focusAction.className = 'focus-action';
  focusAction.textContent = isFocused ? 'Focused' : 'Focus map';
  focusButton.append(name, description, focusAction);
  result.append(focusButton);

  const landmassArea = runtime.circumferenceLandmasses?.areas[areaKey];
  const coverage =
    isFocused && landmassArea ? candidateLandmassCoverage(candidate, landmassArea) : [];
  const outerArea = combinedLandmassArea(coverage, 'outsideAreaSquareMeters');
  const metrics = document.createElement('div');
  metrics.className = 'result-metrics';
  const metricValues: readonly (readonly [string, string])[] = isFocused
    ? [
        ['Inside', formatArea(candidate.areaSquareMeters)],
        [
          coverage.length === 1
            ? 'Outside · 1 landmass'
            : `Outside · ${coverage.length} landmasses`,
          formatArea(outerArea),
        ],
        ['Route', formatRouteLength(candidate.lengthMeters)],
      ]
    : [
        ['Inside', formatArea(candidate.areaSquareMeters)],
        ['Route', formatRouteLength(candidate.lengthMeters)],
        ['Walking transfers', candidate.transferCount.toLocaleString('en-US')],
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

  const methodology = routeState.methodology;
  const summary = document.createElement('p');
  summary.className = 'result-summary';
  const choiceSummary =
    routeState.overrideId === candidate.id
      ? 'Pinned circle'
      : areaRank === 1 && methodology?.optimizationStatus === 'optimal'
        ? 'Largest valid circle in this metro'
        : `Independent circle ${areaRank} of ${metroCircleCount} in this metro`;
  summary.textContent = `${choiceSummary} · ${candidate.transferCount} walking ${
    candidate.transferCount === 1 ? 'transfer' : 'transfers'
  } · ${methodology?.trackGeometryEnabled ? 'track geography' : 'straight edges'}`;
  result.append(summary);
  return result;
}

export function renderCircumferenceResults(): void {
  if (highwayCriterionActive()) {
    renderHighwayResults();
    return;
  }
  const circles = circumferenceCircleResults();
  if (circles.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'result-empty';
    empty.textContent = 'No valid circles operate at this day and time.';
    circumferenceResultsEl.replaceChildren(empty);
    return;
  }
  circumferenceResultsEl.replaceChildren(...circles.map(createCircumferenceResult));
}

export function combinedRouteFeatureCollection(): FeatureCollection<
  Geometry,
  GeoJsonProperties
> {
  return {
    type: 'FeatureCollection',
    features: AREA_KEYS.flatMap((areaKey) => {
      const routeState = circumferenceStates[areaKey];
      return routeFeatureCollection(routeState.selected, areaKey, routeState).features;
    }),
  };
}

function updateCombinedCircumferenceSource(): void {
  geoJsonSource('circumference-route')?.setData(combinedRouteFeatureCollection());
}

function updateCircumferenceGradient(
  areaKey: AreaKey,
  candidate: CircumferenceCandidate,
): void {
  const landmassArea = runtime.circumferenceLandmasses?.areas[areaKey];
  if (!landmassArea) return;
  const canvas = circumferenceCanvases[areaKey];
  const gradientBounds = circumferenceGradientBounds(candidate.coordinates);
  renderCircumferenceGradient(
    canvas,
    candidate.coordinates,
    gradientBounds,
    landmassArea.mask ??
      landmassArea.landmasses.flatMap((landmass) => landmass.mask ?? []),
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
  circumferenceState.selected = candidate;
  if (candidateChanged) resetCircumferenceItemDetails();

  updateCombinedCircumferenceSource();
  updateCircumferenceGradient(runtime.activeAreaKey, candidate);

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
  const activeService = activeCircumferenceService(
    runtime.circumferenceSchedules[areaKey],
    state.scheduleWeekday,
    state.scheduleMinute,
  );
  const scheduleKey = scheduleLineStateKey(baseResult.network, activeService);
  if (
    routeState.areaKey === areaKey &&
    routeState.geometryMode === geometryMode &&
    routeState.scheduleKey === scheduleKey
  ) {
    return false;
  }

  const result: CircumferenceModeResult = scheduleCircumferenceMode(
    baseResult,
    activeService,
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
      ? 'No eligible lines are active in this metro for this schedule period.'
      : 'The operating lines remain visible, but no closed route exists.';
    renderCircumferenceResults();
    syncCircumferenceVisibility();
    if (fit) fitCircumferenceCandidate(null);
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
  syncCircumferenceCriterionControls();
  if (highwayCriterionActive()) {
    void prepareHighwayCircumference();
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
  routeTrackGeometryToggle.disabled = !AREA_KEYS.some(
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
