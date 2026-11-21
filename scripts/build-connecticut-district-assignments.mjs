import { readFileSync, writeFileSync } from 'node:fs';

import {
  calculateDistrictAssignments,
  districtRequestSchema,
  isKnifeMethod,
  prepareDistrictBlocks,
  prepareKnifeOrders,
} from '../src/representative-districts.ts';

const [blocksPath, outputPath, methodArgument] = process.argv.slice(2);
const methodSchema = districtRequestSchema.shape.method;
const methods = methodArgument
  ? [methodSchema.parse(methodArgument)]
  : methodSchema.options;
const blocks = prepareDistrictBlocks(JSON.parse(readFileSync(blocksPath, 'utf8')));
const knifeOrders = methods.some(isKnifeMethod)
  ? prepareKnifeOrders(blocks)
  : undefined;
const plans = [];
for (const method of methods) {
  for (let seats = 2; seats <= 8; seats += 1) {
    const districts = calculateDistrictAssignments(
      blocks,
      { method, seats },
      knifeOrders,
    );
    plans.push({ method, seats, districts });
    console.info(`Assigned ${blocks.length} blocks for ${method}, ${seats} districts.`);
  }
}
writeFileSync(outputPath, JSON.stringify(plans));
