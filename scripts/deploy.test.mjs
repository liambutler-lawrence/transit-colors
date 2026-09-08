import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { collectDeploymentFiles, createPayload, verifyEnvironment } from './deploy.mjs';

const env = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'liambutler-lawrence/transit-colors',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'push',
  GITHUB_SHA: 'abc123',
  GITHUB_RUN_ID: '456',
  VERCEL_TOKEN: 'test-only',
  VERCEL_PROJECT_ID: 'prj_test',
  VERCEL_ORG_ID: 'team_test',
};

test('only main-branch Actions runs can deploy', () => {
  assert.doesNotThrow(() => verifyEnvironment(env));
  for (const change of [
    { GITHUB_ACTIONS: undefined },
    { GITHUB_REF: 'refs/heads/feature' },
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_REPOSITORY: 'someone/else' },
    { VERCEL_TOKEN: '' },
  ]) {
    assert.throws(() => verifyEnvironment({ ...env, ...change }));
  }
});

test('references the exact checked files in Build Output API format', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'transit-colors-deploy-'));
  try {
    await mkdir(join(fixture, 'assets'));
    await writeFile(join(fixture, 'index.html'), '<h1>Transit Colors</h1>');
    await writeFile(join(fixture, 'assets', 'app.js'), 'export {};');

    const files = await collectDeploymentFiles(fixture);
    const index = files.find(({ file }) => file === '.vercel/output/static/index.html');
    assert.equal(index?.size, 23);
    assert.equal(
      index?.sha,
      createHash('sha1').update('<h1>Transit Colors</h1>').digest('hex'),
    );

    const config = files.find(({ file }) => file === '.vercel/output/config.json');
    assert.deepEqual(JSON.parse(config?.contents.toString() ?? ''), { version: 3 });

    const payload = createPayload(files, env);
    assert.equal(payload.project, env.VERCEL_PROJECT_ID);
    assert.equal(payload.target, 'production');
    assert.ok(payload.files.every((file) => file.sha && file.size >= 0));
    assert.ok(payload.files.every((file) => !('source' in file)));
    assert.ok(!JSON.stringify(payload).includes(env.VERCEL_TOKEN));
    assert.throws(() => createPayload([], env), /index.html/);
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
});
