import { z } from 'zod';

export const watershedPropertiesSchema = z.object({
  id: z.number().int().positive(),
  outlet_stream: z.number().int().positive(),
  area_km2: z.number().nonnegative(),
  catchments: z.number().int().positive(),
  outlet_lon: z.number().min(-180).max(180),
  outlet_lat: z.number().min(-90).max(90),
  drainage: z.enum(['ocean', 'inland', 'unverified']),
  name: z.string().optional(),
});

export function watershedDrainageLabel(drainage: string): string {
  if (drainage === 'ocean') return 'One modeled ocean outlet';
  if (drainage === 'inland') return 'Inland sink · no ocean outlet';
  return 'Terminal outlet · type unverified';
}
