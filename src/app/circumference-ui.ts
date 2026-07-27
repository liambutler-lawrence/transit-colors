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
  junctionContinuationLineLanes,
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
  renderCircumferenceGradient,
} from '../circumference-map.js';
import type {
  CircumferenceCandidate,
  CircumferenceGeometryMode,
  CircumferenceModeResult,
} from '../circumference/types.js';
import { lineColor } from '../line-colors.js';
import type { AreaKey, MetadataDetail } from './types.js';
import {
  AREAS,
  activeStationModes,
  circumferenceCanvas,
  circumferenceInnerAreaEl,
  circumferenceLandmassBreakdownEl,
  circumferenceLengthEl,
  circumferenceMetadataEl,
  circumferenceNameEl,
  circumferenceOuterAreaEl,
  circumferenceOuterLabelEl,
  circumferenceState,
  circumferenceSummaryEl,
  compactPanelQuery,
  formatArea,
  formatDistance,
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
  if (!map.getLayer('circumference-gradient')) return;

  // Keep the overlay below the detailed basemap water polygons. The stored
  // landmass masks remain the fallback and calculation boundary, while the
  // visible edge follows the same high-resolution shoreline as the map.
  const beforeLayer = map.getLayer(CIRCUMFERENCE_GRADIENT_COAST_LAYER_ID)
    ? CIRCUMFERENCE_GRADIENT_COAST_LAYER_ID
    : map.getLayer('street-proximity')
      ? 'street-proximity'
      : undefined;
  map.moveLayer('circumference-gradient', beforeLayer);
}

