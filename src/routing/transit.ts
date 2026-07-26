import type {
  Mode,
  Schedule,
  StationFeature,
  StationProperties,
  StreetProperties,
} from '../domain.js';
import {
  DEFAULT_ESTIMATED_WAIT_MINUTES,
  DEFAULT_TRANSFER_MINUTES,
  MODE_MAX_LINK_M,
  MODE_SPEED_KMH,
  WALKING_METERS_PER_MINUTE,
  distanceMeters,
  normalize,
} from './access.js';
import type {
  AccessCandidate,
  AccessTravel,
  RouteLeg,
  StreetTravel,
  TransitGraph,
  TransitTimeOptions,
  TransitTimes,
} from './types.js';

function routeGroups(properties: StationProperties): Set<string> {
  const groups = new Set<string>();
  const values = [properties.route_ref, properties.route_name];
  const normalizedNetwork = normalize(properties.network);

  if (
    normalizedNetwork &&
    !/^(metrobus|stc metro|metro cdmx|mexibus|cablebus)$/.test(normalizedNetwork)
  ) {
    values.push(properties.network);
  }

  for (const value of values) {
    for (const part of String(value ?? '').split(';')) {
      const normalizedPart = normalize(part);
      if (normalizedPart) groups.add(normalizedPart);
    }
  }

  return groups;
}

function groupsOverlap(
  first: ReadonlySet<string>,
  second: ReadonlySet<string>,
): boolean {
  for (const group of first) {
    if (second.has(group)) return true;
  }
  return false;
}

function rideMinutes(mode: Mode, meters: number): number {
  const speedKmh = MODE_SPEED_KMH[mode];
  return meters / ((speedKmh * 1_000) / 60) + 0.55;
}

function addUndirectedEdge(
  adjacency: Map<string, Map<string, number>>,
  from: string,
  to: string,
  minutes: number,
): void {
  const addOneWay = (start: string, end: string): void => {
    const edges = adjacency.get(start);
    if (!edges) return;
    const existing = edges.get(end);
    if (existing === undefined || minutes < existing) {
      edges.set(end, minutes);
    }
  };

  addOneWay(from, to);
  addOneWay(to, from);
}

/**
 * Builds a lightweight transit graph from station mode, route metadata, and
 * geography. Ride times are estimates because the source does not contain a
 * published timetable.
 */
export function buildTransitGraph(
  stationFeatures: readonly StationFeature[],
  { includeFuture = false }: { readonly includeFuture?: boolean } = {},
): TransitGraph {
  const nodes = stationFeatures
    .filter((feature) => feature.properties.status === 'open' || includeFuture)
    .map((feature) => ({
      id: feature.properties.id,
      name: feature.properties.name,
      normalizedName: normalize(feature.properties.name),
      mode: feature.properties.mode,
      coordinates: feature.geometry.coordinates,
      groups: routeGroups(feature.properties),
    }));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const adjacency = new Map<string, Map<string, number>>(
    nodes.map((node) => [node.id, new Map<string, number>()]),
  );
  const rideCandidates = new Map<string, { id: string; meters: number }[]>(
    nodes.map((node) => [node.id, []]),
  );

  for (let firstIndex = 0; firstIndex < nodes.length; firstIndex += 1) {
    const first = nodes[firstIndex];
    if (!first) continue;

    for (
      let secondIndex = firstIndex + 1;
      secondIndex < nodes.length;
      secondIndex += 1
    ) {
      const second = nodes[secondIndex];
      if (!second) continue;
      const meters = distanceMeters(first.coordinates, second.coordinates);
      const sameNamedPlace =
        first.normalizedName.length > 0 &&
        first.normalizedName === second.normalizedName &&
        meters <= 900;

      if (sameNamedPlace) {
        addUndirectedEdge(
          adjacency,
          first.id,
          second.id,
          Math.max(0.35, meters / WALKING_METERS_PER_MINUTE),
        );
      } else if (meters <= 300) {
        addUndirectedEdge(
          adjacency,
          first.id,
          second.id,
          DEFAULT_TRANSFER_MINUTES + meters / WALKING_METERS_PER_MINUTE,
        );
      }

      if (first.mode !== second.mode) continue;
      const maxLink = MODE_MAX_LINK_M[first.mode] ?? 3_000;
      if (meters > maxLink) continue;

      const bothHaveGroups = first.groups.size > 0 && second.groups.size > 0;
      if (bothHaveGroups && !groupsOverlap(first.groups, second.groups)) continue;

      rideCandidates.get(first.id)?.push({ id: second.id, meters });
      rideCandidates.get(second.id)?.push({ id: first.id, meters });
    }
  }

  for (const node of nodes) {
    let candidates = (rideCandidates.get(node.id) ?? [])
      // Co-located OSM station/platform records are already joined as a
      // transfer. Do not let those duplicates consume every onward ride link.
      .filter((candidate) => candidate.meters > 300);

    // Some OSM station points lack route membership. Connect those points to
    // nearby stations of the same mode so they still participate in routing.
    if (candidates.length === 0) {
      const maxLink = MODE_MAX_LINK_M[node.mode] ?? 3_000;
      candidates = nodes
        .filter((candidate) => candidate.id !== node.id && candidate.mode === node.mode)
        .map((candidate) => ({
          id: candidate.id,
          meters: distanceMeters(node.coordinates, candidate.coordinates),
        }))
        .filter((candidate) => candidate.meters > 300 && candidate.meters <= maxLink);
    }

    candidates
      .sort((first, second) => first.meters - second.meters)
      .slice(0, 3)
      .forEach((candidate) => {
        addUndirectedEdge(
          adjacency,
          node.id,
          candidate.id,
          rideMinutes(node.mode, candidate.meters),
        );
      });
  }

  return { nodes, nodeById, adjacency };
}

