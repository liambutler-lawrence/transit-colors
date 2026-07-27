import {
  attachScheduleGraph,
  buildTransitGraph,
  calculateTransitTimes,
  scheduledWaitForService,
  scheduledWaitForStation,
  timeScaleStops,
} from '../routing.js';
import type { AccessTravel, RideLeg, WaitLeg, WaitResult } from '../routing/types.js';
import type { Schedule, StationProperties, StreetProperties } from '../domain.js';
import type { MetadataDetail, SegmentProperties } from './types.js';
import {
  renderCircumferenceCandidate,
  replaceMetadata,
  selectedCircumferenceCandidate,
  storeCircumferenceOverride,
} from './circumference-ui.js';
import {
  selectedStreetTravelTime,
  setLegend,
  syncStreetColor,
  updateViewportStatistics,
} from './access-controls.js';
import {
  AREAS,
  FUTURE_MODE_DISTANCE_PROPERTIES,
  MODE_DISTANCE_PROPERTIES,
  MODE_LABELS,
  activeStationModes,
  allStationModes,
  circumferenceMetadataEl,
  circumferenceNameEl,
  circumferenceState,
  circumferenceStates,
  circumferenceSummaryEl,
  departureLabel,
  destinationSelect,
  destinationSummaryEl,
  featureMetadataEl,
  featureNameEl,
  featureSummaryEl,
  formatArea,
  formatDistance,
  formatInteger,
  formatMinutes,
  formatTimeInput,
  futureStationModes,
  futureStationToggle,
  map,
  routeAutoButton,
  routeAvoidSegmentButton,
  routeBreakdownEl,
  routeChoiceSelect,
  routeChoiceSummaryEl,
  routeClearSegmentsButton,
  routeRequireSegmentButton,
  runtime,
  scheduleDaySelect,
  scheduleSummaryEl,
  scheduleTimeInput,
  selectionTypeEl,
  state,
  timeScaleInput,
  timeScaleSummaryEl,
  updateStatus,
} from './context.js';

export function renderDetails(details: readonly MetadataDetail[]): void {
  routeBreakdownEl.replaceChildren();
  routeBreakdownEl.hidden = true;
  replaceMetadata(featureMetadataEl, details);
}

export function routeStationName(stationId: string): string {
  return state.stationById.get(stationId)?.properties?.name || 'Station';
}

export function routeMetadata(
  serviceKey: string | null,
): Schedule['routes'][string] | null {
  if (!serviceKey) return null;
  const routeId = String(serviceKey).replace(/\/[^/]+$/, '');
  return state.schedules?.routes?.[routeId] ?? null;
}

export function routeLegLabel(leg: RideLeg): string {
  const route = routeMetadata(leg.serviceKey);
  const mode = route?.mode ?? leg.mode;
  const modeLabel = mode === undefined ? 'Transit' : MODE_LABELS[mode];
  return route?.name ? `${modeLabel} ${route.name}` : modeLabel;
}

export function transferDetail(
  leg: Readonly<{ fromStationId: string; toStationId: string }>,
): string {
  const fromName = routeStationName(leg.fromStationId);
  const toName = routeStationName(leg.toStationId);
  return fromName === toName ? `At ${toName}` : `${fromName} → ${toName}`;
}

export interface RouteTableRow {
  detail: string;
  label: string;
  minutes: number;
}

export interface MutableTransferRow extends RouteTableRow {
  fromStationId: string;
  toStationId: string;
}

