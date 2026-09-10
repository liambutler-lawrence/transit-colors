import { GradientRenderer } from '../gradient-renderer.js';
import { circumferenceGradientCoordinates } from '../circumference-gradient-source.js';
import { imageSource, map } from './context.js';

const urls = new Map<string, string>();

export const gradientRenderer = new GradientRenderer({
  createWorker: () =>
    new Worker(new URL('../gradient-render.worker.ts', import.meta.url), {
      type: 'module',
    }),
  present: (key, { image, view }): void => {
    const source = imageSource(key);
    if (!source) return;
    const previous = urls.get(key);
    const url = URL.createObjectURL(image);
    urls.set(key, url);
    source.updateImage({
      url,
      coordinates: circumferenceGradientCoordinates(view.bounds),
    });
    if (previous) URL.revokeObjectURL(previous);
  },
  onError: (error): void => {
    console.error('Gradient update failed:', error);
  },
});

map.on('movestart', () => {
  gradientRenderer.setPaused(true);
});
map.on('moveend', () => {
  gradientRenderer.setPaused(false);
});
map.on('remove', () => {
  gradientRenderer.destroy();
  for (const url of urls.values()) URL.revokeObjectURL(url);
  urls.clear();
});
