import type { Schedule } from '../domain.js';
import { routeIdForService } from './graph.js';
import type {
  CircumferenceServiceEdge,
  EdgeKey,
  EdgeStringSets,
  MutableEdgeStringSets,
  NodeId,
} from './types.js';

const SERVICE_EDGE_SEPARATOR = '\u0001';

export function circumferenceRouteMetadata(
  schedules: Schedule,
  servicePriority: (lineName: string, description?: string) => number,
): {
  readonly ambiguousLineNames: ReadonlySet<string>;
  readonly lineNameByRouteId: ReadonlyMap<string, string>;
  readonly servicePriorityByLine: ReadonlyMap<string, number>;
} {
  const routeIdsByLineName = new Map<string, Set<string>>();
  const lineNameByRouteId = new Map<string, string>();
  const servicePriorityByLine = new Map<string, number>();
  for (const [routeId, route] of Object.entries(schedules.routes)) {
    if (route.mode !== 'subway') continue;
    const lineName = route.name || routeId;
    lineNameByRouteId.set(routeId, lineName);
    const routeIds = routeIdsByLineName.get(lineName) ?? new Set();
    routeIds.add(routeId);
    routeIdsByLineName.set(lineName, routeIds);
    const priority = servicePriority(lineName, route.description);
    servicePriorityByLine.set(
      lineName,
      Math.min(servicePriorityByLine.get(lineName) ?? priority, priority),
    );
  }
  return {
    ambiguousLineNames: new Set(
      [...routeIdsByLineName]
        .filter(([, routeIds]) => routeIds.size > 1)
        .map(([lineName]) => lineName),
    ),
    lineNameByRouteId,
    servicePriorityByLine,
  };
}

export function serviceEdgeToken(
  serviceKey: string,
  fromId: NodeId,
  toId: NodeId,
): string {
  return [serviceKey, fromId, toId].join(SERVICE_EDGE_SEPARATOR);
}

function parseServiceEdgeToken(token: string): CircumferenceServiceEdge | null {
  const [serviceKey, fromId, toId] = token.split(SERVICE_EDGE_SEPARATOR);
  return serviceKey && fromId && toId ? [serviceKey, fromId, toId] : null;
}

export function lineServiceEdges(
  serviceEdgeTokens: ReadonlySet<string>,
  lineNames: ReadonlySet<string>,
  lineNameByRouteId: ReadonlyMap<string, string>,
): Readonly<Record<string, readonly CircumferenceServiceEdge[]>> {
  const edgesByLine = new Map<string, CircumferenceServiceEdge[]>();
  for (const token of serviceEdgeTokens) {
    const serviceEdge = parseServiceEdgeToken(token);
    if (!serviceEdge) continue;
    const lineName = lineNameByRouteId.get(routeIdForService(serviceEdge[0]));
    if (!lineName || !lineNames.has(lineName)) continue;
    const edges = edgesByLine.get(lineName) ?? [];
    edges.push(serviceEdge);
    edgesByLine.set(lineName, edges);
  }
  return Object.fromEntries(
    [...edgesByLine].sort(([first], [second]) =>
      first.localeCompare(second, 'en', {
        numeric: true,
        sensitivity: 'base',
      }),
    ),
  );
}

export function addEdgeString(
  valuesByEdge: MutableEdgeStringSets,
  key: EdgeKey,
  value: string,
): void {
  const values = valuesByEdge.get(key) ?? new Set<string>();
  values.add(value);
  valuesByEdge.set(key, values);
}

export function copyEdgeStringSets(
  valuesByEdge: EdgeStringSets,
): MutableEdgeStringSets {
  return new Map([...valuesByEdge].map(([key, values]) => [key, new Set(values)]));
}
