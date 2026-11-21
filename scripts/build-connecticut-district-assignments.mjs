import { readFileSync, writeFileSync } from 'node:fs';

import {
  calculateDistrictAssignments,
  prepareDistrictBlocks,
} from '../src/representative-districts.ts';

const [blocksPath, outputPath] = process.argv.slice(2);
const blocks = prepareDistrictBlocks(JSON.parse(readFileSync(blocksPath, 'utf8')));
const plans = [];
for (const method of ['knife', 'circles']) {
  for (let seats = 2; seats <= 8; seats += 1) {
    const districts = calculateDistrictAssignments(blocks, { method, seats });
    plans.push({ method, seats, districts });
    console.info(`Assigned ${blocks.length} blocks for ${method}, ${seats} districts.`);
  }
}
writeFileSync(outputPath, JSON.stringify(plans));
