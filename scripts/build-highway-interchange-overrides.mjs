import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { buildOsmInterchangeOverride } from './highway-osm-interchange.mjs';

const inputPath = resolve(
  process.argv[2] ?? 'data/.overpass-cache/highways/norwalk-i95-us7.json',
);
const outputPath = resolve(
  process.argv[3] ?? 'data/highway-interchanges/norwalk-i95-us7.json',
);
const overpass = JSON.parse(await readFile(inputPath, 'utf8'));
const override = buildOsmInterchangeOverride(overpass, {
  id: 'norwalk-i95-us7',
  mainlines: [
    {
      fromCoordinate: [-73.44494, 41.09504],
      ref: 'I 95',
      replacementMode: 'span',
      targetFeatureId: 'ne-road-49175-0',
      toCoordinate: [-73.40288, 41.11022],
    },
    {
      fromCoordinate: [-73.4189814, 41.1103114],
      ref: 'US 7',
      replacementMode: 'full',
      targetFeatureId: 'ne-road-7118-0',
      toCoordinate: [-73.43132, 41.14972],
    },
  ],
});

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(override)}\n`);
console.log(`Wrote ${outputPath}`);