function routeStateKey(stationId: string, serviceKey: string): string {
  return `${stationId}\u0000${serviceKey}`;
}

function addReverseTransfer(
  reverseTransfers: Map<string, Map<string, number>>,
  from: string,
  to: string,
  minutes: number,
): void {
  const transfers = reverseTransfers.get(to) ?? new Map<string, number>();
  reverseTransfers.set(to, transfers);
  const existing = transfers.get(from);
  if (existing === undefined || minutes < existing) {
    transfers.set(from, minutes);
  }
}

/**
 * Attaches GTFS-derived ride and transfer edges to the station graph. Ride
 * edges preserve route + direction, which is required to charge a fresh wait
 * only when a passenger actually boards or changes service.
 */
export function attachScheduleGraph(
  graph: TransitGraph,
  schedules: Schedule,
): TransitGraph {
  const ridePredecessors = new Map<string, [string, number][]>();
  const servicesByStation = new Map<string, Set<string>>(
    graph.nodes.map((node) => [node.id, new Set<string>()]),
  );
  const reverseTransfers = new Map<string, Map<string, number>>(
    graph.nodes.map((node) => [node.id, new Map<string, number>()]),
  );
  const stationIds = new Set(graph.nodes.map((node) => node.id));

  for (const [fromStationId, edges] of Object.entries(schedules.graph.e)) {
    if (!stationIds.has(fromStationId)) continue;
    for (const [toStationId, minutes, serviceKey] of edges) {
      if (!stationIds.has(toStationId) || !Number.isFinite(minutes) || minutes <= 0)
        continue;
      servicesByStation.get(fromStationId)?.add(serviceKey);
      servicesByStation.get(toStationId)?.add(serviceKey);
      const destinationState = routeStateKey(toStationId, serviceKey);
      const predecessors = ridePredecessors.get(destinationState) ?? [];
      predecessors.push([fromStationId, minutes]);
      ridePredecessors.set(destinationState, predecessors);
    }
  }

  for (const [fromStationId, edges] of Object.entries(schedules.graph.t)) {
    if (!stationIds.has(fromStationId)) continue;
    for (const [toStationId, minutes] of edges) {
      if (!stationIds.has(toStationId) || !Number.isFinite(minutes) || minutes < 0) {
        continue;
      }
      addReverseTransfer(reverseTransfers, fromStationId, toStationId, minutes);
    }
  }

  // Cross-feed complexes (for example subway ↔ commuter rail) do not always
  // publish transfers in one GTFS archive. Add only plausible pedestrian
  // links here; route geometry is never inferred from proximity.
  for (let firstIndex = 0; firstIndex < graph.nodes.length; firstIndex += 1) {
    const first = graph.nodes[firstIndex];
    if (!first) continue;
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < graph.nodes.length;
      secondIndex += 1
    ) {
      const second = graph.nodes[secondIndex];
      if (!second) continue;
      const meters = distanceMeters(first.coordinates, second.coordinates);
      const sameNamedPlace =
        first.normalizedName.length > 0 &&
        first.normalizedName === second.normalizedName &&
        meters <= 900;
      if (!sameNamedPlace && meters > 250) continue;
      const minutes = sameNamedPlace
        ? Math.max(0.35, meters / WALKING_METERS_PER_MINUTE)
        : DEFAULT_TRANSFER_MINUTES + meters / WALKING_METERS_PER_MINUTE;
      addReverseTransfer(reverseTransfers, first.id, second.id, minutes);
      addReverseTransfer(reverseTransfers, second.id, first.id, minutes);
    }
  }

  return {
    ...graph,
    scheduleGraph: {
      ridePredecessors,
      reverseTransfers,
      servicesByStation,
    },
  };
}

