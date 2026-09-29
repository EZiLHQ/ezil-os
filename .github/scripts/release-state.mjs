// Provider identity and bounded recovery. Never persist raw provider objects or configuration.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
export const canonical = 'https://ezil-os.vercel.app';
export async function readState(env, fetchImpl = fetch) {
  for (const key of ['CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_API_TOKEN','VERCEL_TOKEN','VERCEL_ORG_ID','VERCEL_PROJECT_ID']) assert.ok(env[key], `Missing ${key}`);
  const request = async (url, token) => {
    const r = await fetchImpl(url, {headers: {authorization: `Bearer ${token}`}, redirect:'error', signal:AbortSignal.timeout(15000)});
    assert.ok(r.ok, `Provider readback HTTP ${r.status}`);
    return r.json();
  };
  const cf = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`;
  const worker = `${cf}/workers/scripts/ezil-os-worker`;
  const list = await request(`${worker}/deployments`, env.CLOUDFLARE_API_TOKEN);
  assert.equal(list.success, true);
  const active = list.result?.deployments?.[0];
  assert.equal(active?.versions?.length, 1, 'Split Worker deployment');
  assert.equal(active.versions[0].percentage, 100);
  const version = await request(`${worker}/versions/${encodeURIComponent(active.versions[0].version_id)}`, env.CLOUDFLARE_API_TOKEN);
  assert.equal(version.success, true);
  const app = await request(`https://api.vercel.com/v13/deployments/ezil-os.vercel.app?teamId=${encodeURIComponent(env.VERCEL_ORG_ID)}`, env.VERCEL_TOKEN);
  assert.equal(app.projectId, env.VERCEL_PROJECT_ID);
  assert.equal(app.target, 'production');
  assert.equal(app.readyState, 'READY');
  assert.ok(app.id);
  // Wrangler 4.128 uses the Containers applications API. Whitelist only public identity.
  const containers = await request(`${cf}/containers/applications`, env.CLOUDFLARE_API_TOKEN);
  const apps = containers.result ?? containers;
  assert.ok(Array.isArray(apps), 'Expected Containers applications list');
  const container = apps.find(a => a.name === 'ezil-os-worker-sandbox');
  assert.ok(container?.configuration?.image, 'Production container image missing');
  return {
    worker_version: active.versions[0].version_id,
    worker_deployment: active.id ?? null,
    worker_source: version.result.annotations?.['workers/message']?.match(/^git:([a-f0-9]{40})$/)?.[1] ?? null,
    vercel_deployment: app.id, vercel_source: app.meta?.githubCommitSha ?? null,
    cloudflare_container: {id:container.id, image:container.configuration.image,
      digest:container.configuration.image.match(/@(sha256:[a-f0-9]{64})$/)?.[1] ?? null},
  };
}
export async function pullCloudflareImage(image, env, fetchImpl = fetch, exec = execFileSync) {
  assert.match(env.CLOUDFLARE_ACCOUNT_ID, /^[a-f0-9]{32}$/);
  assert.ok(image.startsWith(`registry.cloudflare.com/${env.CLOUDFLARE_ACCOUNT_ID}/`));
  assert.match(image, /@sha256:[a-f0-9]{64}$/);
  const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/containers/registries/registry.cloudflare.com/credentials`, {
    method:'POST', headers:{authorization:`Bearer ${env.CLOUDFLARE_API_TOKEN}`,'content-type':'application/json'},
    body:JSON.stringify({expiration_minutes:15,permissions:['pull']}), redirect:'error',signal:AbortSignal.timeout(15000),
  });
  assert.ok(response.ok, `Container registry credential HTTP ${response.status}`);
  const body = await response.json();
  const credentials = body.result ?? body;
  assert.ok(credentials.username && credentials.password, 'Missing scoped registry credentials');
  const config = fs.mkdtempSync(path.join(os.tmpdir(),'ezil-registry-'));
  try {
    exec('docker',['--config',config,'login','registry.cloudflare.com','--username',credentials.username,'--password-stdin'],
      {input:credentials.password,stdio:['pipe','pipe','pipe']});
    exec('docker',['--config',config,'pull',image],{stdio:['ignore','pipe','pipe'],timeout:600000});
  } catch { throw new Error('Cannot pull the deployed Cloudflare image for layer verification'); }
  finally { fs.rmSync(config,{recursive:true,force:true}); }
}
export function assertRollbackOwner(previous, state, sha) {
  assert.ok(state.worker_version === previous.worker_version || state.worker_source === sha, 'Another Worker release owns production');
  assert.ok(state.vercel_deployment === previous.vercel_deployment || state.vercel_source === sha, 'Another Vercel release owns production');
}
export async function restoreContainer(previous, state, env, fetchImpl = fetch) {
  assertRollbackOwner(previous, state, env.EZIL_DEPLOY_SHA);
  assert.equal(state.cloudflare_container.id, previous.cloudflare_container.id, 'Container application was replaced');
  const image = previous.cloudflare_container.image;
  assert.match(image, /@sha256:[a-f0-9]{64}$/, 'Previous container must have an immutable digest');
  if (image === state.cloudflare_container.image) return {image,status:'unchanged',rollout:null};
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/containers/applications/${encodeURIComponent(previous.cloudflare_container.id)}`;
  const request = async (url, method = 'GET', body) => {
    const response = await fetchImpl(url, {method, redirect:'error',signal:AbortSignal.timeout(15000),
      headers:{authorization:`Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'content-type':'application/json'},
      ...(body ? {body:JSON.stringify(body)} : {})});
    assert.ok(response.ok, `Container recovery HTTP ${response.status}; restore previous-release.json image manually`);
    const value = await response.json();
    assert.notEqual(value.success, false, 'Container recovery API rejected request');
    return value.result ?? value;
  };
  // Same modify + rollout contract used by Wrangler 4.128.0. Keep live configuration
  // in memory only; restore just the image, never database/resource configuration.
  const current = await request(base);
  assert.equal(current.id, previous.cloudflare_container.id);
  assert.equal(current.configuration.image, state.cloudflare_container.image, 'Container changed after recovery admission');
  const configuration = {...current.configuration, image};
  await request(base, 'PATCH', {configuration});
  const rollout = await request(`${base}/rollouts`, 'POST', {description:`Rollback ${env.EZIL_DEPLOY_SHA}`,
    strategy:'rolling',target_configuration:configuration,step_percentage:100,kind:'full_auto'});
  assert.ok(rollout.id, 'Missing rollback rollout ID');
  for (let attempt = 0; attempt < 60; attempt++) {
    const status = await request(`${base}/rollouts/${encodeURIComponent(rollout.id)}`);
    if (status.status === 'completed') return {rollout:rollout.id,image,status:'completed'};
    assert.ok(!['failed','cancelled','reverted','replaced'].includes(status.status), 'Container rollback rollout failed');
    await new Promise(resolve => setTimeout(resolve,5000));
  }
  throw new Error('Container rollback rollout did not complete within five minutes');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  const env = process.env;
  if (mode === 'prepare') {
    const images = JSON.parse(fs.readFileSync('tested-images.json'));
    assert.equal(images.source, env.EZIL_DEPLOY_SHA);
    assert.equal(images.tested, true);
    assert.match(images.desktop_digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(images.desktop, `ghcr.io/ezilhq/ezil-os-desktop:sha-${env.EZIL_DEPLOY_SHA}`);
    // Wrangler produces a separate Cloudflare registry manifest FROM tested GHCR bytes.
    fs.writeFileSync('worker/Dockerfile.release', `FROM ghcr.io/ezilhq/ezil-os-desktop@${images.desktop_digest}\nLABEL org.opencontainers.image.revision="${env.EZIL_DEPLOY_SHA}"\n`);
    const config = fs.readFileSync('worker/wrangler.toml','utf8');
    assert.ok(config.includes('image = "./Dockerfile"'));
    fs.writeFileSync('worker/wrangler.toml', config.replace('image = "./Dockerfile"', 'image = "./Dockerfile.release"'));
  } else {
    const state = await readState(env);
    if (mode === 'capture') fs.writeFileSync('previous-release.json', JSON.stringify(state,null,2));
    else if (mode === 'record') {
      assert.equal(state.worker_source, env.EZIL_DEPLOY_SHA);
      assert.equal(state.vercel_source, env.EZIL_DEPLOY_SHA);
      assert.ok(state.cloudflare_container.digest, 'Cloudflare container digest missing');
      const images = JSON.parse(fs.readFileSync('tested-images.json'));
      const inspect = ref => JSON.parse(execFileSync('docker', ['image','inspect',ref], {encoding:'utf8'}))[0];
      await pullCloudflareImage(state.cloudflare_container.image, env);
      const cfImage = inspect(state.cloudflare_container.image);
      const ghcrImage = inspect(`ghcr.io/ezilhq/ezil-os-desktop@${images.desktop_digest}`);
      assert.equal(cfImage.Config.Labels?.['org.opencontainers.image.revision'], env.EZIL_DEPLOY_SHA,
        'Cloudflare container is not built from this source');
      assert.deepEqual(cfImage.RootFS.Layers, ghcrImage.RootFS.Layers,
        'Cloudflare container layers differ from the tested GHCR desktop');
      state.cloudflare_container.ghcr_layers_verified = true;
      fs.writeFileSync('production-release.json', JSON.stringify({source:env.EZIL_DEPLOY_SHA,
        run:env.GITHUB_RUN_ID, canonical, returned_url:env.EZIL_E2E_APP,
        ghcr:JSON.parse(fs.readFileSync('tested-images.json')), ...state},null,2));
    } else if (mode === 'rollback-guard') {
      const previous = JSON.parse(fs.readFileSync('previous-release.json'));
      assertRollbackOwner(previous, state, env.EZIL_DEPLOY_SHA);
    } else if (mode === 'container-rollback') {
      const previous = JSON.parse(fs.readFileSync('previous-release.json'));
      const result = await restoreContainer(previous,state,env);
      fs.writeFileSync('container-rollback.json',JSON.stringify(result,null,2));
    } else if (mode === 'rollback-check') {
      const previous = JSON.parse(fs.readFileSync('previous-release.json'));
      fs.writeFileSync('rollback-state.json',JSON.stringify(state,null,2));
      assert.equal(state.worker_version, previous.worker_version, 'Worker rollback incomplete');
      assert.equal(state.vercel_deployment, previous.vercel_deployment, 'Vercel rollback incomplete');
      assert.equal(state.cloudflare_container.image, previous.cloudflare_container.image,
        'Worker rollback does not restore Containers; operator must restore previous-release.json container image. Never reverse SQL.');
    } else throw new Error('Unknown release-state mode');
  }
}
