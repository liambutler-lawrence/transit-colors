import { z } from 'zod';

export const watershedPropertiesSchema = z
  .object({
    id: z.number().int().positive(),
    terminal_node: z.number().int().positive().optional(),
    source_basins: z.number().int().positive(),
    outlet_stream: z.number().int().positive().optional(),
    area_km2: z.number().nonnegative(),
    catchments: z.number().int().positive(),
    outlet_lon: z.number().min(-180).max(180).optional(),
    outlet_lat: z.number().min(-90).max(90).optional(),
    drainage: z.enum(['ocean', 'inland', 'unresolved_sink', 'unverified', 'endorheic']),
    source: z.literal('grit').optional(),
    exit_body: z.string().optional(),
    outlet_known: z.boolean().optional(),
    name: z.string().optional(),
    karst_connections: z.number().int().positive().optional(),
  })
  .refine(
    (basin) =>
      basin.outlet_known === false
        ? ['unverified', 'endorheic'].includes(basin.drainage) &&
          basin.outlet_lon === undefined &&
          basin.outlet_lat === undefined
        : basin.outlet_lon !== undefined &&
          basin.outlet_lat !== undefined &&
          basin.terminal_node !== undefined &&
          basin.outlet_stream !== undefined,
    'A modeled outlet needs a node and coordinate; unlocated depressions must say so',
  );

export function watershedDrainageLabel(drainage: string): string {
  if (drainage === 'endorheic') return 'Closed inland receiving body';
  if (drainage === 'ocean') return 'One modeled ocean outlet';
  if (drainage === 'inland' || drainage === 'unresolved_sink')
    return 'Underground drainage unresolved';
  return 'Terminal outlet · type unverified';
}
