/** A successful Worker deployment can precede the container rollout. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export async function awaitContainerRollout(env = process.env, {
  fetchImpl = fetch, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  budgetMs = 10 * 60000, pollMs = 5000,
} = {}) {
  assert.match(env.CLOUDFLARE_ACCOUNT_ID ?? '', /^[a-f0-9]{32}$/);
  assert.ok(env.CLOUDFLARE_API_TOKEN, 'Missing Cloudflare rollout credentials');
  assert.ok(['ezil-os-worker', 'ezil-os-worker-staging'].includes(env.EZIL_WORKER_NAME), 'Unexpected container application');
  assert.ok(budgetMs > 0 && pollMs > 0);
  const started = now();
  const deadline = started + budgetMs;
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/containers`;
  const read = async path => {
    assert.ok(now() < deadline, 'Container rollout did not complete within its budget');
    const response = await fetchImpl(base + path, {
      headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }, redirect: 'error',
      signal: AbortSignal.timeout(Math.max(1, Math.min(15000, deadline - now()))),
    });
    assert.ok(response.ok, `Container rollout read HTTP ${response.status}`);
    const body = await response.json();
    assert.notEqual(body.success, false, 'Container rollout read failed');
    return body.result ?? body;
  };
  const applications = await read('/applications');
  assert.ok(Array.isArray(applications), 'Container applications unavailable');
  const initial = applications.find(a => a.name === `${env.EZIL_WORKER_NAME}-sandbox`);
  assert.ok(initial?.id && Number.isInteger(initial.version), 'Container application identity missing');
  const image = initial.configuration?.image;
  const digest = image?.match(/@sha256:([a-f0-9]{64})$/)?.[0]?.slice(1);
  assert.ok(digest, 'Container immutable image missing');
  let rolloutId;
  for (;;) {
    const application = await read(`/applications/${encodeURIComponent(initial.id)}`);
    assert.ok(application.id === initial.id && application.version === initial.version
      && application.configuration?.image === image, 'Container application changed during rollout verification');
    const rollouts = await read(`/applications/${encodeURIComponent(initial.id)}/rollouts?limit=10`);
    assert.ok(Array.isArray(rollouts) && rollouts.length, 'Container rollout evidence missing');
    const latest = [...rollouts].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
    assert.ok(latest.id && latest.target_version === initial.version
      && latest.target_configuration?.image === image, 'Latest rollout does not target this container image');
    rolloutId ??= latest.id;
    assert.equal(latest.id, rolloutId, 'Container rollout changed during verification');
    assert.ok(!['failed', 'cancelled', 'canceled', 'reverted', 'replaced'].includes(latest.status), 'Container rollout failed');
    if (latest.status === 'completed') {
      assert.ok(latest.steps?.length && latest.steps.every(step => step.status === 'completed'), 'Container rollout steps incomplete');
      return { application: initial.name, version: initial.version, image: digest,
        rollout: rolloutId, status: 'completed', elapsedMs: now() - started };
    }
    assert.ok(['progressing', 'pending'].includes(latest.status), 'Unexpected container rollout status');
    assert.ok(now() < deadline, 'Container rollout did not complete within its budget');
    await sleep(Math.min(pollMs, deadline - now()));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const evidence = await awaitContainerRollout();
    mkdirSync('hosted-continuity-evidence', { recursive: true });
    writeFileSync('hosted-continuity-evidence/container-rollout.json', JSON.stringify(evidence, null, 2));
    console.log('PASS container rollout completed');
  } catch {
    // Provider failures can include credentials or full configuration.
    console.error('FAIL container rollout verification');
    process.exitCode = 1;
  }
}