export function routeTableRows(travel: AccessTravel): RouteTableRow[] | null {
  const transitLegs = state.transitTimes?.routeFromStation?.(travel.stationId);
  if (!Array.isArray(transitLegs)) return null;

  const rows: RouteTableRow[] = [
    {
      label: 'Walk',
      detail: `To ${routeStationName(travel.stationId)} · ${formatDistance(
        travel.distanceMeters,
      )}`,
      minutes: travel.walkingMinutes,
    },
  ];
  let pendingWait: WaitLeg | null = null;
  let previousRideKey: string | null = null;
  let latestTransfer: MutableTransferRow | null = null;

  for (const leg of transitLegs) {
    if (leg.type === 'wait') {
      pendingWait = leg;
      continue;
    }

    if (leg.type === 'transfer') {
      if (latestTransfer) {
        latestTransfer.toStationId = leg.toStationId;
        latestTransfer.minutes += leg.minutes;
        latestTransfer.detail = transferDetail(latestTransfer);
        continue;
      }

      const row: MutableTransferRow = {
        label: 'Transfer',
        detail: transferDetail(leg),
        minutes: leg.minutes,
        fromStationId: leg.fromStationId,
        toStationId: leg.toStationId,
      };
      rows.push(row);
      latestTransfer = row;
      continue;
    }

    if (leg.type !== 'ride') continue;

    const label = routeLegLabel(leg);
    const rideKey = leg.serviceKey ?? `mode:${leg.mode ?? 'transit'}`;
    const changedService = previousRideKey !== null && rideKey !== previousRideKey;
    let boardingWait = 0;

    if (latestTransfer) {
      if (changedService) latestTransfer.detail += ` · to ${label}`;
      if (pendingWait) {
        latestTransfer.minutes += pendingWait.minutes;
        latestTransfer.detail += ` · ${formatMinutes(pendingWait.minutes)} wait`;
      }
    } else if (changedService) {
      rows.push({
        label: 'Transfer',
        detail: `At ${routeStationName(leg.fromStationId)} · to ${label}`,
        minutes: pendingWait?.minutes ?? 0,
      });
    } else {
      boardingWait = pendingWait?.minutes ?? 0;
    }

    const detail = `${routeStationName(leg.fromStationId)} → ${routeStationName(
      leg.toStationId,
    )}`;
    rows.push({
      label,
      detail:
        boardingWait > 0 ? `${detail} · ${formatMinutes(boardingWait)} wait` : detail,
      minutes: leg.minutes + boardingWait,
    });
    pendingWait = null;
    previousRideKey = rideKey;
    latestTransfer = null;
  }

  if (pendingWait) {
    rows.push({
      label: 'Wait',
      detail: `At ${routeStationName(pendingWait.stationId)}`,
      minutes: pendingWait.minutes,
    });
  }

  return rows;
}

export function renderRouteBreakdown(travel: AccessTravel): void {
  const rows = routeTableRows(travel);
  if (!rows) return;

  const heading = document.createElement('div');
  heading.className = 'route-breakdown-heading';
  heading.textContent = 'Route breakdown';

  const table = document.createElement('table');
  table.setAttribute('aria-label', 'Concise route breakdown');
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const label of ['Leg', 'Route', 'Time']) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = label;
    headRow.append(cell);
  }
  head.append(headRow);

  const body = document.createElement('tbody');
  rows.forEach((row, index) => {
    const tableRow = document.createElement('tr');
    const labelCell = document.createElement('th');
    labelCell.scope = 'row';

    const stepNumber = document.createElement('span');
    stepNumber.className = 'route-step-number';
    stepNumber.textContent = String(index + 1);
    const stepLabel = document.createElement('span');
    stepLabel.textContent = row.label;
    labelCell.append(stepNumber, stepLabel);

    const detailCell = document.createElement('td');
    detailCell.textContent = row.detail;
    const timeCell = document.createElement('td');
    timeCell.textContent = formatMinutes(row.minutes);
    tableRow.append(labelCell, detailCell, timeCell);
    body.append(tableRow);
  });

  table.append(head, body);
  routeBreakdownEl.replaceChildren(heading, table);
  routeBreakdownEl.hidden = false;
}