interface HeapItem {
  readonly id: string;
  readonly kind?: 'base' | 'route';
  readonly minutes: number;
  readonly serviceKey?: string;
}

class MinHeap {
  readonly items: HeapItem[] = [];

  push(item: HeapItem): void {
    this.items.push(item);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const parentItem = this.items[parent];
      if (!parentItem || parentItem.minutes <= item.minutes) break;
      this.items[index] = parentItem;
      index = parent;
    }
    this.items[index] = item;
  }

  pop(): HeapItem | null {
    if (this.items.length === 0) return null;
    const first = this.items[0];
    const last = this.items.pop();
    if (!first || !last || this.items.length === 0) return first ?? null;

    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.items.length) break;
      const smaller =
        right < this.items.length &&
        (this.items[right]?.minutes ?? Number.POSITIVE_INFINITY) <
          (this.items[left]?.minutes ?? Number.POSITIVE_INFINITY)
          ? right
          : left;
      const smallerItem = this.items[smaller];
      if (!smallerItem || smallerItem.minutes >= last.minutes) break;
      this.items[index] = smallerItem;
      index = smaller;
    }
    this.items[index] = last;
    return first;
  }
}

class TransitTimeMap extends Map<string, number> implements TransitTimes {
  routeFromStation: (stationId: string) => RouteLeg[] | null = () => null;
  serviceByStation?: ReadonlyMap<string, string>;
}

