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
  highwayCircumferenceSummarySchema,
  highwayMapFeaturePropertiesSchema,
  type HighwayCircumferenceSummary,
  type HighwayFeatureProperties,
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
  routeCriterionSelect,
  routeGradientToggle,
  routeRequireSegmentButton,
  routeStationsToggle,
  routeTrackGeometryToggle,
  runtime,
  updateStatus,
} from './context.js';

const HIGHWAY_DATA_URL =
  'data/north-america-highway-circumference-summary.json?v=20260910b';
const HIGHWAY_GEOMETRY_URL =
  'data/north-america-highway-circumference.json?v=20260910b';
let highwayData: HighwayCircumferenceSummary | null = null;
let highwayPromise: Promise<HighwayCircumferenceSummary> | null = null;
const HIGHWAY_GRADIENT_SOURCE_ID = 'highway-circumference-gradient';

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
  return routeCriterionSelect.value === 'motorway';
}

export function highwayDataLoaded(): boolean {
  return highwayData !== null;
}

function setLayerVisibility(id: string, visible: boolean): void {
  if (map.getLayer(id)) {
    map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }
}

export function syncHighwayLayerVisibility(): void {
  const visible =
    runtime.activeProduct === 'circumference' &&
    highwayCriterionActive() &&
    highwayDataLoaded();
  setLayerVisibility(
    HIGHWAY_GRADIENT_SOURCE_ID,
    visible && routeGradientToggle.checked,
  );
  setLayerVisibility('highway-circumference-area', visible && routeAreaToggle.checked);
  setLayerVisibility('highway-circumference-network-casing', visible);
  setLayerVisibility('highway-circumference-network-line', visible);
  setLayerVisibility('highway-circumference-network-connector-casing', visible);
  setLayerVisibility('highway-circumference-network-connector-line', visible);
  setLayerVisibility('highway-circumference-route-casing', visible);
  setLayerVisibility('highway-circumference-route-line', visible);
  setLayerVisibility('highway-circumference-route-connector-casing', visible);
  setLayerVisibility('highway-circumference-route-connector-line', visible);
  refreshHighwayGradient();
}

function setParentControlHidden(control: Element, hidden: boolean): void {
  const parent = control.closest('label');
  if (parent instanceof HTMLElement) parent.hidden = hidden;
}

