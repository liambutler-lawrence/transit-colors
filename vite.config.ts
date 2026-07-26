import { cpSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2024',
  },
  plugins: [
    {
      closeBundle() {
        const outputDirectory = resolve(import.meta.dirname, 'dist');
        mkdirSync(outputDirectory, { recursive: true });
        mkdirSync(resolve(outputDirectory, 'vendor'), { recursive: true });
        cpSync(resolve(import.meta.dirname, 'data'), resolve(outputDirectory, 'data'), {
          recursive: true,
          filter(source) {
            return (
              !source.includes('/.gtfs-cache/') && !source.includes('/.overpass-cache/')
            );
          },
        });
        cpSync(
          resolve(import.meta.dirname, 'vendor/openfreemap-shell.json'),
          resolve(outputDirectory, 'vendor/openfreemap-shell.json'),
        );
        cpSync(
          resolve(import.meta.dirname, 'vendor/openfreemap-liberty.json'),
          resolve(outputDirectory, 'vendor/openfreemap-liberty.json'),
        );
      },
      name: 'copy-static-data',
    },
  ],
});
