import stateData from './district-states.json';
import type { Coordinate } from './domain.js';
import type { DistrictMethod } from './representative-districts.js';

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
export const districtOutlineVersion = 'districts-2020-v1';
export const districtDataBundles: readonly {
  readonly version: string;
  readonly methods: readonly DistrictMethod[];
  readonly includeOutline: boolean;
}[] = [
  {
    version: districtOutlineVersion,
    methods: ['knife', 'circles', 'reock-circles'],
    includeOutline: true,
  },
  {
    version: 'districts-2020-area-knife-v1',
    methods: ['area-knife'],
    includeOutline: false,
  },
];

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
