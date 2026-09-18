import { z } from 'zod';

export const watershedPropertiesSchema = z.object({
  id: z.number().int().positive(),
  terminal_node: z.number().int().positive(),
  source_basins: z.number().int().positive(),
  outlet_stream: z.number().int().positive(),
  area_km2: z.number().nonnegative(),
  catchments: z.number().int().positive(),
  outlet_lon: z.number().min(-180).max(180),
  outlet_lat: z.number().min(-90).max(90),
  drainage: z.enum(['ocean', 'inland', 'unresolved_sink', 'unverified']),
  name: z.string().optional(),
  karst_connections: z.number().int().positive().optional(),
});

export function watershedDrainageLabel(drainage: string): string {
  if (drainage === 'ocean') return 'One modeled ocean outlet';
  if (drainage === 'inland' || drainage === 'unresolved_sink')
    return 'Underground drainage unresolved';
  return 'Terminal outlet · type unverified';
}
