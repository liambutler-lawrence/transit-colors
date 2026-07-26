import type { z } from 'zod';

export async function fetchParsed<T>(url: string, schema: z.ZodType<T>): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }
  const payload: unknown = await response.json();
  return schema.parse(payload);
}

export function parseJson<T>(text: string, schema: z.ZodType<T>): T {
  const payload: unknown = JSON.parse(text);
  return schema.parse(payload);
}
