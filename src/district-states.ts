import stateData from './district-states.json';
import type { Coordinate } from './domain.js';
import type { DistrictMethod } from './representative-districts.js';

interface DistrictState {
  readonly code: string;
  readonly fips: string;
  readonly name: string;
  readonly blocks: number;
  readonly population: number;
  readonly houseSeats: number;
  readonly bounds: readonly number[];
}

export const districtStates: readonly DistrictState[] = stateData;
const byCode = new Map(districtStates.map((state) => [state.code, state]));

export const defaultDistrictState = 'CT';
export const baselineDistrictCounts: readonly number[] = [2, 3, 4, 5, 6, 7, 8];
export const maximumDistrictCount =
  Math.max(...districtStates.map(({ houseSeats }) => houseSeats)) + 1;
export const districtOutlineVersion = 'districts-2020-v1';
export const districtDataBundles: readonly {
  readonly version: string;
  readonly methods: readonly DistrictMethod[];
  readonly includeOutline: boolean;
  readonly supplemental: boolean;
}[] = [
  {
    version: districtOutlineVersion,
    methods: ['knife', 'circles', 'reock-circles'],
    includeOutline: true,
    supplemental: false,
  },
  {
    version: 'districts-2020-area-knife-v1',
    methods: ['area-knife'],
    includeOutline: false,
    supplemental: false,
  },
  {
    version: 'districts-2020-apportioned-v1',
    methods: ['knife', 'circles', 'reock-circles', 'area-knife'],
    includeOutline: false,
    supplemental: true,
  },
];

export function districtState(code: string | null): DistrictState | undefined {
  return code === null ? undefined : byCode.get(code.toUpperCase());
}

export function availableDistrictCounts({ houseSeats }: DistrictState): number[] {
  return houseSeats === 1 ? [1, 2] : [houseSeats - 1, houseSeats, houseSeats + 1];
}

export function districtStateBounds(state: DistrictState): [Coordinate, Coordinate] {
  const [west = 0, south = 0, east = 0, north = 0] = state.bounds;
  return [
    [west, south],
    [east, north],
  ];
}