export function syncCircumferenceCriterionControls(): void {
  const highwayMode = highwayCriterionActive();
  const distance =
    highwayMode && highwayData
      ? circumferenceGradientDistanceForArea(highwayData.route.areaSquareMeters)
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
    ? 'Largest controlled-access circle'
    : 'Largest independent circles';
  circumferenceSelectedHeadingEl.textContent = highwayMode
    ? 'Highway details'
    : 'Line or transfer details';
  circumferenceMethodNoteEl.textContent = highwayMode
    ? 'Solid lines are separated 2+ lane controlled-access mainlines; dashed lines join closest-tangent midpoints of opposing ramps, continuing along the mainline where their joins are staggered. One-way-only ramps are excluded. Only explicit paired endpoints form graph junctions—grade-separated crossings do not. The thick route is the largest validated detailed simple boundary.'
    : 'All metro networks stay visible, including metros without a circle. Each result card is the largest circle that does not reuse another result’s rail segments and focuses it on the map; clicking any visible line, platform, transfer, street, or station updates this final section directly.';
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

function highwayResultCard(data: HighwayCircumferenceSummary): HTMLElement {
  const result = document.createElement('article');
  result.className = 'circumference-result';
  result.dataset['focused'] = 'true';

  const focusButton = document.createElement('button');
  focusButton.type = 'button';
  focusButton.className = 'result-focus-button';
  focusButton.dataset['focusHighway'] = data.route.id;
  focusButton.setAttribute(
    'aria-label',
    'Focus map on the North America controlled-access highway circle',
  );
  const name = document.createElement('h3');
  name.textContent = 'North America · Highway circle';
  const description = document.createElement('small');
  description.textContent = `${data.methodology.sourceFeatureCount.toLocaleString(
    'en-US',
  )} highway features · ${data.methodology.interchangeConnectorCount.toLocaleString(
    'en-US',
  )} paired interchange connectors · ${data.route.boundaryRoadFeatureCount.toLocaleString(
    'en-US',
  )} on boundary`;
  const focusAction = document.createElement('span');
  focusAction.className = 'focus-action';
  focusAction.textContent = 'Focus map';
  focusButton.append(name, description, focusAction);
  result.append(focusButton);

  const metrics = document.createElement('div');
  metrics.className = 'result-metrics';
  const metricValues: readonly (readonly [string, string])[] = [
    ['Contained land', formatArea(data.route.containedLandAreaSquareMeters)],
    ['Outside to coast', formatArea(data.route.outsideLandAreaSquareMeters)],
    ['Route', formatRouteLength(data.route.lengthMeters)],
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
  landmassName.textContent = data.landmass.label;
  const inside = document.createElement('span');
  inside.textContent = `${formatArea(data.route.containedLandAreaSquareMeters)} inside`;
  const outside = document.createElement('span');
  outside.textContent = `${formatArea(
    data.route.outsideLandAreaSquareMeters,
  )} outside to coast`;
  row.append(landmassName, inside, outside);
  landmasses.append(row);
  result.append(landmasses);

  const summary = document.createElement('p');
  summary.className = 'result-summary';
  summary.textContent =
    'Largest validated continental cycle expanded through explicit paired-centerline topology · mainlines plus reciprocal ramp pairs · WGS84 ellipsoidal area';
  result.append(summary);
  return result;
}

export function renderHighwayResults(): void {
  if (highwayData) {
    circumferenceResultsEl.replaceChildren(highwayResultCard(highwayData));
    return;
  }
  const loading = document.createElement('p');
  loading.className = 'result-empty';
  loading.textContent = 'Loading the North American highway network…';
  circumferenceResultsEl.replaceChildren(loading);
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
  const data = highwayData;
  if (
    !data ||
    !highwayCriterionActive() ||
    runtime.activeProduct !== 'circumference' ||
    !routeGradientToggle.checked
  ) {
    gradientRenderer.cancel(HIGHWAY_GRADIENT_SOURCE_ID);
    return;
  }
  if (!imageSource(HIGHWAY_GRADIENT_SOURCE_ID)) return;
  gradientRenderer.configure(HIGHWAY_GRADIENT_SOURCE_ID, {
    highwayUrl: new URL(HIGHWAY_GEOMETRY_URL, window.location.href).href,
  });
  const envelope = data.route.gradientBounds;
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
  map.fitBounds(highwayData.route.bounds, {
    padding: compactPanelQuery.matches ? 30 : 56,
    duration: animate ? 620 : 0,
  });
}

function renderHighwayCircumference({
  fit = false,
}: { readonly fit?: boolean } = {}): void {
  const data = highwayData;
  if (!data) return;
  syncCircumferenceCriterionControls();
  renderHighwayResults();
  circumferenceSelectionTypeEl.textContent = 'Selected highway circle';
  circumferenceNameEl.textContent = 'North America controlled-access maximum';
  circumferenceSummaryEl.textContent =
    'Largest validated simple loop in separated controlled-access mainlines connected only by paired reciprocal ramp paths.';
  replaceMetadata([
    {
      label: 'Contained land',
      value: formatArea(data.route.containedLandAreaSquareMeters),
    },
    {
      label: 'Outside to coast',
      value: formatArea(data.route.outsideLandAreaSquareMeters),
    },
    {
      label: 'Boundary length',
      value: formatRouteLength(data.route.lengthMeters),
    },
    { label: 'Countries touched', value: data.route.countries.join(', ') },
    {
      label: 'Proof graph',
      value: `${data.methodology.compressedNodeCount.toLocaleString(
        'en-US',
      )} junctions · ${data.methodology.compressedEdgeCount.toLocaleString(
        'en-US',
      )} corridors`,
    },
    {
      label: 'Ramp pairing',
      value: `${data.methodology.interchangeConnectorCount.toLocaleString(
        'en-US',
      )} pairs from ${data.methodology.directionalRampPathCount.toLocaleString(
        'en-US',
      )} directed paths · ${data.methodology.unpairedRampPathCount.toLocaleString(
        'en-US',
      )} unmatched omitted`,
    },
    { label: 'Source', value: `${data.source} v${data.source_version}` },
    {
      label: 'Precision geometry',
      value: `${data.precision_source} · ${data.precision_source_license}`,
    },
  ]);
  routeChoiceSummaryEl.textContent =
    'Automatic continental winner, refined onto explicit OSM-derived centerlines for paired carriageways and paired reciprocal ramps; route segments remain manually overridable in the data build.';
  routeChoiceSelect.disabled = true;
  routeAutoButton.disabled = true;
  routeRequireSegmentButton.disabled = true;
  routeAvoidSegmentButton.disabled = true;
  routeClearSegmentsButton.disabled = true;
  positionHighwayGradient();
  syncHighwayLayerVisibility();
  if (fit && runtime.activeProduct === 'circumference') {
    fitHighwayCircumference();
  }
  updateStatus('Highway route ready');
}

export function showHighwayFeature(properties: HighwayFeatureProperties): void {
  const data = highwayData;
  if (!data) return;
  const boundary = properties.id === data.route.id;
  const connector = properties.role === 'connector';
  const seam = properties.role === 'source-seam';
  circumferenceSelectionTypeEl.textContent = boundary
    ? 'Selected highway boundary'
    : connector
      ? 'Selected freeway connector'
      : seam
        ? 'Selected source seam'
        : 'Selected controlled-access mainline';
  circumferenceNameEl.textContent =
    properties.name || properties.number || 'Unnamed controlled-access highway';
  circumferenceSummaryEl.textContent = boundary
    ? 'Highlighted maximum-area controlled-access highway circle'
    : [
        connector
          ? 'Closest-tangent midpoint between opposing ramps, with mainline continuation at staggered joins'
          : seam
            ? 'International source seam repair'
            : properties.type,
        properties.number,
        properties.state,
        properties.country,
      ]
        .filter(Boolean)
        .join(' · ');
  replaceMetadata([
    { label: 'Road class', value: properties.class },
    { label: 'Type', value: properties.type },
    { label: 'Route', value: properties.number || properties.name },
    { label: 'State / province', value: properties.state },
    { label: 'Country', value: properties.country },
    {
      label: 'Boundary area',
      value: formatArea(data.route.containedLandAreaSquareMeters),
    },
    { label: 'Dataset feature', value: properties.id },
  ]);
  routeRequireSegmentButton.disabled = true;
  routeAvoidSegmentButton.disabled = true;
}

async function loadHighwayCircumference(): Promise<HighwayCircumferenceSummary> {
  if (highwayData) return highwayData;
  highwayPromise ??= fetchParsed(HIGHWAY_DATA_URL, highwayCircumferenceSummarySchema);
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
    if (!highwayCriterionActive()) return;
    renderHighwayCircumference({ fit });
  } catch (error) {
    console.error(error);
    highwayPromise = null;
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
    readonly source: 'highway-circumference' | 'highway-network';
    readonly sourceLayer?: 'highways' | 'boundary';
  } | null = null;
  for (const layerId of [
    'highway-circumference-route-connector-line',
    'highway-circumference-route-line',
    'highway-circumference-network-connector-line',
    'highway-circumference-network-line',
  ]) {
    map.on('mousemove', layerId, (event) => {
      const feature = event.features?.[0];
      if (!feature || feature.id === undefined) return;
      const networkFeature = layerId.includes('-network-');
      const source: 'highway-circumference' | 'highway-network' = networkFeature
        ? 'highway-network'
        : 'highway-circumference';
      const sourceLayer = networkFeature ? 'highways' : 'boundary';
      const properties = highwayMapFeaturePropertiesSchema.safeParse(
        feature.properties,
      );
      if (!properties.success) return;
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
      showHighwayFeature(properties.data);
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
    map.on('click', layerId, (event) => {
      const properties = highwayMapFeaturePropertiesSchema.safeParse(
        event.features?.[0]?.properties,
      );
      if (properties.success) showHighwayFeature(properties.data);
    });
  }
}
