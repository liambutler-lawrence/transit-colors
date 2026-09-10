import { circumferenceGradientViewReusable } from './circumference-map.js';
import {
  gradientWorkerResponseSchema,
  type GradientDefinition,
  type GradientView,
  type GradientWorkerRequest,
} from './gradient-render-protocol.js';
import type { BoundsTuple } from './circumference-gradient-source.js';

interface WorkerPort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: GradientWorkerRequest): void;
  terminate(): void;
}

interface CachedImage {
  readonly view: GradientView;
  readonly image: Blob;
}

interface Channel {
  readonly geometry: GradientDefinition;
  readonly cache: CachedImage[];
  uploaded: boolean;
  generation: number;
  presented: CachedImage | null;
  pending: { readonly view: GradientView; readonly visibleBounds: BoundsTuple } | null;
}

interface ActiveRender {
  readonly id: number;
  readonly key: string;
  readonly channel: Channel;
  readonly generation: number;
  readonly view: GradientView;
}

/** One worker, one active render, and at most one replacement per map source. */
export class GradientRenderer {
  private readonly channels = new Map<string, Channel>();
  private worker: WorkerPort | null = null;
  private active: ActiveRender | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextId = 0;
  private paused = false;

  constructor(
    private readonly options: {
      readonly createWorker: () => WorkerPort;
      readonly present: (key: string, result: CachedImage) => void;
      readonly onError: (error: Error) => void;
      readonly delayMs?: number;
    },
  ) {}

  configure(key: string, geometry: GradientDefinition): void {
    const previous = this.channels.get(key)?.geometry;
    if (previous) {
      if ('highwayUrl' in previous && 'highwayUrl' in geometry) {
        if (previous.highwayUrl === geometry.highwayUrl) return;
      } else if (
        !('highwayUrl' in previous) &&
        !('highwayUrl' in geometry) &&
        previous.coordinates === geometry.coordinates &&
        previous.landmassPolygons === geometry.landmassPolygons &&
        previous.maxDistanceMeters === geometry.maxDistanceMeters &&
        previous.outsideOnly === geometry.outsideOnly
      )
        return;
    }
    this.cancel(key);
    this.channels.set(key, {
      geometry,
      cache: [],
      uploaded: false,
      generation: 0,
      presented: null,
      pending: null,
    });
  }

  request(key: string, view: GradientView, visibleBounds = view.bounds): void {
    const channel = this.channels.get(key);
    if (!channel) return;
    channel.generation += 1;
    channel.pending = { view, visibleBounds };
    if (this.active?.key === key)
      this.worker?.postMessage({ type: 'cancel', id: this.active.id });
    this.schedule();
  }

  cancel(key: string): void {
    const channel = this.channels.get(key);
    if (channel) {
      channel.pending = null;
      channel.generation += 1;
    }
    if (this.active?.key === key)
      this.worker?.postMessage({ type: 'cancel', id: this.active.id });
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) {
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
      if (this.active) {
        // Keep the newest view queued, but never upload a texture during a gesture.
        this.worker?.postMessage({ type: 'cancel', id: this.active.id });
      }
    } else this.schedule();
  }

  destroy(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.worker?.terminate();
    this.worker = null;
    this.active = null;
    this.channels.clear();
  }

  private schedule(): void {
    if (this.paused) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.options.delayMs ?? 120);
  }

  private flush(): void {
    if (this.paused || this.active) return;
    for (const [key, channel] of this.channels) {
      const pending = channel.pending;
      if (!pending) continue;
      const cached = channel.cache.find((entry) =>
        circumferenceGradientViewReusable(
          entry.view,
          pending.view,
          pending.visibleBounds,
        ),
      );
      if (cached) {
        channel.pending = null;
        channel.cache.splice(channel.cache.indexOf(cached), 1);
        channel.cache.unshift(cached);
        if (channel.presented !== cached) {
          channel.presented = cached;
          this.options.present(key, cached);
        }
        continue;
      }
      try {
        const worker = this.getWorker();
        if (!channel.uploaded) {
          worker.postMessage({ type: 'configure', key, geometry: channel.geometry });
          channel.uploaded = true;
        }
        this.active = {
          id: ++this.nextId,
          key,
          channel,
          generation: channel.generation,
          view: pending.view,
        };
        worker.postMessage({
          type: 'render',
          key,
          id: this.active.id,
          view: pending.view,
        });
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }
  }

  private getWorker(): WorkerPort {
    if (this.worker) return this.worker;
    const worker = this.options.createWorker();
    worker.onmessage = (event): void => {
      const parsed = gradientWorkerResponseSchema.safeParse(event.data);
      if (!parsed.success) {
        this.fail(new Error('Invalid gradient worker response.'));
        return;
      }
      const result = parsed.data;
      const active = this.active;
      if (!active || active.id !== result.id) return;
      this.active = null;
      const current = this.channels.get(active.key);
      const latest =
        current === active.channel && current.generation === active.generation;
      if (result.type === 'rendered' && current === active.channel) {
        const cached = { view: active.view, image: result.image };
        current.cache.unshift(cached);
        current.cache.length = Math.min(current.cache.length, 4);
        if (latest && !this.paused) {
          current.pending = null;
          current.presented = cached;
          this.options.present(active.key, cached);
        }
      } else if (result.type === 'error') {
        if (current === active.channel) current.uploaded = false;
        if (latest) current.pending = null;
        this.options.onError(new Error(result.message));
      }
      this.schedule();
    };
    worker.onerror = (event): void => {
      event.preventDefault();
      this.fail(new Error(event.message || 'Gradient worker could not load.'));
    };
    this.worker = worker;
    return worker;
  }

  private fail(error: Error): void {
    this.worker?.terminate();
    this.worker = null;
    this.active = null;
    for (const channel of this.channels.values()) {
      channel.uploaded = false;
      channel.pending = null;
    }
    // Keep the last good image. A later view request can retry the worker.
    this.options.onError(error);
  }
}
