import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
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

  // Automatic boundary parents are pruned by the assignment algorithm. The
  // browser must load its build's exact snapshot, never a mutable data URL.
  const automaticAssets = files.filter((file) =>
    /^assets\/timezone-automatic-regions-[\w-]+\.json$/.test(file),
  );
  assert.equal(
    automaticAssets.length,
    1,
    'Automatic regions need one versioned asset.',
  );
  const automaticAsset = automaticAssets[0];
  const [versionedData, compatibilityData] = await Promise.all([
    readFile(join(directory, automaticAsset)),
    readFile(join(directory, 'data/timezone-automatic-regions.json')),
  ]);
  assert.ok(
    versionedData.equals(compatibilityData),
    'The versioned boundary asset must match the checked snapshot.',
  );
  const scripts = await Promise.all(
    files
      .filter((file) => /^assets\/.*\.js$/.test(file))
      .map((file) => readFile(join(directory, file), 'utf8')),
  );
  assert.ok(
    scripts.some((script) => script.includes(basename(automaticAsset))),
    'The app must reference the versioned boundary asset.',
  );
  assert.ok(
    scripts.every((script) => !script.includes('timezone-automatic-regions.json?v=')),
    'Mutable boundary URLs can mix old code with new hierarchy data.',
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