export function showStreetFeature(props: StreetProperties): void {
  const streetName = props.n || props.h || 'Unnamed street';
  runtime.selectedStreetProperties = props;
  selectionTypeEl.textContent = 'Selected street';
  featureNameEl.textContent = streetName;

  if (state.destination && state.transitTimes) {
    const travel = selectedStreetTravelTime(props);
    if (!travel) {
      featureSummaryEl.textContent = 'No station types selected';
      renderDetails([{ label: 'OSM highway', value: props.h }]);
      return;
    }

    const accessStation = state.stationById.get(travel.stationId)?.properties;
    featureSummaryEl.textContent = `${formatMinutes(travel.totalMinutes)} estimated to ${
      state.destination.properties.name
    }`;
    renderDetails([
      { label: 'Access station', value: accessStation?.name },
      { label: 'Departure', value: departureLabel() },
      { label: 'OSM highway', value: props.h },
    ]);
    renderRouteBreakdown(travel);
    return;
  }

  if (activeStationModes.size === 0) {
    featureSummaryEl.textContent = 'No station types selected';
  } else {
    let distance = Number.POSITIVE_INFINITY;

    if (AREAS[runtime.activeAreaKey].liveRoads) {
      distance = Number(props.d);
    } else if (activeStationModes.size === allStationModes.size) {
      distance = Number(props.d);
    } else {
      for (const mode of activeStationModes) {
        const value = Number(props[MODE_DISTANCE_PROPERTIES[mode]]);
        if (Number.isFinite(value)) distance = Math.min(distance, value);
      }
    }

    if (futureStationToggle.checked) {
      for (const mode of activeStationModes) {
        if (!futureStationModes.has(mode)) continue;
        const value = Number(props[FUTURE_MODE_DISTANCE_PROPERTIES[mode]]);
        if (Number.isFinite(value)) distance = Math.min(distance, value);
      }
    }

    const distanceLabel =
      !Number.isFinite(distance) || distance > runtime.maxDistanceMeters
        ? `More than ${formatDistance(runtime.maxDistanceMeters)}`
        : formatDistance(distance);
    featureSummaryEl.textContent = `${distanceLabel} from nearest selected station`;
  }

  renderDetails([
    { label: 'OSM highway', value: props.h },
    { label: 'Road class', value: props['class'] },
  ]);
}

export function showStationFeature(props: StationProperties): void {
  runtime.selectedStreetProperties = null;
  selectionTypeEl.textContent = 'Selected station';
  featureNameEl.textContent = props.name || 'Unnamed station';
  featureSummaryEl.textContent =
    props.system || MODE_LABELS[props.mode] || 'Transit station';
  renderDetails([
    { label: 'Status', value: props.status_detail || props.status },
    { label: 'Mode', value: props.system || MODE_LABELS[props.mode] },
    { label: 'Network', value: props.network },
    { label: 'Operator', value: props.operator },
    { label: 'Ref', value: props.local_ref || props.route_ref || props.ref },
    { label: 'Route', value: props.route_name || props['route_relation'] },
    { label: 'Stop tag', value: props['highway'] || props['public_transport'] },
    { label: 'Opening', value: props.opening_date },
    { label: props.id?.startsWith('gtfs/') ? 'GTFS' : 'OSM', value: props.id },
  ]);
}

export function updateDestinationSummary(): void {
  if (!state.destination) return;
  destinationSummaryEl.textContent = `Color shows access walk + schedule-adjusted transit to ${
    state.destination.properties.name
  }, departing ${departureLabel()}.`;
}

export function rebuildDestinationTransitGraph(): void {
  if (!AREAS[runtime.activeAreaKey].supportsDestination) return;
  const baseGraph = buildTransitGraph(runtime.loadedStations.features, {
    includeFuture: futureStationToggle.checked,
  });
  state.transitGraph = state.schedules?.graph?.e
    ? attachScheduleGraph(baseGraph, state.schedules)
    : baseGraph;
  applyScheduleContext();
}

