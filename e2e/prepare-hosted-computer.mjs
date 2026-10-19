/** Stop only the designated test computer after rollout, before cold acceptance. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { cleanupHostedComputer } from './cleanup-hosted-computer.mjs';
import { resetTestRuntime } from './reset-test-runtime.mjs';

export async function prepareHostedComputer(env = process.env, { cleanup = cleanupHostedComputer, reset = resetTestRuntime } = {}) {
  // Staging acceptance passes its scoped secrets to this step; production does not.
  const resetting = Boolean(env.EZIL_ACCEPTANCE_SANDBOX || env.EZIL_ACCEPTANCE_HMAC_SECRET);
  if (resetting) {
    for (const key of ['EZIL_ACCEPTANCE_SANDBOX', 'EZIL_ACCEPTANCE_HMAC_SECRET', 'EZIL_E2E_WORKER']) {
      if (!env[key]) return { ok: false, phase: 'prerequisites', missingPrerequisite: key, failure: 'hosted_computer_cleanup_failed' };
    }
  }
  const evidence = await cleanup(env, undefined, undefined, resetting ? { expectSandbox: env.EZIL_ACCEPTANCE_SANDBOX } : {});
  if (!evidence.ok || !resetting) return evidence;
  evidence.phase = 'runtime_reset';
  try {
    await reset({ worker: env.EZIL_E2E_WORKER, sandbox: env.EZIL_ACCEPTANCE_SANDBOX, secret: env.EZIL_ACCEPTANCE_HMAC_SECRET });
    evidence.runtimeReset = true;
    evidence.phase = 'complete';
  } catch (error) {
    // The first rollout of the reset reaches an object still on the previous
    // revision, which cannot reset itself; the reset is a mitigation, not a gate.
    if (error?.code === 'acceptance_reset_unsupported') {
      evidence.runtimeReset = false; evidence.resetSkipped = 'unsupported'; evidence.phase = 'complete';
      return evidence;
    }
    // Fixed codes only: never a URL, a header or the sandbox name.
    evidence.ok = false;
    evidence.failure = 'test_runtime_reset_failed';
    if (typeof error?.code === 'string' && /^[a-z_0-9]{1,40}$/.test(error.code)) evidence.resetError = error.code;
  }
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const evidence = await prepareHostedComputer();
  mkdirSync('hosted-continuity-evidence', { recursive: true });
  writeFileSync('hosted-continuity-evidence/initial-stop.json', JSON.stringify(evidence, null, 2));
  console.log(evidence.ok ? 'PASS isolated computer prepared for cold acceptance' : 'FAIL isolated computer preparation');
  if (!evidence.ok) process.exitCode = 1;
}
