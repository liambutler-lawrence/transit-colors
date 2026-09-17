import { z } from 'zod';

export const WATERSHED_LEVELS: readonly [4, 6, 8] = [4, 6, 8];
export type WatershedLevel = (typeof WATERSHED_LEVELS)[number];

export function watershedLevel(value: unknown): WatershedLevel {
  return value === 4 || value === '4' ? 4 : value === 8 || value === '8' ? 8 : 6;
}

export const watershedPropertiesSchema = z.object({
  id: z.number().int().positive(),
  level: z.union([z.literal(4), z.literal(6), z.literal(8)]),
  area_km2: z.number().nonnegative(),
  upstream_km2: z.number().nonnegative(),
  next_down: z.number().int().nonnegative(),
  main_basin: z.number().int().positive(),
  endorheic: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  coastal: z.union([z.literal(0), z.literal(1)]),
  region: z.enum(['na', 'ar', 'gr']),
});

export function watershedDrainageLabel(endorheic: number, coastal: number): string {
  if (endorheic === 2) return 'Inland sink (terminal basin)';
  if (endorheic === 1) return 'Part of an inland-draining basin';
  return coastal === 1 ? 'Grouped coastal catchments' : 'Ocean-draining network';
}
