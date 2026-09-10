import { z } from 'zod';

const coordinate = z.tuple([z.number(), z.number()]);
const bounds = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export const gradientGeometrySchema = z.object({
  coordinates: z.array(coordinate),
  landmassPolygons: z.array(z.array(z.array(coordinate))),
  maxDistanceMeters: z.number().nonnegative(),
  outsideOnly: z.boolean(),
});
export type GradientGeometry = z.infer<typeof gradientGeometrySchema>;
export const gradientDefinitionSchema = z.union([
  gradientGeometrySchema,
  z.object({ highwayUrl: z.url() }),
]);
export type GradientDefinition = z.infer<typeof gradientDefinitionSchema>;

export const gradientViewSchema = z.object({
  bounds,
  width: z.number().int().min(1).max(1024),
  height: z.number().int().min(1).max(1024),
});
export type GradientView = z.infer<typeof gradientViewSchema>;

export const gradientWorkerRequestSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('configure'),
    key: z.string(),
    geometry: gradientDefinitionSchema,
  }),
  z.object({
    type: z.literal('render'),
    key: z.string(),
    id: z.number(),
    view: gradientViewSchema,
  }),
  z.object({ type: z.literal('cancel'), id: z.number() }),
]);
export type GradientWorkerRequest = z.infer<typeof gradientWorkerRequestSchema>;

export const gradientWorkerResponseSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('rendered'), id: z.number(), image: z.instanceof(Blob) }),
  z.object({ type: z.literal('cancelled'), id: z.number() }),
  z.object({ type: z.literal('error'), id: z.number(), message: z.string() }),
]);
export type GradientWorkerResponse = z.infer<typeof gradientWorkerResponseSchema>;
