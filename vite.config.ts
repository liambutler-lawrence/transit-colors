import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig } from 'vite';

export const RUNTIME_DATA_FILES: readonly string[] = [
  'athens-circumference.json',
  'athens-metadata.json',
  'athens-schedules.json',
  'athens-stations.geojson',
  'atlanta-circumference.json',
  'atlanta-metadata.json',
  'atlanta-schedules.json',
  'atlanta-stations.geojson',
  'cdmx-circumference.json',
  'cdmx-metadata.json',
  'cdmx-schedules.json',
  'cdmx-stations.geojson',
  'cdmx-streets.pmtiles',
  'circumference-landmasses.json',
  'jersey-city-land-use-summary.json',
  'jersey-city-land-use.pmtiles',
  'north-america-highway-circumference.json',
  'north-america-highways.pmtiles',
  'nyc-circumference.json',
  'nyc-metadata.json',
  'nyc-schedules.json',
  'nyc-stations.geojson',
  'singapore-circumference.json',
  'singapore-metadata.json',
  'singapore-schedules.json',
  'singapore-stations.geojson',
  'timezone-skew-countries.geojson',
  'timezone-skew-countries.pmtiles',
  'timezone-skew-zones.geojson',
  'timezone-skew-zones.pmtiles',
];

export default defineConfig({
  base: './',
  build: {
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2024',
  },
  plugins: [
    {
      closeBundle() {
        const outputDirectory = resolve(import.meta.dirname, 'dist');
        const dataOutputDirectory = resolve(outputDirectory, 'data');
        mkdirSync(outputDirectory, { recursive: true });
        mkdirSync(resolve(outputDirectory, 'vendor'), { recursive: true });
        mkdirSync(dataOutputDirectory, { recursive: true });
        for (const fileName of RUNTIME_DATA_FILES) {
          copyFileSync(
            resolve(import.meta.dirname, 'data', fileName),
            resolve(dataOutputDirectory, fileName),
          );
        }
        copyFileSync(
          resolve(import.meta.dirname, 'vendor/openfreemap-shell.json'),
          resolve(outputDirectory, 'vendor/openfreemap-shell.json'),
        );
        copyFileSync(
          resolve(import.meta.dirname, 'vendor/openfreemap-liberty.json'),
          resolve(outputDirectory, 'vendor/openfreemap-liberty.json'),
        );
      },
      name: 'copy-static-data',
    },
  ],
});
