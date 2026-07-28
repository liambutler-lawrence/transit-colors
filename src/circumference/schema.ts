import { z } from 'zod';

import { coordinateSchema } from '../domain.js';

const transferSourceSchema = z.enum(['inferred', 'published']);
const circumferenceNodeSchema = z.object({
  coordinate: coordinateSchema,
  id: z.string().min(1),
  label: z.string().optional(),
  lineNames: z.array(z.string()),
  name: z.string(),
  stationIds: z.array(z.string()),
});
const networkSegmentSchema = z.object({
  coordinates: z.array(coordinateSchema).min(2),
  distanceMeters: z.number().nonnegative().optional(),
  display: z.boolean().optional(),
  from: circumferenceNodeSchema,
  id: z.string().min(1),
  lines: z.array(z.string()),
  to: circumferenceNodeSchema,
  transferMinutes: z.number().nonnegative().nullable().optional(),
  transferSource: transferSourceSchema.optional(),
  type: z.enum(['ride', 'transfer']),
});
const candidateSegmentSchema = networkSegmentSchema.extend({
  distanceMeters: z.number().nonnegative(),
  primaryLine: z.string().nullable(),
  transferMinutes: z.number().nonnegative().nullable(),
  transferSource: transferSourceSchema.nullable(),
});
const candidateSchema = z.object({
  areaSquareMeters: z.number().nonnegative(),
  coordinates: z.array(coordinateSchema).min(3),
  id: z.string().min(1),
  lengthMeters: z.number().nonnegative(),
  lines: z.array(z.string()),
  nodeIds: z.array(z.string().min(1)).min(3),
  rideLengthMeters: z.number().nonnegative(),
  segments: z.array(candidateSegmentSchema).min(3),
  stations: z.array(circumferenceNodeSchema).min(3),
  transferCount: z.number().int().nonnegative(),
  walkingLengthMeters: z.number().nonnegative(),
});
const methodologySchema = z.object({
  biconnectedComponentCount: z.number().int().nonnegative(),
  biconnectedComponentSizes: z.array(z.number().int().nonnegative()),
  corePlatformNodeCount: z.number().int().nonnegative(),
  displayOnlyShortcutCount: z.number().int().nonnegative().default(0),
  eligibleStationCount: z.number().int().nonnegative(),
  generatedCandidateCount: z.number().int().nonnegative(),
  inferredTransferCount: z.number().int().nonnegative(),
  optimizationGeometry: z.literal('straight-platform-edges').optional(),
  optimizationIterations: z.number().int().positive().optional(),
  optimizationMethod: z.enum(['exact-milp', 'heuristic']).optional(),
  optimizationMilliseconds: z.number().nonnegative().optional(),
  optimizationStatus: z.literal('optimal').optional(),
  platformNodeCount: z.number().int().nonnegative(),
  publishedTransferCount: z.number().int().nonnegative(),
  removedShortcutCount: z.number().int().nonnegative(),
  removedShortcuts: z.array(
    z.object({
      from: z.string(),
      lines: z.array(z.string()),
      to: z.string(),
    }),
  ),
  trackGeometryAvailable: z.boolean(),
  trackGeometryEdgeCount: z.number().int().nonnegative(),
  trackGeometryEnabled: z.boolean(),
  trackGeometryMethod: z.string().nullable(),
});
const modeResultSchema = z.object({
  candidates: z.array(candidateSchema).min(1),
  methodology: methodologySchema,
  network: z.object({
    segments: z.array(networkSegmentSchema),
    stations: z.array(circumferenceNodeSchema),
  }),
  scheduleCandidates: z.array(candidateSchema).default([]),
});

export const circumferenceGeometryVariantsSchema = z.object({
  straight: modeResultSchema,
  track: modeResultSchema,
});
