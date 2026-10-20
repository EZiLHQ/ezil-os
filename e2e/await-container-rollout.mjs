/** A successful Worker deployment can precede the container rollout. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export async function awaitContainerRollout(env = process.env, {
  fetchImpl = fetch, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  budgetMs = 10 * 60000, pollMs = 5000,
  expectedDigest = env.EZIL_EXPECTED_CONTAINER_DIGEST,
  previousVersion = env.EZIL_PREVIOUS_CONTAINER_VERSION,
} = {}) {
  assert.match(env.CLOUDFLARE_ACCOUNT_ID ?? '', /^[a-f0-9]{32}$/);
  assert.ok(env.CLOUDFLARE_API_TOKEN, 'Missing Cloudflare rollout credentials');
  assert.ok(['ezil-os-worker', 'ezil-os-worker-staging'].includes(env.EZIL_WORKER_NAME), 'Unexpected container application');
  assert.ok(budgetMs > 0 && pollMs > 0);
  const fenced = expectedDigest !== undefined || previousVersion !== undefined;
  if (fenced) {
    assert.match(expectedDigest ?? '', /^sha256:[a-f0-9]{64}$/, 'Expected candidate image digest missing');
    assert.match(String(previousVersion ?? ''), /^\d+$/, 'Pre-deploy container version missing');
    previousVersion = Number(previousVersion);
    assert.ok(Number.isSafeInteger(previousVersion), 'Invalid pre-deploy container version');
  }
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
  if (env.EZIL_CONTAINER_APPLICATION_ID) assert.equal(initial.id, env.EZIL_CONTAINER_APPLICATION_ID, 'Container application replaced since capture');
  let target, reachedTarget = false;
  for (;;) {
    const application = await read(`/applications/${encodeURIComponent(initial.id)}`);
    assert.equal(application.id, initial.id, 'Container application changed during rollout verification');
    const rollouts = await read(`/applications/${encodeURIComponent(initial.id)}/rollouts?limit=10`);
    assert.ok(Array.isArray(rollouts), 'Container rollout evidence missing');
    // The provider may still expose only the completed pre-deploy rollout.
    // Do not select it, even when a rebuild happens to produce the same digest.
    if (fenced && !target && (!rollouts.length || rollouts.every(r => Number.isInteger(r.target_version) && r.target_version <= previousVersion))) {
      assert.ok(application.version <= previousVersion, 'Container advanced without new rollout evidence');
      await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
      continue;
    }
    assert.ok(rollouts.length, 'Container rollout evidence missing');
    const latest = [...rollouts].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
    const image = latest.target_configuration?.image;
    const digest = image?.match(/@sha256:([a-f0-9]{64})$/)?.[0]?.slice(1);
    assert.ok(latest.id && Number.isInteger(latest.target_version) && digest, 'Container rollout target identity missing');
    if (fenced) {
      assert.ok(latest.target_version > previousVersion, 'Container rollout predates this deployment');
      assert.equal(digest, expectedDigest, 'Container rollout does not target the candidate image digest');
    }
    target ??= { id: latest.id, version: latest.target_version, image, digest };
    assert.ok(latest.id === target.id && latest.target_version === target.version
      && image === target.image, 'Container rollout changed during verification');
    // During rollout, application GET retains the current configuration until
    // every step completes. Fence both states instead of treating advancement
    // to the selected target as an unrelated deployment.
    const atTarget = application.version === target.version && application.configuration?.image === target.image;
    const atCurrent = !reachedTarget && application.version === latest.current_version
      && application.configuration?.image === latest.current_configuration?.image;
    assert.ok(atTarget || atCurrent, 'Container application changed during rollout verification');
    reachedTarget ||= atTarget;
    assert.ok(!['failed', 'cancelled', 'canceled', 'reverted', 'replaced'].includes(latest.status), 'Container rollout failed');
    if (latest.status === 'completed' && atTarget) {
      assert.ok(latest.steps?.length && latest.steps.every(step => step.status === 'completed'), 'Container rollout steps incomplete');
      return { application: initial.name, version: target.version, image: target.digest,
        rollout: target.id, status: 'completed', elapsedMs: now() - started };
    }
    assert.ok(['progressing', 'pending', 'completed'].includes(latest.status), 'Unexpected container rollout status');
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
