import type { z } from 'zod';
import { syncGovernmentSeats } from './government-seats-ui.js';
import {
  EMPTY_CIRCUMFERENCE_GRADIENT_URL,
  type BoundsTuple,
  createCircumferenceGradientSource,
} from '../circumference-gradient-source.js';
import {
  CIRCUMFERENCE_GRADIENT_COAST_LAYER_ID,
  CIRCUMFERENCE_GRADIENT_MAX_DISTANCE_METERS,
  CIRCUMFERENCE_GRADIENT_TEXTURE_SIZE,
  circumferenceGradientDistanceForArea,
  circumferenceGradientViewportBounds,
} from '../circumference-map.js';
import {
  gradedRoadNetworkSchema,
  highwayMapFeaturePropertiesSchema,
  type GradedRoadNetwork,
  type RoadCircle,
} from '../highway-circumference.js';
import { fetchParsed } from '../parse.js';
import { gradientRenderer } from './gradient-rendering.js';
import type { MetadataDetail } from './types.js';
import {
  circumferenceDepartureControlEl,
  circumferenceMetadataEl,
  circumferenceMethodNoteEl,
  circumferenceNameEl,
  circumferenceResultsEl,
  circumferenceResultsHeadingEl,
  circumferenceSelectedHeadingEl,
  circumferenceSelectionTypeEl,
  circumferenceSummaryEl,
  compactPanelQuery,
  formatArea,
  formatRouteLength,
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
  updateStatus,
} from './context.js';
import {
  allowedCircumferenceGrades,
  circumferenceNetworkMode,
  showRoadGradeCoverage,
} from './circumference-criteria.js';
import { roadGradeMask } from '../circumference/grades.js';

const HIGHWAY_DATA_URL = 'data/north-america-road-circles.json?v=20261122';
const HIGHWAY_GEOMETRY_URL = 'data/north-america-road-circles-geometry.json?v=20261122';
let highwayData: GradedRoadNetwork | null = null;
let highwayPromise: Promise<GradedRoadNetwork> | null = null;
const HIGHWAY_GRADIENT_SOURCE_ID = 'highway-circumference-gradient';
let gradientCircleId: string | null = null;

export function installHighwayGradient(): void {
  map.addSource(
    HIGHWAY_GRADIENT_SOURCE_ID,
    createCircumferenceGradientSource(
      EMPTY_CIRCUMFERENCE_GRADIENT_URL,
      [-125, 24, -66, 50],
    ),
  );
  map.addLayer({
    id: HIGHWAY_GRADIENT_SOURCE_ID,
    type: 'raster',
    source: HIGHWAY_GRADIENT_SOURCE_ID,
    layout: { visibility: 'none' },
    paint: {
      'raster-opacity': 0.9,
      'raster-fade-duration': 0,
      'raster-resampling': 'linear',
    },
  });
  map.on('moveend', refreshHighwayGradient);
  map.on('resize', refreshHighwayGradient);
}

export function highwayCriterionActive(): boolean {
  return circumferenceNetworkMode() === 'road';
}

function selectedRoadCircle(): RoadCircle | null {
  if (!highwayData) return null;
  const id = highwayData.selections[roadGradeMask(allowedCircumferenceGrades())];
  return id ? (highwayData.circles[id] ?? null) : null;
}

function setLayerVisibility(id: string, visible: boolean): void {
  if (map.getLayer(id)) {
    map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }
}

export function syncHighwayLayerVisibility(): void {
  const roadMode =
    runtime.activeProduct === 'circumference' && highwayCriterionActive();
  const visible = roadMode && highwayData !== null;
  const circle = visible ? selectedRoadCircle() : null;
  syncGovernmentSeats(roadMode, false);
  for (const layer of [
    'highway-circumference-network-casing',
    'highway-circumference-network-line',
    'highway-circumference-network-connector-casing',
    'highway-circumference-network-connector-line',
    'highway-circumference-graded-line',
  ]) {
    setLayerVisibility(layer, visible);
  }
  const gradedLayer = 'highway-circumference-graded-line';
  if (map.getLayer(gradedLayer)) {
    map.setPaintProperty(gradedLayer, 'line-color', [
      'case',
      ['in', ['get', 'grade'], ['literal', [...allowedCircumferenceGrades()]]],
      '#425e6d',
      '#a9a39b',
    ]);
  }
  setLayerVisibility(
    HIGHWAY_GRADIENT_SOURCE_ID,
    circle !== null && routeGradientToggle.checked,
  );
  const areaLayer = 'highway-circumference-area';
  if (circle && map.getLayer(areaLayer)) {
    map.setFilter(areaLayer, ['==', ['get', 'id'], circle.id]);
  }
  setLayerVisibility(areaLayer, circle !== null && routeAreaToggle.checked);
  for (const [layer, role] of Object.entries({
    'highway-circumference-route-casing': 'mainline',
    'highway-circumference-route-line': 'mainline',
    'highway-circumference-route-connector-casing': 'connector',
    'highway-circumference-route-connector-line': 'connector',
  })) {
    if (circle && map.getLayer(layer)) {
      map.setFilter(layer, [
        'all',
        ['==', ['get', 'role'], role],
        ['in', `|${circle.id}|`, ['coalesce', ['get', 'circles'], '']],
      ]);
    }
    setLayerVisibility(layer, circle !== null);
  }
  refreshHighwayGradient();
}

