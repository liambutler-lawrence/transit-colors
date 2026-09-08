import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const repository = 'liambutler-lawrence/transit-colors';
const projectName = 'transit-colors';
const productionUrl = 'https://maps.liambutlerlawrence.com';
const uploadConcurrency = 4;

export function verifyEnvironment(env) {
  if (
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_REPOSITORY !== repository ||
    env.GITHUB_REF !== 'refs/heads/main' ||
    !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)
  ) {
    throw new Error(
      'Production deployment is only allowed from main in GitHub Actions.',
    );
  }
  for (const key of ['VERCEL_TOKEN', 'VERCEL_PROJECT_ID', 'VERCEL_ORG_ID']) {
    if (!env[key]) throw new Error(`Missing ${key} repository secret.`);
  }
}

function digestBuffer(contents) {
  return createHash('sha1').update(contents).digest('hex');
}

async function digestFile(path) {
  const hash = createHash('sha1');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function collectFiles(directory, relativePath = '') {
  const files = [];
  const entries = await readdir(join(directory, relativePath), {
    withFileTypes: true,
  });
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const file = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(directory, file)));
    } else if (entry.isFile()) {
      const source = join(directory, file);
      const metadata = await stat(source);
      files.push({
        file: `.vercel/output/static/${file}`,
        sha: await digestFile(source),
        size: metadata.size,
        source,
      });
    } else {
      throw new Error(`Unsupported build entry: ${file}`);
    }
  }
  return files;
}

export async function collectDeploymentFiles(directory) {
  const files = await collectFiles(directory);
  const contents = Buffer.from(JSON.stringify({ version: 3 }));
  files.push({
    file: '.vercel/output/config.json',
    sha: digestBuffer(contents),
    size: contents.byteLength,
    contents,
  });
  return files;
}

export function createPayload(files, env) {
  if (!files.some(({ file }) => file === '.vercel/output/static/index.html')) {
    throw new Error('The checked build must contain index.html.');
  }
  return {
    name: projectName,
    project: env.VERCEL_PROJECT_ID,
    target: 'production',
    files: files.map(({ file, sha, size }) => ({ file, sha, size })),
    projectSettings: { framework: null },
    meta: {
      githubCommitSha: env.GITHUB_SHA,
      githubActionsRunId: env.GITHUB_RUN_ID,
    },
  };
}

async function responseJson(response) {
  const body = await response.text();
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

function apiError(response, result) {
  const code = result?.error?.code ?? 'unknown';
  return new Error(`Vercel API ${response.status}: ${code}`);
}

async function requestJson(path, env, body) {
  const response = await fetch(`https://api.vercel.com${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${env.VERCEL_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const result = await responseJson(response);
  if (!response.ok) throw apiError(response, result);
  return result;
}

async function uploadFile(file, env) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const body = file.contents ?? createReadStream(file.source);
    const response = await fetch('https://api.vercel.com/v2/files', {
      method: 'POST',
      redirect: 'error',
      duplex: 'half',
      headers: {
        Authorization: `Bearer ${env.VERCEL_TOKEN}`,
        'Content-Length': String(file.size),
        'Content-Type': 'application/octet-stream',
        'x-vercel-digest': file.sha,
      },
      body,
      signal: AbortSignal.timeout(300_000),
    });
    const result = await responseJson(response);
    if (response.ok) return;
    if (attempt === 3 || (response.status !== 429 && response.status < 500)) {
      throw apiError(response, result);
    }
    await setTimeout(attempt * 2_000);
  }
}

export async function uploadFiles(files, env) {
  let nextIndex = 0;
  let completed = 0;
  async function worker() {
    while (nextIndex < files.length) {
      const index = nextIndex;
      nextIndex += 1;
      const file = files[index];
      await uploadFile(file, env);
      completed += 1;
      console.info(`Uploaded or reused ${completed}/${files.length}: ${file.file}`);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(uploadConcurrency, files.length) }, worker),
  );
}

export async function deploy() {
  const env = process.env;
  verifyEnvironment(env);

  const project = await requestJson(`/v9/projects/${env.VERCEL_PROJECT_ID}`, env);
  if (project.id !== env.VERCEL_PROJECT_ID || project.accountId !== env.VERCEL_ORG_ID) {
    throw new Error('The token does not match the configured project and team.');
  }

  const files = await collectDeploymentFiles('dist');
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  console.info(
    `Uploading ${files.length} checked files (${(totalBytes / 1_000_000).toFixed(1)} MB).`,
  );
  await uploadFiles(files, env);

  const deployment = await requestJson(
    '/v13/deployments?prebuilt=1',
    env,
    createPayload(files, env),
  );
  if (typeof deployment.id !== 'string' || typeof deployment.url !== 'string') {
    throw new Error('Vercel did not return a valid deployment.');
  }
  console.info(`Created production deployment: https://${deployment.url}`);

  const deadline = Date.now() + 10 * 60_000;
  let lastState;
  while (Date.now() < deadline) {
    const current = await requestJson(`/v13/deployments/${deployment.id}`, env);
    if (current.readyState !== lastState) {
      console.info(`Deployment status: ${current.readyState}`);
      lastState = current.readyState;
    }
    if (current.readyState === 'READY') {
      console.info(`Production ready: ${productionUrl}`);
      if (env.GITHUB_STEP_SUMMARY) {
        await appendFile(
          env.GITHUB_STEP_SUMMARY,
          `## Production deployed\n\n[Visit Transit Colors](${productionUrl}) · [Deployment](https://${deployment.url})\n\nThe exact checked artifact was uploaded and deployed entirely in GitHub Actions.\n`,
        );
      }
      return;
    }
    if (['ERROR', 'CANCELED'].includes(current.readyState)) {
      throw new Error(`Deployment failed: ${current.errorCode ?? current.readyState}`);
    }
    await setTimeout(10_000);
  }
  throw new Error('Timed out waiting for Vercel to finish the deployment.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await deploy();
}
