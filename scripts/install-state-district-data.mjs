import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  defaultDistrictState,
  districtDataVersion,
  districtStates,
} from '../src/district-states.ts';
import { districtRequestSchema } from '../src/representative-districts.ts';

const directory = join('public', 'district-plans', districtDataVersion);
const archiveDirectory = mkdtempSync(join(tmpdir(), 'district-plans-'));
try {
  execFileSync(
    'gh',
    [
      'release',
      'download',
      districtDataVersion,
      '--repo',
      'liambutler-lawrence/transit-colors',
      '--pattern',
      'districts-*.tar',
      '--dir',
      archiveDirectory,
    ],
    { stdio: 'inherit' },
  );
  const expectedNames = ['outline.json.gz'];
  for (const method of districtRequestSchema.shape.method.options) {
    for (let seats = 2; seats <= 8; seats += 1) {
      expectedNames.push(`${method}-${seats}.json.gz`);
    }
  }
  expectedNames.sort();
  mkdirSync(directory, { recursive: true });
  for (const { code, fips } of districtStates) {
    if (code === defaultDistrictState) continue;
    const archive = join(archiveDirectory, `districts-${fips}.tar`);
    const entries = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter((entry) => entry !== `${fips}/`)
      .sort();
    assert.deepEqual(
      entries,
      expectedNames.map((name) => `${fips}/${name}`),
    );
    execFileSync('tar', ['-xf', archive, '-C', directory]);
    for (const name of expectedNames) {
      const file = statSync(join(directory, fips, name));
      assert.ok(
        file.isFile() && file.size > 0,
        `Missing district asset ${fips}/${name}`,
      );
    }
  }
  assert.equal(readdirSync(directory).length, 49);
} finally {
  rmSync(archiveDirectory, { recursive: true, force: true });
}