function setParentControlHidden(control: Element, hidden: boolean): void {
  const parent = control.closest('label');
  if (parent instanceof HTMLElement) parent.hidden = hidden;
}

export function syncCircumferenceCriterionControls(): void {
  const highwayMode = highwayCriterionActive();
  const circle = highwayMode ? selectedRoadCircle() : null;
  const distance = circle
    ? circumferenceGradientDistanceForArea(circle.areaSquareMeters)
    : CIRCUMFERENCE_GRADIENT_MAX_DISTANCE_METERS;
  const legend = document.querySelector('.circumference-legend');
  const middle = document.querySelector('#circumference-gradient-middle');
  const maximum = document.querySelector('#circumference-gradient-maximum');
  if (middle) middle.textContent = formatRouteLength(distance / 2);
  if (maximum) maximum.textContent = `${formatRouteLength(distance)} max`;
  legend?.setAttribute(
    'aria-label',
    `${highwayMode ? 'Outside boundary' : 'Route-distance'} gradient, clipped at the coast and fading to transparent by ${formatRouteLength(distance)}`,
  );
  setParentControlHidden(routeTrackGeometryToggle, highwayMode);
  setParentControlHidden(routeStationsToggle, highwayMode);
  circumferenceDepartureControlEl.hidden = highwayMode;
  circumferenceResultsHeadingEl.textContent = highwayMode
    ? 'Largest eligible road circle'
    : 'Largest independent circles';
  circumferenceSelectedHeadingEl.textContent = highwayMode
    ? 'Highway details'
    : 'Line or transfer details';
  circumferenceMethodNoteEl.textContent = highwayMode
    ? 'The search uses every reviewed road segment with an allowed grade and follows legal turns between paired carriageways. The highlighted route is the largest eligible circle by enclosed area.'
    : 'Eligible metro segments stay visible even if they form no circle. Station transfers connect eligible rides. Each result card focuses the map on an independent circle.';
}