export function syncCircumferenceVisibility(): void {
  const visible =
    runtime.activeProduct === 'circumference' && Boolean(circumferenceState.selected);
  setLayerVisibility('circumference-gradient', visible && routeGradientToggle.checked);
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
  circumferenceState.areaKey = null;
  circumferenceState.candidates = [];
  circumferenceState.network = {
    segments: [],
    stations: [],
  };
  circumferenceState.selected = null;
  circumferenceState.overrideId = '';
  circumferenceState.methodology = null;
  circumferenceState.inspectedSegmentId = '';
  circumferenceState.requiredSegmentIds.clear();
  circumferenceState.avoidedSegmentIds.clear();
  circumferenceState.geometryMode = null;
  circumferenceState.geometryVariants = null;
  circumferenceInnerAreaEl.textContent = '--';
  circumferenceOuterAreaEl.textContent = '--';
  circumferenceLengthEl.textContent = '--';
  circumferenceLandmassBreakdownEl.replaceChildren();
  circumferenceNameEl.textContent = 'Waiting for route data';
  circumferenceSummaryEl.textContent = 'The automatic choice maximizes contained area.';
  circumferenceMetadataEl.replaceChildren();
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
): FeatureCollection<Geometry, GeoJsonProperties> {
  const features: Feature<Geometry, GeoJsonProperties>[] = [
    {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [candidate.coordinates],
      },
      properties: { kind: 'inside' },
    },
  ];
  let featureId = 0;
  const boundaryRideKeys = new Set(
    candidate.segments
      .filter((segment) => segment.type === 'ride')
      .map((segment) => segmentEndpointKey(segment.from.id, segment.to.id)),
  );
  const networkLinesByEdge = new Map<string, readonly string[]>();
  for (const segment of circumferenceState.network.segments) {
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
    circumferenceState.network.stations.map((station) => [
      station.id,
      station.coordinate,
    ]),
  );

  for (const segment of circumferenceState.network.segments) {
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
        id: featureId,
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
          color:
            segment.type === 'transfer'
              ? ''
              : lineColor(runtime.activeAreaKey, lineName),
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

  for (const station of circumferenceState.network.stations) {
    const displayedLines = station.lineNames;
    const firstLine = displayedLines[0];
    if (firstLine === undefined) continue;
    const feature: Feature<Point, GeoJsonProperties> = {
      type: 'Feature',
      id: featureId,
      geometry: {
        type: 'Point',
        coordinates: station.coordinate,
      },
      properties: {
        kind: 'network-station',
        name: station.name,
        label: `${station.name} · ${displayedLines.join('/')}`,
        lines: displayedLines.join(', '),
        color: lineColor(runtime.activeAreaKey, firstLine),
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
        id: featureId,
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
          color: lineColor(runtime.activeAreaKey, lineName),
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
      id: featureId,
      geometry: {
        type: 'Point',
        coordinates: station.coordinate,
      },
      properties: {
        kind: 'station',
        name: station.name,
        label: station.label ?? '',
        lines: station.lineNames.join(', '),
        color: lineColor(runtime.activeAreaKey, firstLine),
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

export function renderLandmassBreakdown(coverage: readonly LandmassCoverage[]): void {
  circumferenceLandmassBreakdownEl.replaceChildren(
    ...coverage.map((landmass) => {
      const item = document.createElement('div');
      item.className = 'landmass-stat';
      const name = document.createElement('strong');
      name.textContent = landmass.label;
      const inside = document.createElement('span');
      inside.textContent = `${formatArea(landmass.insideAreaSquareMeters)} inside`;
      const outside = document.createElement('span');
      outside.textContent = `${formatArea(
        landmass.outsideAreaSquareMeters,
      )} outside to coast`;
      item.append(name, inside, outside);
      return item;
    }),
  );
}

export function renderCircumferenceCandidate(
  candidate: CircumferenceCandidate | null,
  { fit = false }: { readonly fit?: boolean } = {},
): void {
  if (!candidate) return;
  const landmassArea = runtime.circumferenceLandmasses?.areas[runtime.activeAreaKey];
  if (!landmassArea) return;
  const eligibleLineNames = new Set(
    circumferenceState.network.segments.flatMap((segment) => segment.lines),
  );
  const fullLineStationCount = circumferenceState.network.stations.length;
  const landmassCoverage = calculateLandmassCoverage(
    candidate.coordinates,
    landmassArea,
  );
  circumferenceState.selected = candidate;
  circumferenceState.inspectedSegmentId = '';
  routeRequireSegmentButton.disabled = true;
  routeAvoidSegmentButton.disabled = true;
  routeClearSegmentsButton.disabled = !hasSegmentOverrides();

  geoJsonSource('circumference-route')?.setData(routeFeatureCollection(candidate));

  if (landmassArea) {
    renderCircumferenceGradient(
      circumferenceCanvas,
      candidate.coordinates,
      landmassArea.gradient_bounds,
      landmassCoverage.flatMap((landmass) => landmass.mask ?? []),
    );
    imageSource('circumference-gradient')?.updateImage({
      coordinates: circumferenceGradientCoordinates(landmassArea.gradient_bounds),
      url: circumferenceCanvas.toDataURL('image/png'),
    });
  }

  const isManual = Boolean(circumferenceState.overrideId);
  const isSegmentEdited = !isManual && hasSegmentOverrides();
  const outerArea = combinedLandmassArea(landmassCoverage, 'outsideAreaSquareMeters');
  circumferenceInnerAreaEl.textContent = formatArea(candidate.areaSquareMeters);
  circumferenceOuterAreaEl.textContent = formatArea(outerArea);
  circumferenceLengthEl.textContent = formatRouteLength(candidate.lengthMeters);
  circumferenceOuterLabelEl.textContent = landmassCoverage.length
    ? `Outside across ${landmassCoverage.length} landmass${
        landmassCoverage.length === 1 ? '' : 'es'
      }`
    : 'Outside to coast';
  renderLandmassBreakdown(landmassCoverage);
  const methodology = circumferenceState.methodology;
  if (!methodology) return;
  circumferenceNameEl.textContent = `${AREAS[runtime.activeAreaKey].label} ${
    isManual
      ? 'pinned loop'
      : isSegmentEdited
        ? 'segment-edited loop'
        : 'maximum-area loop'
  }`;
  circumferenceSummaryEl.textContent = `${
    candidate.stations.length
  } line-platform nodes, including ${candidate.transferCount} walking ${
    candidate.transferCount === 1 ? 'transfer' : 'transfers'
  }, across lines ${candidate.lines.join(', ')}.`;
  replaceMetadata(circumferenceMetadataEl, [
    {
      label: 'Choice',
      value: isManual
        ? 'Manual ranked override'
        : isSegmentEdited
          ? 'Maximum matching segment edits'
          : methodology.optimizationStatus === 'optimal'
            ? 'Proven global platform-edge maximum'
            : 'Automatic area maximum',
    },
    {
      label: 'Landmasses',
      value: landmassCoverage.map((landmass) => landmass.label).join(', '),
    },
    {
      label: 'Free transfers',
      value: `${methodology.publishedTransferCount} published walks, ${methodology.inferredTransferCount} inferred walks`,
    },
    {
      label: 'Selected walking links',
      value: `${candidate.transferCount} · ${formatDistance(
        candidate.walkingLengthMeters,
      )}`,
    },
    {
      label: 'Eligible lines shown',
      value: `${eligibleLineNames.size} lines · ${fullLineStationCount} platform nodes`,
    },
    {
      label: 'Route geometry',
      value: methodology.trackGeometryEnabled
        ? `${methodology.trackGeometryEdgeCount} averaged GTFS track centerlines`
        : 'Straight platform-to-platform edges',
    },
    {
      label: 'Network cleanup',
      value:
        methodology.removedShortcutCount > 0
          ? `${methodology.removedShortcutCount + methodology.displayOnlyShortcutCount} limited-stop chords normalized`
          : 'No limited-stop chords detected',
    },
    {
      label: 'Candidates',
      value: `${circumferenceState.candidates.length} diverse of ${methodology.generatedCandidateCount} valid loops`,
    },
    {
      label: 'Optimization',
      value:
        methodology.optimizationStatus === 'optimal'
          ? `Exact MILP over platform edges · proven offline in ${(
              (methodology.optimizationMilliseconds ?? 0) / 1_000
            ).toFixed(1)} s`
          : 'Heuristic candidate search',
    },
    {
      label: 'Segment edits',
      value: isSegmentEdited
        ? `${circumferenceState.requiredSegmentIds.size} required, ${circumferenceState.avoidedSegmentIds.size} avoided`
        : undefined,
    },
  ]);
  routeChoiceSummaryEl.textContent = isManual
    ? 'This ranked loop is pinned as a manual override for this metro area.'
    : isSegmentEdited
      ? 'Largest-area ranked loop that satisfies the required and avoided segments.'
      : methodology.optimizationStatus === 'optimal'
        ? 'Precomputed exact winner; track mode preserves its topology and recalculates precise track area.'
        : `Automatic winner from ${methodology.generatedCandidateCount} valid loops, ranked by contained area.`;

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

export function prepareCircumferenceRoute(
  sequence: number = runtime.loadSequence,
): void {
  if (
    sequence !== runtime.loadSequence ||
    !circumferenceState.geometryVariants ||
    !runtime.circumferenceLandmasses?.areas?.[runtime.activeAreaKey]
  ) {
    return;
  }

  if (
    circumferenceState.areaKey === runtime.activeAreaKey &&
    circumferenceState.geometryMode ===
      (routeTrackGeometryToggle.checked ? 'track' : 'straight') &&
    circumferenceState.candidates.length > 0
  ) {
    return;
  }

  if (runtime.activeProduct === 'circumference') {
    updateStatus('Finding loops', { isLoading: true });
  }
  const geometryMode: CircumferenceGeometryMode = routeTrackGeometryToggle.checked
    ? 'track'
    : 'straight';
  const result: CircumferenceModeResult =
    circumferenceState.geometryVariants[geometryMode];
  circumferenceState.areaKey = runtime.activeAreaKey;
  circumferenceState.geometryMode = geometryMode;
  circumferenceState.candidates = result.candidates;
  circumferenceState.network = result.network;
  circumferenceState.methodology = result.methodology;
  routeTrackGeometryToggle.disabled = !result.methodology.trackGeometryAvailable;

  const storedOverride = storedCircumferenceOverride(runtime.activeAreaKey);
  circumferenceState.overrideId = result.candidates.some(
    (candidate) => candidate.id === storedOverride,
  )
    ? storedOverride
    : '';
  if (!circumferenceState.overrideId && storedOverride) {
    storeCircumferenceOverride(runtime.activeAreaKey, '');
  }

  renderCircumferenceOptions();
  const candidate = selectedCircumferenceCandidate();
  if (!candidate) {
    circumferenceNameEl.textContent = 'No closed metro loop found';
    circumferenceSummaryEl.textContent =
      'The current criterion does not produce a valid simple route.';
    routeChoiceSummaryEl.textContent = 'No ranked routes are available.';
    if (runtime.activeProduct === 'circumference') {
      updateStatus('No loop', { isError: true });
    }
    return;
  }

  renderCircumferenceCandidate(candidate, {
    fit: runtime.activeProduct === 'circumference',
  });
  if (window.__transitPerformance.circumferenceReadyMs === null) {
    window.__transitPerformance.circumferenceReadyMs =
      performance.now() - window.__transitPerformance.startedAt;
    document.documentElement.dataset['circumferenceReadyMs'] =
      window.__transitPerformance.circumferenceReadyMs.toFixed(1);
  }
  if (runtime.activeProduct === 'circumference') updateStatus('Route ready');
}
