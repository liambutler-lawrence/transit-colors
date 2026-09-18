import type { ExpressionSpecification } from 'maplibre-gl';
import exitBodies from '../data/north-america-watersheds-exit-bodies.json';

export const watershedExitBodies = exitBodies.bodies;
export const unresolvedWatershedColor = '#8c9693';
const bodyByBasin = new Map<number, string>();
for (const body of watershedExitBodies)
  for (const id of body.basins) bodyByBasin.set(id, body.name);

export function watershedExitBody(id: number, drainage: string): string {
  return drainage === 'ocean'
    ? (bodyByBasin.get(id) ?? 'Receiving body unclassified')
    : 'Unresolved';
}

export function watershedFillColor(): ExpressionSpecification {
  const stops: (number[] | string)[] = [];
  for (const body of watershedExitBodies) stops.push(body.basins, body.color);
  const match: ExpressionSpecification = [
    'match',
    ['get', 'id'],
    -1,
    unresolvedWatershedColor,
    ...stops,
    unresolvedWatershedColor,
  ];
  return [
    'case',
    ['==', ['get', 'drainage'], 'ocean'],
    match,
    unresolvedWatershedColor,
  ];
}
