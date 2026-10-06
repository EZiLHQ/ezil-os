import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { verifyCloudDeployment } from '../../e2e/verify-cloud-deployment.mjs';
import { pullCloudflareImage } from './release-state.mjs';

export function assertPreviewImage(application, images, env, cloudflareImage, testedImage) {
  assert.equal(env.EZIL_DEPLOY_TARGET, 'preview', 'Manual deployment must be a preview');
  assert.equal(env.EZIL_WORKER_NAME, 'ezil-os-worker-staging', 'Manual preview must use staging');
  assert.equal(application?.name, 'ezil-os-worker-staging-sandbox', 'Unexpected staging container');
  assert.equal(images.source, env.EZIL_DEPLOY_SHA, 'Tested source differs');
  assert.equal(images.tested, true, 'Candidate image was not tested');
  assert.match(images.desktop_digest, /^sha256:[a-f0-9]{64}$/);
  const image = application.configuration?.image;
  assert.ok(image?.startsWith(`registry.cloudflare.com/${env.CLOUDFLARE_ACCOUNT_ID}/`), 'Unexpected container registry');
  assert.match(image, /@sha256:[a-f0-9]{64}$/);
  for (const candidate of [cloudflareImage, testedImage]) {
    assert.equal(candidate.Config?.Labels?.['org.opencontainers.image.revision'], env.EZIL_DEPLOY_SHA,
      'Preview image source differs');
  }
  assert.ok(testedImage.RootFS?.Layers?.length, 'Tested image layers unavailable');
  assert.deepEqual(cloudflareImage.RootFS?.Layers, testedImage.RootFS.Layers, 'Preview image differs from tested image');
  return image;
}

export async function recordManualPreview(env = process.env) {
  assert.equal(env.EZIL_DEPLOY_TARGET, 'preview');
  assert.equal(env.EZIL_WORKER_NAME, 'ezil-os-worker-staging');
  const identity = await verifyCloudDeployment(env);
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/containers/applications`, {
    headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }, redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  assert.ok(response.ok, `Staging image identity HTTP ${response.status}`);
  const result = await response.json();
  assert.equal(result.success, true, 'Staging image readback failed');
  const application = result.result.find(a => a.name === 'ezil-os-worker-staging-sandbox');
  assert.ok(application?.configuration?.image, 'Staging image missing');
  const images = JSON.parse(fs.readFileSync('tested-images.json', 'utf8'));
  await pullCloudflareImage(application.configuration.image, env);
  try {
    execFileSync('docker', ['pull', `ghcr.io/ezilhq/ezil-os-desktop@${images.desktop_digest}`],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000 });
  } catch { throw new Error('Tested candidate image could not be pulled for comparison'); }
  const inspect = image => JSON.parse(execFileSync('docker', ['image', 'inspect', image], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))[0];
  const image = assertPreviewImage(application, images, env, inspect(application.configuration.image),
    inspect(`ghcr.io/ezilhq/ezil-os-desktop@${images.desktop_digest}`));
  const record = { ...identity, url: `${identity.url}/os`, cloudflare_image: image,
    tested_desktop_digest: images.desktop_digest, image_layers_verified: true, acceptance: 'pending_manual_test',
    automated_computer_operations: false };
  fs.writeFileSync('manual-preview.json', JSON.stringify(record, null, 2));
  console.log(JSON.stringify(record));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await recordManualPreview(); }
  catch (error) { console.error(`FAIL manual preview: ${error.message.split('\n')[0]}`); process.exitCode = 1; }
}