export function calculateTransitTimes(
  graph: TransitGraph,
  destinationId: string | readonly string[],
  {
    waitMinutesByStation = new Map(),
    waitMinutesByService = new Map(),
  }: TransitTimeOptions = {},
): TransitTimes {
  const destinationIds: readonly string[] =
    typeof destinationId === 'string' ? [destinationId] : destinationId;
  const validDestinationIds = destinationIds.filter((id) => graph.nodeById.has(id));
  if (validDestinationIds.length === 0) {
    throw new Error(`Unknown destination station: ${destinationIds.join(', ')}`);
  }

  if (graph.scheduleGraph) {
    return calculateScheduledTransitTimes(
      { ...graph, scheduleGraph: graph.scheduleGraph },
      validDestinationIds,
      {
        waitMinutesByStation,
        waitMinutesByService,
      },
    );
  }

  const minutesByStation = new TransitTimeMap(
    graph.nodes.map((node) => [node.id, Number.POSITIVE_INFINITY]),
  );
  const nextStationByStation = new Map<string, string>();
  const queue = new MinHeap();
  for (const id of validDestinationIds) {
    minutesByStation.set(id, 0);
    queue.push({ id, minutes: 0 });
  }

  while (queue.items.length > 0) {
    const current = queue.pop();
    if (!current) break;
    if (current.minutes !== minutesByStation.get(current.id)) continue;

    for (const [neighborId, edgeMinutes] of graph.adjacency.get(current.id) ?? []) {
      const nextMinutes = current.minutes + edgeMinutes;
      if (
        nextMinutes >= (minutesByStation.get(neighborId) ?? Number.POSITIVE_INFINITY)
      ) {
        continue;
      }
      minutesByStation.set(neighborId, nextMinutes);
      nextStationByStation.set(neighborId, current.id);
      queue.push({ id: neighborId, minutes: nextMinutes });
    }
  }

  for (const node of graph.nodes) {
    const minutes = minutesByStation.get(node.id);
    if (Number.isFinite(minutes)) {
      if (minutes !== undefined && minutes > 0) {
        const waitMinutes =
          waitMinutesByStation.get(node.id) ?? DEFAULT_ESTIMATED_WAIT_MINUTES;
        minutesByStation.set(node.id, minutes + waitMinutes);
      }
      continue;
    }

    minutesByStation.set(node.id, 90);
  }

  minutesByStation.routeFromStation = (stationId: string): RouteLeg[] | null => {
    const transitMinutes = minutesByStation.get(stationId);
    if (
      transitMinutes === undefined ||
      !Number.isFinite(transitMinutes) ||
      transitMinutes >= 90
    ) {
      return null;
    }

    const legs: RouteLeg[] = [];
    const visited = new Set<string>();
    let currentStationId = stationId;

    while (nextStationByStation.has(currentStationId)) {
      if (visited.has(currentStationId)) return null;
      visited.add(currentStationId);

      const nextStationId = nextStationByStation.get(currentStationId);
      if (!nextStationId) return null;
      const currentNode = graph.nodeById.get(currentStationId);
      const nextNode = graph.nodeById.get(nextStationId);
      const minutes = graph.adjacency.get(currentStationId)?.get(nextStationId);
      if (
        !currentNode ||
        !nextNode ||
        minutes === undefined ||
        !Number.isFinite(minutes)
      ) {
        return null;
      }

      const meters = distanceMeters(currentNode.coordinates, nextNode.coordinates);
      const isTransfer =
        meters <= 300 ||
        (currentNode.normalizedName.length > 0 &&
          currentNode.normalizedName === nextNode.normalizedName &&
          meters <= 900);
      legs.push({
        type: isTransfer ? 'transfer' : 'ride',
        fromStationId: currentStationId,
        toStationId: nextStationId,
        mode: currentNode.mode,
        serviceKey: null,
        minutes,
      });
      currentStationId = nextStationId;
    }

    if (!validDestinationIds.includes(currentStationId)) return null;

    const waitMinutes = Math.max(
      0,
      transitMinutes - legs.reduce((sum, leg) => sum + leg.minutes, 0),
    );
    const firstRide = legs.find((leg) => leg.type === 'ride');
    if (waitMinutes > 0) {
      const insertionIndex = firstRide ? legs.indexOf(firstRide) : 0;
      legs.splice(Math.max(0, insertionIndex), 0, {
        type: 'wait',
        stationId: firstRide?.fromStationId ?? stationId,
        serviceKey: null,
        minutes: waitMinutes,
      });
    }

    return coalesceRideLegs(legs);
  };

  return minutesByStation;
}

function coalesceRideLegs(legs: readonly RouteLeg[]): RouteLeg[] {
  const coalesced: RouteLeg[] = [];

  for (const leg of legs) {
    const previous = coalesced.at(-1);
    const sameService =
      previous?.type === 'ride' &&
      leg.type === 'ride' &&
      previous.serviceKey === leg.serviceKey &&
      previous.mode === leg.mode &&
      previous.toStationId === leg.fromStationId;

    if (sameService) {
      const mergedLeg = {
        ...previous,
        minutes: previous.minutes + leg.minutes,
        toStationId: leg.toStationId,
      };
      coalesced[coalesced.length - 1] = mergedLeg;
    } else {
      coalesced.push({ ...leg });
    }
  }

  return coalesced;
}

