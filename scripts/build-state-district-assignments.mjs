import { closeSync, openSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  calculateDistrictAssignments,
  districtRequestSchema,
  isKnifeMethod,
  prepareDistrictBlocks,
  prepareKnifeOrders,
} from '../src/representative-districts.ts';

function* readBlocks(path) {
  const descriptor = openSync(path, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  let incomplete = '';
  try {
    let bytes;
    while ((bytes = readSync(descriptor, buffer)) > 0) {
      const lines = (incomplete + buffer.toString('utf8', 0, bytes)).split('\n');
      incomplete = lines.pop();
      for (const line of lines) yield JSON.parse(line);
    }
    if (incomplete) yield JSON.parse(incomplete);
  } finally {
    closeSync(descriptor);
  }
}

const [blocksPath, outputPath, longitude, latitude, methodArgument, seatsArgument] =
  process.argv.slice(2);
const methods = methodArgument
  ? methodArgument
      .split(',')
      .map((method) => districtRequestSchema.shape.method.parse(method))
  : districtRequestSchema.shape.method.options;
const districtCounts = seatsArgument ? [Number(seatsArgument)] : [2, 3, 4, 5, 6, 7, 8];
const blocks = prepareDistrictBlocks(readBlocks(blocksPath), [
  Number(longitude),
  Number(latitude),
]);
console.info(`Prepared ${blocks.length} blocks.`);
const knifeOrders =
  methods.some(isKnifeMethod) && districtCounts.some((seats) => seats > 1)
    ? prepareKnifeOrders(blocks)
    : undefined;
for (const method of methods) {
  for (const seats of districtCounts) {
    const request = districtRequestSchema.parse({ method, seats });
    const assignments = calculateDistrictAssignments(blocks, request, knifeOrders);
    writeFileSync(
      join(outputPath, `${method}-${seats}.json`),
      JSON.stringify(assignments),
    );
    console.info(`Assigned ${blocks.length} blocks for ${method}, ${seats} districts.`);
  }
}
