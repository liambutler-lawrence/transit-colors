import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  availableDistrictCounts,
  baselineDistrictCounts,
  defaultDistrictState,
  districtDataBundles,
  districtStates,
} from '../src/district-states.ts';

function installBundle({ version, methods, includeOutline, supplemental }) {
  const directory = join('public', 'district-plans', version);
  const archiveDirectory = mkdtempSync(join(tmpdir(), 'district-plans-'));
  try {
    execFileSync(
      'gh',
      [
        'release',
        'download',
        version,
        '--repo',
        'liambutler-lawrence/transit-colors',
        '--pattern',
        'districts-*.tar',
        '--dir',
        archiveDirectory,
      ],
      { stdio: 'inherit' },
    );
    mkdirSync(directory, { recursive: true });
    for (const state of districtStates) {
      if (state.code === defaultDistrictState) continue;
      const { fips } = state;
      const allowed = availableDistrictCounts(state);
      const releasedCounts = supplemental
        ? allowed.filter((count) => !baselineDistrictCounts.includes(count))
        : baselineDistrictCounts;
      if (!releasedCounts.length) continue;
      const pathsForCounts = (counts) => [
        ...(includeOutline ? [`${fips}/outline.json.gz`] : []),
        ...methods.flatMap((method) =>
          counts.map((count) => `${fips}/${method}-${count}.json.gz`),
        ),
      ];
      const archive = join(archiveDirectory, `districts-${fips}.tar`);
      const entries = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' })
        .trim()
        .split('\n')
        .filter((entry) => entry !== `${fips}/`)
        .sort();
      assert.deepEqual(entries, pathsForCounts(releasedCounts).sort());
      const selectedPaths = pathsForCounts(
        releasedCounts.filter((count) => allowed.includes(count)),
      );
      if (!selectedPaths.length) continue;
      execFileSync('tar', ['-xf', archive, '-C', directory, ...selectedPaths]);
      for (const path of selectedPaths) {
        const file = statSync(join(directory, path));
        assert.ok(
          file.isFile() && file.size > 0,
          `Missing district asset ${version}/${path}`,
        );
      }
    }
  } finally {
    rmSync(archiveDirectory, { recursive: true, force: true });
  }
}

for (const bundle of districtDataBundles) installBundle(bundle);