function calculateScheduledTransitTimes(
  graph: TransitGraph & {
    readonly scheduleGraph: NonNullable<TransitGraph['scheduleGraph']>;
  },
  destinationIds: readonly string[],
  { waitMinutesByStation, waitMinutesByService }: Required<TransitTimeOptions>,
): TransitTimes {
  const { ridePredecessors, reverseTransfers, servicesByStation } = graph.scheduleGraph;
  const baseMinutes = new TransitTimeMap(
    graph.nodes.map((node) => [node.id, Number.POSITIVE_INFINITY]),
  );
  const routeMinutes = new Map<string, number>();
  const serviceByStation = new Map<string, string>();
  type BoardDecision = {
    readonly minutes: number;
    readonly serviceKey: string;
    readonly stationId: string;
    readonly type: 'board';
  };
  type TransferDecision = {
    readonly fromStationId: string;
    readonly minutes: number;
    readonly toStationId: string;
    readonly type: 'transfer';
  };
  type BaseDecision = BoardDecision | TransferDecision;
  type RideDecision = {
    readonly fromStationId: string;
    readonly minutes: number;
    readonly serviceKey: string;
    readonly toStationId: string;
    readonly type: 'ride';
  };
  type AlightDecision = {
    readonly stationId: string;
    readonly type: 'alight';
  };
  const baseDecisions = new Map<string, BaseDecision>();
  const routeDecisions = new Map<string, AlightDecision | RideDecision>();
  const queue = new MinHeap();

  const relaxBase = (
    stationId: string,
    minutes: number,
    decision: BaseDecision | null = null,
  ): void => {
    if (minutes >= (baseMinutes.get(stationId) ?? Number.POSITIVE_INFINITY)) return;
    baseMinutes.set(stationId, minutes);
    if (decision) {
      baseDecisions.set(stationId, decision);
    } else {
      baseDecisions.delete(stationId);
    }
    if (decision?.type === 'board') {
      serviceByStation.set(stationId, decision.serviceKey);
    } else {
      serviceByStation.delete(stationId);
    }
    queue.push({ id: stationId, kind: 'base', minutes });
  };
  const relaxRoute = (
    stationId: string,
    serviceKey: string,
    minutes: number,
    decision: AlightDecision | RideDecision,
  ): void => {
    const key = routeStateKey(stationId, serviceKey);
    if (minutes >= (routeMinutes.get(key) ?? Number.POSITIVE_INFINITY)) return;
    routeMinutes.set(key, minutes);
    routeDecisions.set(key, decision);
    queue.push({ id: stationId, serviceKey, kind: 'route', minutes });
  };

  for (const stationId of destinationIds) relaxBase(stationId, 0);

  while (queue.items.length > 0) {
    const current = queue.pop();
    if (!current) break;
    if (current.kind === 'base') {
      if (current.minutes !== baseMinutes.get(current.id)) continue;

      // Reverse of alighting: reaching a platform from the destination-side
      // station concourse is free.
      for (const serviceKey of servicesByStation.get(current.id) ?? []) {
        relaxRoute(current.id, serviceKey, current.minutes, {
          type: 'alight',
          stationId: current.id,
        });
      }
      for (const [fromStationId, transferMinutes] of reverseTransfers.get(current.id) ??
        []) {
        relaxBase(fromStationId, current.minutes + transferMinutes, {
          type: 'transfer',
          fromStationId,
          toStationId: current.id,
          minutes: transferMinutes,
        });
      }
      continue;
    }

    if (!current.serviceKey) continue;
    const currentKey = routeStateKey(current.id, current.serviceKey);
    if (current.minutes !== routeMinutes.get(currentKey)) continue;

    // Reverse of boarding. This is evaluated once at every actual boarding,
    // including after a transfer to another service.
    const serviceWait =
      waitMinutesByService.get(currentKey) ??
      waitMinutesByStation.get(current.id) ??
      DEFAULT_ESTIMATED_WAIT_MINUTES;
    relaxBase(current.id, current.minutes + serviceWait, {
      type: 'board',
      stationId: current.id,
      serviceKey: current.serviceKey,
      minutes: serviceWait,
    });

    for (const [fromStationId, rideMinutes] of ridePredecessors.get(currentKey) ?? []) {
      relaxRoute(fromStationId, current.serviceKey, current.minutes + rideMinutes, {
        type: 'ride',
        fromStationId,
        toStationId: current.id,
        serviceKey: current.serviceKey,
        minutes: rideMinutes,
      });
    }
  }

  for (const [stationId, minutes] of baseMinutes) {
    if (!Number.isFinite(minutes)) baseMinutes.set(stationId, 90);
  }
  baseMinutes.serviceByStation = serviceByStation;
  baseMinutes.routeFromStation = (stationId: string): RouteLeg[] | null => {
    const stationMinutes = baseMinutes.get(stationId);
    if (
      stationMinutes === undefined ||
      !Number.isFinite(stationMinutes) ||
      stationMinutes >= 90
    ) {
      return null;
    }

    const legs: RouteLeg[] = [];
    const visited = new Set<string>();
    type RouteState =
      | { readonly kind: 'base'; readonly stationId: string }
      | {
          readonly kind: 'route';
          readonly serviceKey: string;
          readonly stationId: string;
        };
    let current: RouteState = { kind: 'base', stationId };

    while (true) {
      const stateKey =
        current.kind === 'base'
          ? `base\u0000${current.stationId}`
          : `route\u0000${current.stationId}\u0000${current.serviceKey}`;
      if (visited.has(stateKey)) return null;
      visited.add(stateKey);

      if (current.kind === 'base') {
        const decision = baseDecisions.get(current.stationId);
        if (!decision) break;

        if (decision.type === 'board') {
          legs.push({
            minutes: decision.minutes,
            serviceKey: decision.serviceKey,
            stationId: decision.stationId,
            type: 'wait',
          });
          current = {
            kind: 'route',
            stationId: current.stationId,
            serviceKey: decision.serviceKey,
          };
        } else {
          legs.push({
            fromStationId: decision.fromStationId,
            minutes: decision.minutes,
            toStationId: decision.toStationId,
            type: 'transfer',
          });
          current = { kind: 'base', stationId: decision.toStationId };
        }
        continue;
      }

      const decision = routeDecisions.get(
        routeStateKey(current.stationId, current.serviceKey),
      );
      if (!decision) return null;

      if (decision.type === 'ride') {
        legs.push({
          fromStationId: decision.fromStationId,
          minutes: decision.minutes,
          serviceKey: decision.serviceKey,
          toStationId: decision.toStationId,
          type: 'ride',
        });
        current = {
          kind: 'route',
          stationId: decision.toStationId,
          serviceKey: current.serviceKey,
        };
      } else {
        current = { kind: 'base', stationId: current.stationId };
      }
    }

    if (!destinationIds.includes(current.stationId)) return null;
    return coalesceRideLegs(legs);
  };
  return baseMinutes;
}

