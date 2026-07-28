import type { Schedule } from '../domain.js';
import { routeIdForService } from './graph.js';
import { candidateFromNetworkPath } from './precomputed.js';
import type {
  CircumferenceCandidate,
  CircumferenceGeometryMode,
  CircumferenceModeResult,
  CircumferenceNetwork,
  CircumferenceNetworkSegment,
  CircumferenceNode,
} from './types.js';

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

type ServiceDays = Schedule['stations'][string]['d'];

export interface ActiveCircumferenceService {
  readonly lineNames: ReadonlySet<string>;
  readonly serviceKeysByStation: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Tests whether a weekly GTFS frequency profile is operating at the selected
 * local wall-clock time. The previous service day is included because GTFS
 * windows commonly encode after-midnight trips as minutes greater than 1440.
 */
export function serviceDaysActiveAt(
  serviceDays: ServiceDays,
  weekday: number,
  minuteOfDay: number,
): boolean {
  const normalizedWeekday = positiveModulo(Math.trunc(weekday), 7);
  const normalizedMinute = Math.min(1_439.99, Math.max(0, minuteOfDay));
  const previousWeekday = positiveModulo(normalizedWeekday - 1, 7);
  const scheduleChecks: readonly (readonly [number, number])[] = [
    [normalizedWeekday, normalizedMinute],
    [previousWeekday, normalizedMinute + 1_440],
  ];
  return scheduleChecks.some(([serviceWeekday, serviceMinute]) =>
    (serviceDays[serviceWeekday] ?? []).some(
      ([startMinute, endMinute]) =>
        Number(startMinute) <= serviceMinute && serviceMinute < Number(endMinute),
    ),
  );
}

/**
 * Returns the exact route-direction profiles operating at each platform at the
 * selected weekly instant. Keeping the station dimension is essential: a line
 * can run on one branch while another branch with the same public line name is
 * closed or served only overnight.
 */
export function activeCircumferenceService(
  schedules: Schedule | null,
  weekday: number,
  minuteOfDay: number,
): ActiveCircumferenceService | null {
  if (!schedules) return null;
  const activeLines = new Set<string>();
  const activeServiceKeysByStation = new Map<string, Set<string>>();
  const fallbackRouteIdsByStation = new Map<string, Set<string>>();

  for (const [stationId, station] of Object.entries(schedules.stations)) {
    if (station.p) {
      for (const [serviceKey, serviceDays] of Object.entries(station.p)) {
        if (!serviceDaysActiveAt(serviceDays, weekday, minuteOfDay)) continue;
        const routeId = routeIdForService(serviceKey);
        const route = schedules.routes[routeId];
        if (route?.mode !== 'subway') continue;
        activeLines.add(route.name || routeId);
        const stationServices =
          activeServiceKeysByStation.get(stationId) ?? new Set<string>();
        stationServices.add(serviceKey);
        activeServiceKeysByStation.set(stationId, stationServices);
      }
    } else if (serviceDaysActiveAt(station.d, weekday, minuteOfDay)) {
      const fallbackRouteIds = new Set<string>();
      for (const routeId of station.r) {
        const route = schedules.routes[routeId];
        if (route?.mode !== 'subway') continue;
        activeLines.add(route.name || routeId);
        fallbackRouteIds.add(routeId);
      }
      fallbackRouteIdsByStation.set(stationId, fallbackRouteIds);
    }
  }

  // Older schedule files may lack per-service profiles. In that fallback,
  // activate every direction key for a route at the station rather than
  // inventing a single "/0" direction.
  for (const [stationId, routeIds] of fallbackRouteIdsByStation) {
    const stationServices =
      activeServiceKeysByStation.get(stationId) ?? new Set<string>();
    for (const [, , serviceKey] of schedules.graph.e[stationId] ?? []) {
      if (routeIds.has(routeIdForService(serviceKey))) {
        stationServices.add(serviceKey);
      }
    }
    activeServiceKeysByStation.set(stationId, stationServices);
  }

  return {
    lineNames: activeLines,
    serviceKeysByStation: activeServiceKeysByStation,
  };
}

export function activeCircumferenceLines(
  schedules: Schedule | null,
  weekday: number,
  minuteOfDay: number,
): Set<string> | null {
  const service = activeCircumferenceService(schedules, weekday, minuteOfDay);
  return service ? new Set(service.lineNames) : null;
}

function filteredNode(
  node: CircumferenceNode,
  activeLines: ReadonlySet<string>,
): CircumferenceNode {
  const lineNames = node.lineNames.filter((lineName) => activeLines.has(lineName));
  return {
    ...node,
    label: lineNames.length ? `${node.name} · ${lineNames.join('/')}` : node.name,
    lineNames,
  };
}

function activeSegmentLines(
  segment: CircumferenceNetworkSegment,
  activeService: ActiveCircumferenceService,
): string[] {
  return segment.lines.filter((lineName) => {
    const serviceEdges = segment.lineServiceEdges?.[lineName];
    if (!serviceEdges?.length) return activeService.lineNames.has(lineName);
    return serviceEdges.some(([serviceKey, fromId, toId]) => {
      const fromServices = activeService.serviceKeysByStation.get(fromId);
      const toServices = activeService.serviceKeysByStation.get(toId);
      return (
        fromServices?.has(serviceKey) === true && toServices?.has(serviceKey) === true
      );
    });
  });
}

/**
 * Removes inactive route-pattern appearances from each shared track segment,
 * then removes track and transfer segments whose endpoint platforms are no
 * longer served. Express stop-to-stop service edges are normalized over their
 * physical local-station chain when the network is built, so an express line
 * remains visible between its stops without falsely serving intermediate
 * platforms.
 */
export function filterCircumferenceNetwork(
  network: CircumferenceNetwork,
  activeService: ActiveCircumferenceService | null,
): CircumferenceNetwork {
  if (activeService === null) return network;

  const activeRideSegments = network.segments.flatMap((segment) => {
    if (segment.type !== 'ride') return [];
    const lines = activeSegmentLines(segment, activeService);
    return lines.length > 0 ? [{ segment, lines }] : [];
  });
  const activeLinesByNode = new Map<string, Set<string>>();
  for (const { segment, lines } of activeRideSegments) {
    for (const nodeId of [segment.from.id, segment.to.id]) {
      const nodeLines = activeLinesByNode.get(nodeId) ?? new Set<string>();
      for (const lineName of lines) nodeLines.add(lineName);
      activeLinesByNode.set(nodeId, nodeLines);
    }
  }
  const servedNodeIds = new Set(
    activeRideSegments.flatMap(({ segment }) => [segment.from.id, segment.to.id]),
  );
  const nodeById = new Map<string, CircumferenceNode>();
  for (const station of network.stations) {
    if (!servedNodeIds.has(station.id)) continue;
    const node = filteredNode(station, activeLinesByNode.get(station.id) ?? new Set());
    nodeById.set(node.id, node);
  }

  const segments: CircumferenceNetworkSegment[] = activeRideSegments.map(
    ({ segment, lines }) => ({
      ...segment,
      from:
        nodeById.get(segment.from.id) ??
        filteredNode(segment.from, activeLinesByNode.get(segment.from.id) ?? new Set()),
      to:
        nodeById.get(segment.to.id) ??
        filteredNode(segment.to, activeLinesByNode.get(segment.to.id) ?? new Set()),
      lines,
    }),
  );
  for (const segment of network.segments) {
    if (
      segment.type !== 'transfer' ||
      !servedNodeIds.has(segment.from.id) ||
      !servedNodeIds.has(segment.to.id)
    ) {
      continue;
    }
    segments.push({
      ...segment,
      from:
        nodeById.get(segment.from.id) ??
        filteredNode(segment.from, activeLinesByNode.get(segment.from.id) ?? new Set()),
      to:
        nodeById.get(segment.to.id) ??
        filteredNode(segment.to, activeLinesByNode.get(segment.to.id) ?? new Set()),
      lines: [...segment.lines],
    });
  }

  return {
    stations: [...nodeById.values()],
    segments,
  };
}

function networkPathExists(
  network: CircumferenceNetwork,
  path: readonly string[],
): boolean {
  const edgeKeys = new Set(
    network.segments.map((segment) =>
      [segment.from.id, segment.to.id].sort().join('\u0000'),
    ),
  );
  return path.every((fromId, index) => {
    const toId = path[(index + 1) % path.length];
    return toId !== undefined && edgeKeys.has([fromId, toId].sort().join('\u0000'));
  });
}

export function scheduleLineStateKey(
  network: CircumferenceNetwork,
  activeService: ActiveCircumferenceService | null,
): string {
  if (activeService === null) return 'all';
  return network.segments
    .flatMap((segment) =>
      segment.type === 'ride'
        ? activeSegmentLines(segment, activeService).map(
            (lineName) => `${segment.id}\u0001${lineName}`,
          )
        : [],
    )
    .sort()
    .join('\u0000');
}

/**
 * Rebuilds every still-valid precomputed route against the filtered network.
 * This updates shared-segment line choices and all geodesic length/area values
 * without running a combinatorial route search in the browser.
 */
export function scheduleCircumferenceMode(
  result: CircumferenceModeResult,
  activeService: ActiveCircumferenceService | null,
  geometryMode: CircumferenceGeometryMode,
): CircumferenceModeResult {
  const network = filterCircumferenceNetwork(result.network, activeService);
  const rebuildCandidates = (
    candidates: readonly CircumferenceCandidate[],
  ): CircumferenceCandidate[] =>
    candidates
      .filter((candidate) => networkPathExists(network, candidate.nodeIds))
      .map((candidate) =>
        candidateFromNetworkPath(network, candidate.nodeIds, {
          useTrackGeometry: geometryMode === 'track',
        }),
      );
  const validCandidates = rebuildCandidates(result.candidates);
  const validScheduleCandidates = rebuildCandidates(
    result.scheduleCandidates?.length ? result.scheduleCandidates : result.candidates,
  );
  const winner = validScheduleCandidates[0] ?? validCandidates[0];
  const alternatives = validCandidates
    .filter((candidate) => candidate.id !== winner?.id)
    .sort((first, second) => second.areaSquareMeters - first.areaSquareMeters);
  const candidates = winner === undefined ? [] : [winner, ...alternatives];

  return {
    candidates,
    methodology: result.methodology,
    network,
    scheduleCandidates: validScheduleCandidates,
  };
}