export function applyScheduleContext(): void {
  if (!state.transitGraph) return;

  const waitMinutesByStation = new Map<string, number>();
  const waitMinutesByService = new Map<string, number>();
  const waitDetailsByStation = new Map<string, WaitResult>();
  const waitDetailsByService = new Map<string, WaitResult>();
  let scheduledStationCount = 0;

  for (const node of state.transitGraph.nodes) {
    const details = scheduledWaitForStation(
      state.schedules,
      node.id,
      state.scheduleWeekday,
      state.scheduleMinute,
    );
    waitMinutesByStation.set(node.id, details.minutes);
    waitDetailsByStation.set(node.id, details);
    if (details.scheduled) scheduledStationCount += 1;

    for (const serviceKey of state.transitGraph.scheduleGraph?.servicesByStation.get(
      node.id,
    ) ?? []) {
      const serviceDetails = scheduledWaitForService(
        state.schedules,
        node.id,
        serviceKey,
        state.scheduleWeekday,
        state.scheduleMinute,
      );
      const stateKey = `${node.id}\u0000${serviceKey}`;
      waitMinutesByService.set(stateKey, serviceDetails.minutes);
      waitDetailsByService.set(stateKey, serviceDetails);
    }
  }

  state.waitMinutesByStation = waitMinutesByStation;
  state.waitMinutesByService = waitMinutesByService;
  state.waitDetailsByStation = waitDetailsByStation;
  state.waitDetailsByService = waitDetailsByService;
  scheduleSummaryEl.textContent = state.schedules
    ? `${state.schedules.source || 'Published GTFS'} weekly service covers ${formatInteger(
        scheduledStationCount,
      )} of ${formatInteger(
        state.transitGraph.nodes.length,
      )} active station records; the rest use a 4 min estimate.`
    : 'Schedule data unavailable; boarding waits use a 4 min estimate.';

  if (state.destination) {
    state.transitTimes = calculateTransitTimes(
      state.transitGraph,
      state.destinationStationIds,
      {
        waitMinutesByStation: state.waitMinutesByStation,
        waitMinutesByService: state.waitMinutesByService,
      },
    );
    updateDestinationSummary();
    applyTimeScale();
  }
}

export function updateScheduleContext(): void {
  const parsedDay = Number(scheduleDaySelect.value);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(scheduleTimeInput.value);
  if (Number.isInteger(parsedDay) && parsedDay >= 0 && parsedDay <= 6) {
    state.scheduleWeekday = parsedDay;
  }
  if (timeMatch) {
    state.scheduleMinute = Number(timeMatch[1]) * 60 + Number(timeMatch[2]);
  } else {
    scheduleTimeInput.value = formatTimeInput(state.scheduleMinute);
  }
  applyScheduleContext();
}

export function applyTimeScale(): void {
  const stops = timeScaleStops(state.timeScaleMinutes);
  state.timeScaleMinutes = stops.yellowMinutes;
  timeScaleInput.value = String(stops.yellowMinutes);
  timeScaleSummaryEl.textContent = `Yellow at ${stops.yellowMinutes} min, orange at ${
    stops.orangeMinutes
  } min, and red at ${stops.redMinutes} min.`;

  if (!state.destination || !state.transitTimes) return;

  setLegend('time');
  syncStreetColor();
  updateViewportStatistics();
}

export function updateTimeScale(value: number | string): void {
  if (String(value).trim() === '') {
    timeScaleInput.value = String(state.timeScaleMinutes);
    return;
  }
  state.timeScaleMinutes = timeScaleStops(value).yellowMinutes;
  applyTimeScale();
}

export function clearDestination(): void {
  state.destination = null;
  state.destinationStationIds = [];
  state.transitTimes = null;
  destinationSelect.value = '';
  destinationSummaryEl.textContent =
    'Choose a station here or click an open station on the map.';
  setLegend('distance');
  syncStreetColor();
  updateViewportStatistics();
  if (map.getLayer('station-destination')) {
    map.setFilter('station-destination', ['==', ['get', 'id'], '']);
  }
  updateStatus('Ready');
}

export function selectDestination(stationId: string): void {
  if (!stationId) {
    clearDestination();
    return;
  }

  if (!AREAS[runtime.activeAreaKey].supportsDestination || !state.transitGraph) return;

  const destinationId = state.destinationChoiceByStationId.get(stationId) ?? stationId;
  const destination = state.stationById.get(destinationId);
  if (!destination || destination.properties.status !== 'open') return;
  const destinationStationIds = state.destinationIdsByChoice.get(destinationId) ?? [
    destinationId,
  ];

  updateStatus('Calculating');
  const transitTimes = calculateTransitTimes(
    state.transitGraph,
    destinationStationIds,
    {
      waitMinutesByStation: state.waitMinutesByStation,
      waitMinutesByService: state.waitMinutesByService,
    },
  );
  state.destination = destination;
  state.destinationStationIds = destinationStationIds;
  state.transitTimes = transitTimes;
  destinationSelect.value = destinationId;
  updateDestinationSummary();
  applyTimeScale();
  map.setFilter('station-destination', [
    'in',
    ['get', 'id'],
    ['literal', destinationStationIds],
  ]);
  updateStatus('Destination set');
}

