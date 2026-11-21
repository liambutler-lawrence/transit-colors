import stateData from './district-states.json';
import type { Coordinate } from './domain.js';

interface DistrictState {
  readonly code: string;
  readonly fips: string;
  readonly name: string;
  readonly blocks: number;
  readonly population: number;
  readonly bounds: readonly number[];
}

export const districtStates: readonly DistrictState[] = stateData;
const byCode = new Map(districtStates.map((state) => [state.code, state]));

export const defaultDistrictState = 'CT';
export const districtDataVersion = 'districts-2020-v1';

export function districtState(code: string | null): DistrictState | undefined {
  return code === null ? undefined : byCode.get(code.toUpperCase());
}

export function districtStateBounds(state: DistrictState): [Coordinate, Coordinate] {
  const [west = 0, south = 0, east = 0, north = 0] = state.bounds;
  return [
    [west, south],
    [east, north],
  ];
}
