import { createHash } from 'node:crypto';

// V8 serialization preserves values but is not a canonical byte representation:
// serializing a deserialized graph can produce different bytes. Hash graph values.
export function highwayAreaGraphDigest(graph) {
  return createHash('sha256')
    .update(
      JSON.stringify(graph, (_key, value) =>
        value instanceof Set || value instanceof Map ? [...value] : value,
      ),
    )
    .digest('hex');
}
