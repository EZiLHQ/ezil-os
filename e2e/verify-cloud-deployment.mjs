/** Read back deployment identity; a matching shell bundle alone cannot prove a Git SHA. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

function required(env, key) {
  assert.ok(env[key], `${key} is required`);
  return env[key];
}

export function assertVercelDeployment(deployment, { sha, app, project, target }) {
  assert.equal(deployment.readyState, 'READY', 'Vercel deployment is not ready');
  assert.equal(deployment.projectId, project, 'Unexpected Vercel project');
  assert.equal(`https://${deployment.url}`, app, 'Unexpected Vercel deployment URL');
  assert.equal(deployment.meta?.githubCommitSha, sha, 'Vercel source SHA differs');
  assert.equal(deployment.target ?? 'preview', target, 'Unexpected Vercel target');
  assert.ok(deployment.id, 'Missing Vercel deployment ID');
  return deployment.id;
}

export function assertWorkerDeployment(deployments, version, sha) {
  const active = deployments?.[0];
  assert.equal(active?.versions?.length, 1, 'Worker must serve exactly one version');
  assert.equal(active.versions[0].percentage, 100, 'Worker version must receive 100% traffic');
  assert.equal(version.id, active.versions[0].version_id, 'Unexpected Worker version');
  assert.equal(version.annotations?.['workers/message'], `git:${sha}`, 'Worker source SHA differs');
  return version.id;
}

export async function verifyCloudDeployment(env = process.env, fetchImpl = fetch, mode = 'all') {
  assert.ok(['all', 'worker', 'project'].includes(mode), 'Expected all, worker or project verification mode');
  const sha = required(env, 'EZIL_DEPLOY_SHA');
  assert.match(sha, /^[a-f0-9]{40}$/, 'Expected a full Git SHA');
  const request = async (url, headers = {}) => {
    const response = await fetchImpl(url, {
      headers, redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    // Never print response bodies: provider errors may contain configuration.
    assert.ok(response.ok, `Deployment verification HTTP ${response.status}`);
    return response.json();
  };
  if (mode === 'project') {
    const project = required(env, 'VERCEL_PROJECT_ID');
    const url = new URL(`https://api.vercel.com/v9/projects/${encodeURIComponent(project)}`);
    url.searchParams.set('teamId', required(env, 'VERCEL_ORG_ID'));
    const result = await request(url, { authorization: `Bearer ${required(env, 'VERCEL_TOKEN')}` });
    assert.equal(result.id, project, 'Unexpected Vercel project');
    assert.equal(result.rootDirectory, 'app', 'Vercel rootDirectory must be app for a repository source deploy');
    return { project, root_directory: 'app' };
  }
  const account = required(env, 'CLOUDFLARE_ACCOUNT_ID');
  const worker = required(env, 'EZIL_WORKER_NAME');
  assert.match(account, /^[a-f0-9]{32}$/, 'Invalid Cloudflare account ID');
  assert.match(worker, /^[a-zA-Z0-9-]+$/, 'Invalid Worker name');
  const cfHeaders = { authorization: `Bearer ${required(env, 'CLOUDFLARE_API_TOKEN')}` };
  const cfBase = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${worker}`;
  const list = await request(`${cfBase}/deployments`, cfHeaders);
  assert.equal(list.success, true, 'Cloudflare deployment lookup failed');
  const deployments = list.result?.deployments;
  const versionId = deployments?.[0]?.versions?.[0]?.version_id;
  assert.ok(versionId, 'No active Worker version');
  const version = await request(`${cfBase}/versions/${encodeURIComponent(versionId)}`, cfHeaders);
  assert.equal(version.success, true, 'Cloudflare version lookup failed');
  const workerVersion = assertWorkerDeployment(deployments, version.result, sha);
  const workerURL = new URL(required(env, 'EZIL_E2E_WORKER'));
  assert.equal(workerURL.protocol, 'https:', 'Worker URL must use HTTPS');
  assert.equal(workerURL.href, `${workerURL.origin}/`, 'Worker URL must be an origin');
  const health = await request(`${workerURL.origin}/health`);
  assert.equal(health.ok, true, 'Worker health failed');
  assert.equal(health.build, 'ezil-os', 'Worker URL serves a different application');
  assert.ok(health.supportedDesktopModes?.includes('neko'), 'Worker does not support neko');
  const result = { worker_version: workerVersion, sha };
  if (mode === 'all') {
    const app = new URL(required(env, 'EZIL_E2E_APP'));
    assert.equal(app.protocol, 'https:');
    assert.equal(app.href, `${app.origin}/`, 'App URL must be an origin');
    assert.ok(app.hostname.endsWith('.vercel.app'), 'Use the deployment URL returned by Vercel');
    const target = required(env, 'EZIL_DEPLOY_TARGET');
    assert.ok(['preview', 'production'].includes(target), 'Invalid Vercel target');
    const team = required(env, 'VERCEL_ORG_ID');
    const url = new URL(`https://api.vercel.com/v13/deployments/${app.hostname}`);
    url.searchParams.set('teamId', team);
    const deployment = await request(url, {
      authorization: `Bearer ${required(env, 'VERCEL_TOKEN')}`,
    });
    result.vercel_deployment = assertVercelDeployment(deployment, {
      sha, app: app.origin, project: required(env, 'VERCEL_PROJECT_ID'), target,
    });
    result.url = app.origin;
    if (target === 'production') {
      assert.equal(workerURL.origin, 'https://api-desktop.ezil.org', 'Unexpected production Worker URL');
      const aliasURL = new URL('https://api.vercel.com/v13/deployments/ezil-os.vercel.app');
      aliasURL.searchParams.set('teamId', team);
      const alias = await request(aliasURL, { authorization: `Bearer ${env.VERCEL_TOKEN}` });
      const aliasId = assertVercelDeployment(alias, {
        sha, app: app.origin, project: env.VERCEL_PROJECT_ID, target,
      });
      assert.equal(aliasId, result.vercel_deployment, 'Canonical alias points at another deployment');
      result.canonical_url = 'https://ezil-os.vercel.app';
    }
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await verifyCloudDeployment(process.env, fetch, process.argv[2] ?? 'all');
    console.log(JSON.stringify(result));
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT,
        Object.entries(result).map(([key, value]) => `${key}=${value}\n`).join(''));
    }
  } catch (error) {
    console.error(`FAIL deployment identity: ${error.message}`);
    process.exitCode = 1;
  }
}
