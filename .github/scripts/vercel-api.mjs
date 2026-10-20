// Team-scoped mutations with verified readback; never expose provider errors.
import { pathToFileURL } from 'node:url';

const deploymentIdPattern = /^dpl_[a-zA-Z0-9]+$/;
const hostnamePattern = /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/;
const productionAlias = 'os.ezil.work';

function requireValue(condition) {
  if (!condition) throw new Error('Vercel API validation failed');
}

function client(env, fetchImpl) {
  requireValue(typeof env.VERCEL_TOKEN === 'string' && env.VERCEL_TOKEN.trim());
  requireValue(/^team_[a-zA-Z0-9]+$/.test(env.VERCEL_ORG_ID ?? ''));
  requireValue(/^prj_[a-zA-Z0-9]+$/.test(env.VERCEL_PROJECT_ID ?? ''));
  return async (pathname, { method = 'GET', body, statuses = [200], readJson = true } = {}) => {
    const response = await fetchImpl(`https://api.vercel.com${pathname}?teamId=${encodeURIComponent(env.VERCEL_ORG_ID)}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${env.VERCEL_TOKEN}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    requireValue(!response.redirected && statuses.includes(response.status));
    // Mutation responses can contain configuration; only read identity responses.
    return readJson ? response.json() : undefined;
  };
}

export async function aliasDeployment(deploymentUrlOrId, alias, env = process.env, { fetchImpl = fetch } = {}) {
  try {
    const request = client(env, fetchImpl);
    requireValue(typeof deploymentUrlOrId === 'string' && typeof alias === 'string');
    const reference = deploymentUrlOrId.replace(/^https:\/\//, '').replace(/\/$/, '');
    requireValue(deploymentIdPattern.test(reference) || hostnamePattern.test(reference));
    requireValue(hostnamePattern.test(alias));
    const deployment = await request(`/v13/deployments/${encodeURIComponent(reference)}`);
    requireValue(deploymentIdPattern.test(deployment?.id ?? ''));
    requireValue(deployment.projectId === env.VERCEL_PROJECT_ID && deployment.readyState === 'READY');
    if (deploymentIdPattern.test(reference)) requireValue(deployment.id === reference);
    await request(`/v2/deployments/${encodeURIComponent(deployment.id)}/aliases`, {
      method: 'POST', body: { alias }, statuses: [200, 201], readJson: false,
    });
    const readback = await request(`/v4/aliases/${encodeURIComponent(alias)}`);
    requireValue((readback?.deploymentId ?? readback?.deployment?.id) === deployment.id);
    if (readback?.deployment?.id !== undefined) requireValue(readback.deployment.id === deployment.id);
    return deployment.id;
  } catch {
    throw new Error('Vercel alias failed');
  }
}

export async function promoteDeployment(deploymentId, env = process.env, {
  fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  try {
    const request = client(env, fetchImpl);
    requireValue(typeof deploymentId === 'string' && deploymentIdPattern.test(deploymentId));
    await request(`/v10/projects/${encodeURIComponent(env.VERCEL_PROJECT_ID)}/promote/${encodeURIComponent(deploymentId)}`, {
      // The endpoint requires a JSON body; the Vercel CLI sends {} too.
      method: 'POST', body: {}, statuses: [200, 201, 202], readJson: false,
    });
    for (let attempt = 0; attempt < 12; attempt++) {
      const deployment = await request(`/v13/deployments/${productionAlias}`);
      if (deployment?.id === deploymentId && deployment.projectId === env.VERCEL_PROJECT_ID && deployment.readyState === 'READY') {
        return deploymentId;
      }
      if (attempt < 11) await sleep(5000);
    }
    throw new Error('Vercel production readback timed out');
  } catch {
    throw new Error('Vercel promotion failed');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'alias' && args.length === 2) await aliasDeployment(...args);
    else if (command === 'promote' && args.length === 1) await promoteDeployment(args[0]);
    else throw new Error('Invalid Vercel API command');
  } catch {
    console.error('Vercel API command failed');
    process.exitCode = 1;
  }
}
