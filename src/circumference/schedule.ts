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
 * Returns the published subway line names operating at the selected weekly
 * schedule instant. A line is visible when at least one of its route-direction
 * profiles is actively serving at least one platform.
 */
export function activeCircumferenceLines(
  schedules: Schedule | null,
  weekday: number,
  minuteOfDay: number,
): Set<string> | null {
  if (!schedules) return null;
  const activeLines = new Set<string>();

  for (const station of Object.values(schedules.stations)) {
    const serviceProfiles: Record<string, ServiceDays> = station.p
      ? { ...station.p }
      : {};
    if (!station.p) {
      for (const routeId of station.r) {
        serviceProfiles[`${routeId}/0`] = station.d;
      }
    }
    for (const [serviceKey, serviceDays] of Object.entries(serviceProfiles)) {
      if (!serviceDaysActiveAt(serviceDays, weekday, minuteOfDay)) continue;
      const routeId = routeIdForService(serviceKey);
      const route = schedules.routes[routeId];
      if (route?.mode !== 'subway') continue;
      activeLines.add(route.name || routeId);
    }
  }

  return activeLines;
}

function filteredNode(
  node: CircumferenceNode,
  activeLines: ReadonlySet<string> | null,
): CircumferenceNode {
  return {
    ...node,
    lineNames:
      activeLines === null
        ? [...node.lineNames]
        : node.lineNames.filter((lineName) => activeLines.has(lineName)),
  };
}

/**
 * Removes inactive line appearances from shared track segments, then removes
 * track and transfer segments whose endpoint platforms are no longer served.
 */
export function filterCircumferenceNetwork(
  network: CircumferenceNetwork,
  activeLines: ReadonlySet<string> | null,
): CircumferenceNetwork {
  if (activeLines === null) return network;

  const activeRideSegments = network.segments.flatMap((segment) => {
    if (segment.type !== 'ride') return [];
    const lines = segment.lines.filter((lineName) => activeLines.has(lineName));
    return lines.length > 0 ? [{ segment, lines }] : [];
  });
  const servedNodeIds = new Set(
    activeRideSegments.flatMap(({ segment }) => [segment.from.id, segment.to.id]),
  );
  const nodeById = new Map<string, CircumferenceNode>();
  for (const station of network.stations) {
    if (!servedNodeIds.has(station.id)) continue;
    const node = filteredNode(station, activeLines);
    nodeById.set(node.id, node);
  }

  const segments: CircumferenceNetworkSegment[] = activeRideSegments.map(
    ({ segment, lines }) => ({
      ...segment,
      from: nodeById.get(segment.from.id) ?? filteredNode(segment.from, activeLines),
      to: nodeById.get(segment.to.id) ?? filteredNode(segment.to, activeLines),
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
      from: nodeById.get(segment.from.id) ?? filteredNode(segment.from, activeLines),
      to: nodeById.get(segment.to.id) ?? filteredNode(segment.to, activeLines),
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
  activeLines: ReadonlySet<string> | null,
): string {
  if (activeLines === null) return 'all';
  return [
    ...new Set(
      network.segments.flatMap((segment) =>
        segment.type === 'ride'
          ? segment.lines.filter((lineName) => activeLines.has(lineName))
          : [],
      ),
    ),
  ]
    .sort((first, second) =>
      first.localeCompare(second, 'en', { numeric: true, sensitivity: 'base' }),
    )
    .join('\u0000');
}

/**
 * Rebuilds every still-valid precomputed route against the filtered network.
 * This updates shared-segment line choices and all geodesic length/area values
 * without running a combinatorial route search in the browser.
 */
export function scheduleCircumferenceMode(
  result: CircumferenceModeResult,
  activeLines: ReadonlySet<string> | null,
  geometryMode: CircumferenceGeometryMode,
): CircumferenceModeResult {
  const network = filterCircumferenceNetwork(result.network, activeLines);
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