export function showCircumferenceSegment(properties: SegmentProperties): void {
  const routeState = circumferenceStates[properties.area_key];
  if (!routeState.selected) return;
  const isTransfer = properties.segment_type === 'transfer';
  const isFocusedArea = properties.area_key === runtime.activeAreaKey;
  circumferenceState.inspectedSegmentId = isFocusedArea
    ? properties.segment_id || ''
    : '';
  routeRequireSegmentButton.disabled =
    !isFocusedArea ||
    !circumferenceState.inspectedSegmentId ||
    circumferenceState.requiredSegmentIds.has(circumferenceState.inspectedSegmentId);
  routeAvoidSegmentButton.disabled =
    !isFocusedArea ||
    !circumferenceState.inspectedSegmentId ||
    circumferenceState.avoidedSegmentIds.has(circumferenceState.inspectedSegmentId);
  circumferenceNameEl.textContent = isTransfer
    ? `${properties.from_label} ⇢ ${properties.to_label}`
    : `${properties.from} → ${properties.to}`;
  circumferenceSummaryEl.textContent = isTransfer
    ? `${formatDistance(properties.distance_m)} platform-to-platform walk`
    : `Metro line${properties.lines.includes(',') ? 's' : ''} ${properties.lines}`;
  replaceMetadata(circumferenceMetadataEl, [
    {
      label: isTransfer ? 'Platforms' : 'Segment',
      value: isTransfer
        ? `${properties.from_label} to ${properties.to_label}`
        : `${properties.from} to ${properties.to}`,
    },
    {
      label: isTransfer ? 'Connection' : 'Lines',
      value: isTransfer
        ? `${
            properties.transfer_source === 'published' ? 'Published' : 'Inferred'
          } walking link${
            properties.transfer_minutes ? ` · ${properties.transfer_minutes} min` : ''
          }`
        : properties.lines,
    },
    {
      label: 'Distance',
      value: formatDistance(properties.distance_m),
    },
    {
      label: 'Loop area',
      value: formatArea(routeState.selected.areaSquareMeters),
    },
    {
      label: 'Override',
      value: !isFocusedArea
        ? `Focus on ${AREAS[properties.area_key].label} to edit`
        : circumferenceState.requiredSegmentIds.has(properties.segment_id)
          ? 'Required'
          : circumferenceState.avoidedSegmentIds.has(properties.segment_id)
            ? 'Avoided'
            : 'None',
    },
  ]);
}

export function applyInspectedSegmentOverride(mode: 'avoid' | 'require'): void {
  const segmentId = circumferenceState.inspectedSegmentId;
  if (!segmentId) return;

  const previousRequired = new Set(circumferenceState.requiredSegmentIds);
  const previousAvoided = new Set(circumferenceState.avoidedSegmentIds);
  if (mode === 'require') {
    circumferenceState.requiredSegmentIds.add(segmentId);
    circumferenceState.avoidedSegmentIds.delete(segmentId);
  } else {
    circumferenceState.avoidedSegmentIds.add(segmentId);
    circumferenceState.requiredSegmentIds.delete(segmentId);
  }
  circumferenceState.overrideId = '';
  const candidate = selectedCircumferenceCandidate();

  if (!candidate) {
    circumferenceState.requiredSegmentIds = previousRequired;
    circumferenceState.avoidedSegmentIds = previousAvoided;
    routeChoiceSummaryEl.textContent =
      'No ranked simple loop satisfies that segment edit.';
    updateStatus('No matching loop', { isError: true });
    return;
  }

  storeCircumferenceOverride(runtime.activeAreaKey, '');
  routeChoiceSelect.value = '';
  routeAutoButton.disabled = false;
  routeClearSegmentsButton.disabled = false;
  renderCircumferenceCandidate(candidate, { fit: true });
  updateStatus('Route edited');
}