export function streetTravelTime(
  properties: StreetProperties,
  transitTimes: ReadonlyMap<string, number>,
  candidateCount: number = 5,
): StreetTravel {
  let best: StreetTravel | null = null;

  for (let candidateIndex = 0; candidateIndex < candidateCount; candidateIndex += 1) {
    const suffix = candidateIndex === 0 ? '' : String(candidateIndex + 1);
    const stationId = properties[`s${suffix}`];
    const distance = Number(properties[`d${suffix}`]);
    if (typeof stationId !== 'string' || !Number.isFinite(distance)) continue;
    const walkingMinutes = distance / WALKING_METERS_PER_MINUTE;
    const transitMinutes = transitTimes.get(stationId) ?? 90;
    const candidate = {
      stationId,
      distance,
      walkingMinutes,
      transitMinutes,
      totalMinutes: walkingMinutes + transitMinutes,
    };
    if (!best || candidate.totalMinutes < best.totalMinutes) best = candidate;
  }

  return (
    best ?? {
      stationId: null,
      distance: Number.POSITIVE_INFINITY,
      walkingMinutes: Number.POSITIVE_INFINITY,
      transitMinutes: 90,
      totalMinutes: Number.POSITIVE_INFINITY,
    }
  );
}

export function bestStreetTravelTime(
  accessCandidates: readonly AccessCandidate[],
  transitTimes: ReadonlyMap<string, number>,
): AccessTravel | null {
  let best: AccessTravel | null = null;

  for (const candidate of accessCandidates) {
    const distanceMeters = Number(candidate.distanceMeters);
    if (!Number.isFinite(distanceMeters) || !candidate.stationId) continue;

    const walkingMinutes = distanceMeters / WALKING_METERS_PER_MINUTE;
    const transitMinutes = transitTimes.get(candidate.stationId) ?? 90;
    const travel = {
      ...candidate,
      walkingMinutes,
      transitMinutes,
      totalMinutes: walkingMinutes + transitMinutes,
    };

    if (!best || travel.totalMinutes < best.totalMinutes) best = travel;
  }

  return best;
}
