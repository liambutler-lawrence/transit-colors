import type { RangeResponse, Source } from 'pmtiles';

export interface ArchivePart {
  source: Source;
  bytes: number;
}

/** Read one logical archive from immutable, size-limited static files. */
export class MultipartPMTilesSource implements Source {
  private readonly parts: readonly (ArchivePart & { offset: number })[];
  readonly byteLength: number;

  constructor(
    private readonly key: string,
    parts: readonly ArchivePart[],
    private readonly version: string,
  ) {
    let offset = 0;
    this.parts = parts.map((part) => {
      if (!Number.isSafeInteger(part.bytes) || part.bytes <= 0)
        throw new RangeError('Archive parts must have a positive byte length');
      const entry = { ...part, offset };
      offset += part.bytes;
      return entry;
    });
    if (!Number.isSafeInteger(offset) || offset === 0)
      throw new RangeError('Archive is empty or exceeds supported byte offsets');
    this.byteLength = offset;
  }

  getKey(): string {
    return this.key;
  }

  async getBytes(
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<RangeResponse> {
    signal?.throwIfAborted();
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      offset >= this.byteLength ||
      length <= 0 ||
      !Number.isSafeInteger(offset + length)
    )
      throw new RangeError('Invalid archive byte range');
    const end = Math.min(this.byteLength, offset + length);
    const ranges = this.parts
      .filter((part) => part.offset < end && part.offset + part.bytes > offset)
      .map(async (part) => {
        const start = Math.max(offset, part.offset);
        const size = Math.min(end, part.offset + part.bytes) - start;
        const response = await part.source.getBytes(start - part.offset, size, signal);
        if (response.data.byteLength !== size)
          throw new Error('Incomplete watershed archive range');
        return { start, data: response.data };
      });
    const chunks = await Promise.all(ranges);
    const data = new Uint8Array(end - offset);
    for (const chunk of chunks)
      data.set(new Uint8Array(chunk.data), chunk.start - offset);
    // Part URLs contain the whole-archive digest and are never reused for another
    // version. The logical archive has one stable ETag across all its pieces.
    return { data: data.buffer, etag: this.version };
  }
}