function replaceMetadata(details: readonly MetadataDetail[]): void {
  circumferenceMetadataEl.replaceChildren(
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

function highwayResultCard(circle: RoadCircle, landmassLabel: string): HTMLElement {
  const result = document.createElement('article');
  result.className = 'circumference-result';
  result.dataset['focused'] = 'true';

  const focusButton = document.createElement('button');
  focusButton.type = 'button';
  focusButton.className = 'result-focus-button';
  focusButton.dataset['focusHighway'] = circle.id;
  focusButton.setAttribute('aria-label', 'Focus map on the North American road circle');
  const name = document.createElement('h3');
  name.textContent = 'North America · Road circle';
  const description = document.createElement('small');
  description.textContent = `${circle.boundaryCorridorCount.toLocaleString('en-US')} road segments`;
  const focusAction = document.createElement('span');
  focusAction.className = 'focus-action';
  focusAction.textContent = 'Focus map';
  focusButton.append(name, description, focusAction);
  result.append(focusButton);

  const metrics = document.createElement('div');
  metrics.className = 'result-metrics';
  const metricValues: readonly (readonly [string, string])[] = [
    ['Contained land', formatArea(circle.containedLandAreaSquareMeters)],
    ['Outside to coast', formatArea(circle.outsideLandAreaSquareMeters)],
    ['Route', formatRouteLength(circle.lengthMeters)],
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
  const row = document.createElement('div');
  row.className = 'result-landmass';
  const landmassName = document.createElement('strong');
  landmassName.textContent = landmassLabel;
  const inside = document.createElement('span');
  inside.textContent = `${formatArea(circle.containedLandAreaSquareMeters)} inside`;
  const outside = document.createElement('span');
  outside.textContent = `${formatArea(
    circle.outsideLandAreaSquareMeters,
  )} outside to coast`;
  row.append(landmassName, inside, outside);
  landmasses.append(row);
  result.append(landmasses);

  const summary = document.createElement('p');
  summary.className = 'result-summary';
  summary.textContent = `Grades ${circle.grades.join(', ')} · WGS84 ellipsoidal area`;
  result.append(summary);
  return result;
}

export function renderHighwayResults(): void {
  const circle = selectedRoadCircle();
  if (highwayData && circle) {
    circumferenceResultsEl.replaceChildren(
      highwayResultCard(circle, highwayData.landmassLabel),
    );
    return;
  }
  const message = document.createElement('p');
  message.className = 'result-empty';
  message.textContent = highwayData
    ? 'No road circle matches the selected grades.'
    : 'Loading North American road grades…';
  circumferenceResultsEl.replaceChildren(message);
}

function positionHighwayGradient(): void {
  const beforeLayer = map.getLayer(CIRCUMFERENCE_GRADIENT_COAST_LAYER_ID)
    ? CIRCUMFERENCE_GRADIENT_COAST_LAYER_ID
    : map.getLayer('street-proximity')
      ? 'street-proximity'
      : undefined;
  if (map.getLayer(HIGHWAY_GRADIENT_SOURCE_ID)) {
    map.moveLayer(HIGHWAY_GRADIENT_SOURCE_ID, beforeLayer);
  }
}

export function refreshHighwayGradient(): void {
  const circle = selectedRoadCircle();
  if (
    !circle ||
    !highwayCriterionActive() ||
    runtime.activeProduct !== 'circumference' ||
    !routeGradientToggle.checked
  ) {
    gradientRenderer.cancel(HIGHWAY_GRADIENT_SOURCE_ID);
    return;
  }
  const source = imageSource(HIGHWAY_GRADIENT_SOURCE_ID);
  if (!source) return;
  if (gradientCircleId !== circle.id) {
    source.updateImage({ url: EMPTY_CIRCUMFERENCE_GRADIENT_URL });
    gradientCircleId = circle.id;
  }
  const geometryUrl = new URL(HIGHWAY_GEOMETRY_URL, window.location.href);
  geometryUrl.hash = circle.id;
  gradientRenderer.configure(HIGHWAY_GRADIENT_SOURCE_ID, {
    highwayUrl: geometryUrl.href,
  });
  const envelope = circle.gradientBounds;
  const bounds = map.getBounds();
  const viewport: BoundsTuple = [
    bounds.getWest(),
    bounds.getSouth(),
    bounds.getEast(),
    bounds.getNorth(),
  ];
  const visibleBounds = circumferenceGradientViewportBounds(envelope, viewport, 0);
  const gradientBounds = circumferenceGradientViewportBounds(envelope, viewport);
  if (!gradientBounds || !visibleBounds) {
    gradientRenderer.cancel(HIGHWAY_GRADIENT_SOURCE_ID);
    return;
  }
  const canvas = map.getCanvas();
  gradientRenderer.request(
    HIGHWAY_GRADIENT_SOURCE_ID,
    {
      bounds: gradientBounds,
      width: Math.min(
        CIRCUMFERENCE_GRADIENT_TEXTURE_SIZE,
        Math.max(256, Math.ceil(canvas.clientWidth * 1.4)),
      ),
      height: Math.min(
        CIRCUMFERENCE_GRADIENT_TEXTURE_SIZE,
        Math.max(256, Math.ceil(canvas.clientHeight * 1.4)),
      ),
    },
    visibleBounds,
  );
}

export function fitHighwayCircumference({
  animate = true,
}: { readonly animate?: boolean } = {}): void {
  if (!highwayData) return;
  map.fitBounds(selectedRoadCircle()?.bounds ?? highwayData.bounds, {
    padding: compactPanelQuery.matches ? 30 : 56,
    duration: animate ? 620 : 0,
  });
}

function renderHighwayCircumference({
  fit = false,
}: { readonly fit?: boolean } = {}): void {
  const data = highwayData;
  if (!data) return;
  showRoadGradeCoverage(data.segmentCount, data.coverage.pending ?? 0);
  syncCircumferenceCriterionControls();
  renderHighwayResults();
  syncHighwayLayerVisibility();
  routeChoiceSelect.disabled = true;
  routeAutoButton.disabled = true;
  routeRequireSegmentButton.disabled = true;
  routeAvoidSegmentButton.disabled = true;
  routeClearSegmentsButton.disabled = true;
  const circle = selectedRoadCircle();
  circumferenceSelectionTypeEl.textContent = circle
    ? 'Selected road circle'
    : 'Nothing selected';
  circumferenceNameEl.textContent = circle
    ? 'North America · Road circle'
    : 'No matching road circle';
  circumferenceSummaryEl.textContent =
    'Click a road segment to see its grade and details.';
  routeChoiceSummaryEl.textContent =
    'The road circle updates when you change the allowed grades.';
  replaceMetadata(
    circle
      ? [
          { label: 'Enclosed area', value: formatArea(circle.areaSquareMeters) },
          {
            label: 'Contained land',
            value: formatArea(circle.containedLandAreaSquareMeters),
          },
          { label: 'Boundary length', value: formatRouteLength(circle.lengthMeters) },
          { label: 'Grades', value: circle.grades.join(', ') },
          { label: 'Source', value: `OpenStreetMap · ${data.sourceVersion}` },
        ]
      : [],
  );
  positionHighwayGradient();
  if (fit && runtime.activeProduct === 'circumference') fitHighwayCircumference();
  updateStatus(circle ? 'Road circle ready' : 'No matching road circle');
}

export function showHighwayFeature(
  properties: z.infer<typeof highwayMapFeaturePropertiesSchema>,
): void {
  if (!highwayData) return;
  const circle = selectedRoadCircle();
  const onCircle = circle && properties.circles?.includes(`|${circle.id}|`);
  const connector = properties.role === 'connector';
  circumferenceSelectionTypeEl.textContent = connector
    ? 'Selected freeway connector'
    : 'Selected motorway segment';
  circumferenceNameEl.textContent =
    properties.name ||
    properties.number ||
    (connector ? 'Interchange connector' : 'Unnamed motorway');
  circumferenceSummaryEl.textContent = onCircle
    ? 'Part of the selected road circle.'
    : connector
      ? 'Paired movements through an interchange.'
      : 'Mainline between road junctions.';
  replaceMetadata([
    { label: 'Grade', value: properties.grade ?? 'Awaiting verification' },
    {
      label: 'Review issue',
      value:
        properties.review_issue ??
        (properties.segment_id === undefined
          ? 'No matching segment in the paired road graph'
          : null),
    },
    { label: 'Road class', value: properties.class },
    { label: 'Route', value: properties.number || properties.name },
    { label: 'OSM ways to verify', value: properties.osm_ways },
    { label: 'Dataset feature', value: properties.id },
  ]);
  routeRequireSegmentButton.disabled = true;
  routeAvoidSegmentButton.disabled = true;
}

async function loadHighwayCircumference(): Promise<GradedRoadNetwork> {
  if (highwayData) return highwayData;
  highwayPromise ??= fetchParsed(HIGHWAY_DATA_URL, gradedRoadNetworkSchema);
  highwayData = await highwayPromise;
  return highwayData;
}

export async function prepareHighwayCircumference({
  fit = true,
}: { readonly fit?: boolean } = {}): Promise<void> {
  syncCircumferenceCriterionControls();
  renderHighwayResults();
  if (runtime.activeProduct === 'circumference') {
    updateStatus('Loading highway network', { isLoading: true });
  }
  try {
    await loadHighwayCircumference();
    if (!highwayCriterionActive() || runtime.activeProduct !== 'circumference') return;
    renderHighwayCircumference({ fit });
  } catch (error) {
    console.error(error);
    highwayPromise = null;
    if (!highwayCriterionActive() || runtime.activeProduct !== 'circumference') return;
    const empty = document.createElement('p');
    empty.className = 'result-empty';
    empty.textContent = 'The North American highway network could not be loaded.';
    circumferenceResultsEl.replaceChildren(empty);
    updateStatus('Highway data missing', { isError: true });
  }
}

export function installHighwayHover(): void {
  let hovered: {
    readonly id: string | number;
    readonly source: string;
    readonly sourceLayer?: string;
  } | null = null;
  const layerIds = [
    'highway-circumference-route-connector-line',
    'highway-circumference-route-line',
    'highway-circumference-graded-line',
    'highway-circumference-network-connector-line',
    'highway-circumference-network-line',
  ];
  for (const layerId of layerIds) {
    map.on('mousemove', layerId, (event) => {
      const feature = event.features?.[0];
      if (!feature || feature.id === undefined) return;
      const { source, sourceLayer } = feature;
      if (hovered !== null) {
        map.setFeatureState(
          {
            source: hovered.source,
            ...(hovered.sourceLayer ? { sourceLayer: hovered.sourceLayer } : {}),
            id: hovered.id,
          },
          { hover: false },
        );
      }
      hovered = {
        id: feature.id,
        source,
        ...(sourceLayer ? { sourceLayer } : {}),
      };
      map.setFeatureState(
        {
          source,
          ...(sourceLayer ? { sourceLayer } : {}),
          id: feature.id,
        },
        { hover: true },
      );
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', layerId, () => {
      if (hovered !== null) {
        map.setFeatureState(
          {
            source: hovered.source,
            ...(hovered.sourceLayer ? { sourceLayer: hovered.sourceLayer } : {}),
            id: hovered.id,
          },
          { hover: false },
        );
      }
      hovered = null;
      map.getCanvas().style.cursor = '';
    });
  }
  map.on('click', layerIds, (event) => {
    const properties = highwayMapFeaturePropertiesSchema.safeParse(
      event.features?.[0]?.properties,
    );
    if (properties.success) showHighwayFeature(properties.data);
  });
}
