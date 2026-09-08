import assert from 'node:assert/strict';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { RUNTIME_DATA_FILES } from '../vite.config.ts';

const maximumStaticFileBytes = 100 * 1024 * 1024;

async function collectFiles(directory, relativePath = '') {
  const files = [];
  const entries = await readdir(join(directory, relativePath), {
    withFileTypes: true,
  });
  for (const entry of entries) {
    const file = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await collectFiles(directory, file)));
    else if (entry.isFile()) files.push(file);
  }
  return files;
}

export async function verifyBuild(directory = 'dist') {
  const files = await collectFiles(directory);
  assert.ok(files.includes('index.html'), 'Production build is missing index.html.');
  assert.ok(
    files.includes('vendor/openfreemap-shell.json') &&
      files.includes('vendor/openfreemap-liberty.json'),
    'Production build is missing a basemap style.',
  );

  const dataFiles = files
    .filter((file) => file.startsWith('data/'))
    .map((file) => file.slice('data/'.length))
    .sort();
  assert.deepEqual(
    dataFiles,
    [...RUNTIME_DATA_FILES].sort(),
    'Production data must match the reviewed runtime allowlist.',
  );

  let totalBytes = 0;
  for (const file of files) {
    const metadata = await stat(join(directory, file));
    totalBytes += metadata.size;
    assert.ok(
      metadata.size <= maximumStaticFileBytes,
      `${file} exceeds the 100 MiB static-file limit.`,
    );
  }
  console.info(
    `Verified ${files.length} production files (${(totalBytes / 1_000_000).toFixed(1)} MB).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await verifyBuild();
}
