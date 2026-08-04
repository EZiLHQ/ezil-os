/**
 * Unit tests for the operator safety-net reaper
 * (`scripts/reap-idle-sandboxes.mjs`).
 *
 * Three guards are explicitly MUTATION-PROVED (not just asserted) as part of
 * building this tool — see the task report for the revert/red/restore
 * transcript for each:
 *   1. dry-run is the default (`executeReap` never calls `terminate` unless
 *      `dryRun: false` is passed explicitly).
 *   2. the sandbox naming-convention filter (`isValidSandboxName` /
 *      `classifyInstances`) — a running instance with an invalid name is
 *      NEVER an orphan candidate.
 *   3. the max-count cap (`planReap`) — more than `maxCount` orphan
 *      candidates without `allowMore` refuses the WHOLE run rather than
 *      truncating it.
 *
 * `mintControlToken` is cross-checked against the Worker's OWN verifier
 * (`../src/hmac.ts`'s `verifyPreviewToken`) rather than merely re-asserting
 * the same hex math this file already computes — this is the test that would
 * actually catch a drift between the script's signing and what the Worker
 * accepts.
 */
import { describe, expect, it, mock } from 'bun:test';

import { verifyPreviewToken } from '../src/hmac';
import {
  classifyInstances,
  DEFAULT_MAX_AGE_MINUTES,
  DEFAULT_MAX_REAP_COUNT,
  executeReap,
  formatReport,
  isValidSandboxName,
  mintControlToken,
  parseArgs,
  parseInstancesOutput,
  planReap,
  SANDBOX_NAME_RE,
} from './reap-idle-sandboxes.mjs';

describe('SANDBOX_NAME_RE / isValidSandboxName', () => {
  it('accepts the shape deriveSandboxId()/deriveGuacamoleSandboxId() produce', () => {
    expect(isValidSandboxName('guac-cc5e88bdd651455d-1fa4417f4cd847c6')).toBe(true);
    expect(isValidSandboxName('guac-a-b')).toBe(true);
    expect(isValidSandboxName('guac-fx2chku10-fx2chkp10')).toBe(true);
  });

  it('refuses the live incident shape: an extra trailing label', () => {
    expect(isValidSandboxName('guac-cc5e88bdd651455d-1fa4417f4cd847c6-nekodesktop')).toBe(false);
  });

  it('refuses names with no guac- prefix', () => {
    expect(isValidSandboxName('exploit-probe-donotexist-1785489779')).toBe(false);
    expect(isValidSandboxName('testsandbox')).toBe(false);
    expect(isValidSandboxName('nosuchsandbox')).toBe(false);
  });

  it('refuses non-string input without throwing', () => {
    expect(isValidSandboxName(undefined)).toBe(false);
    expect(isValidSandboxName(null)).toBe(false);
    expect(isValidSandboxName(123)).toBe(false);
  });

  it('refuses a segment over 16 characters', () => {
    expect(isValidSandboxName(`guac-${'a'.repeat(17)}-abc`)).toBe(false);
    expect(SANDBOX_NAME_RE.test(`guac-abc-${'a'.repeat(17)}`)).toBe(false);
  });
});

describe('mintControlToken — cross-verified against the Worker\'s own verifier', () => {
  it('produces a token verifyPreviewToken() (worker/src/hmac.ts) accepts', async () => {
    const secret = 'test-secret-value';
    const token = mintControlToken(secret, Date.now());
    const result = await verifyPreviewToken(token, secret);
    expect(result.ok).toBe(true);
  });

  it('is rejected by verifyPreviewToken() when signed with a different secret', async () => {
    const token = mintControlToken('secret-a', Date.now());
    const result = await verifyPreviewToken(token, 'secret-b');
    expect(result.ok).toBe(false);
  });

  it('matches the documented format t=<ms>,v1=<hex>', () => {
    const token = mintControlToken('x', 1000);
    expect(token).toMatch(/^t=1000,v1=[0-9a-f]{64}$/);
  });
});

describe('parseInstancesOutput', () => {
  it('parses a clean JSON array', () => {
    const raw = '[{"name":"a","state":"running"}]';
    expect(parseInstancesOutput(raw)).toEqual([{ name: 'a', state: 'running' }]);
  });

  it('skips a wrangler update-notice line printed ahead of the JSON on stdout', () => {
    const raw =
      'There is a newer version of Wrangler available (current: 4.108.0, latest: 4.118.0).\n[{"name":"a","state":"running"}]';
    expect(parseInstancesOutput(raw)).toEqual([{ name: 'a', state: 'running' }]);
  });

  it('throws when no JSON array is present', () => {
    expect(() => parseInstancesOutput('not json at all')).toThrow(/wrangler_json_parse_failed/);
  });

  it('throws on malformed JSON after the bracket', () => {
    expect(() => parseInstancesOutput('[{"name":')).toThrow(/wrangler_json_parse_failed/);
  });

  it('throws when the parsed value is not an array', () => {
    expect(() => parseInstancesOutput('{"not":"an array"}')).toThrow(/expected a JSON array/);
  });
});

describe('classifyInstances', () => {
  const nowMs = Date.parse('2026-08-04T13:34:00Z');

  it('classifies the known orphan from the diagnosis exactly', () => {
    const [result] = classifyInstances(
      [
        {
          name: 'guac-cc5e88bdd651455d-1fa4417f4cd847c6',
          state: 'running',
          created: '2026-08-03T11:35:57.625999872Z',
        },
      ],
      { nowMs, maxAgeMinutes: 60 },
    );
    expect(result.orphaned).toBe(true);
    expect(result.reason).toBe('running_past_age_budget');
    expect(result.ageMinutes).toBeGreaterThan(60);
  });

  it('does not flag an inactive instance regardless of age', () => {
    const [result] = classifyInstances(
      [{ name: 'guac-a-b', state: 'inactive', created: '2020-01-01T00:00:00Z' }],
      { nowMs },
    );
    expect(result.orphaned).toBe(false);
    expect(result.reason).toBe('not_running');
  });

  it('does not flag a running instance still within the age budget', () => {
    const created = new Date(nowMs - 5 * 60_000).toISOString();
    const [result] = classifyInstances([{ name: 'guac-a-b', state: 'running', created }], {
      nowMs,
      maxAgeMinutes: 60,
    });
    expect(result.orphaned).toBe(false);
    expect(result.reason).toBe('running_within_age_budget');
  });

  it('refuses a running instance with an invalid name, however old', () => {
    const created = new Date(nowMs - 10 * 24 * 60 * 60_000).toISOString();
    const [result] = classifyInstances(
      [{ name: 'guac-a-b-nekodesktop', state: 'running', created }],
      { nowMs, maxAgeMinutes: 60 },
    );
    expect(result.orphaned).toBe(false);
    expect(result.reason).toBe('invalid_name_refused');
  });

  it('refuses rather than guesses on an unparseable timestamp', () => {
    const [result] = classifyInstances(
      [{ name: 'guac-a-b', state: 'running', created: 'not-a-date' }],
      { nowMs },
    );
    expect(result.orphaned).toBe(false);
    expect(result.reason).toBe('unparseable_created_timestamp');
    expect(result.ageMinutes).toBeNull();
  });

  it('defaults to a 60 minute age budget', () => {
    expect(DEFAULT_MAX_AGE_MINUTES).toBe(60);
  });
});

describe('planReap — the max-count refusal guard', () => {
  function orphan(name) {
    return { name, state: 'running', orphaned: true, reason: 'running_past_age_budget', ageMinutes: 999 };
  }

  it('defaults to a cap of 25', () => {
    expect(DEFAULT_MAX_REAP_COUNT).toBe(25);
  });

  it('allows a run at or under the cap', () => {
    const classified = Array.from({ length: 25 }, (_, i) => orphan(`guac-a${i}-b${i}`));
    const plan = planReap(classified, { maxCount: 25 });
    expect(plan.ok).toBe(true);
    expect(plan.candidates).toHaveLength(25);
  });

  it('refuses the WHOLE run when candidates exceed the cap, with no override', () => {
    const classified = Array.from({ length: 26 }, (_, i) => orphan(`guac-a${i}-b${i}`));
    const plan = planReap(classified, { maxCount: 25 });
    expect(plan.ok).toBe(false);
    expect(plan.candidates).toEqual([]);
    expect(plan.error).toMatch(/too_many_candidates/);
  });

  it('does NOT truncate to the first N — it refuses ALL of them', () => {
    const classified = Array.from({ length: 30 }, (_, i) => orphan(`guac-a${i}-b${i}`));
    const plan = planReap(classified, { maxCount: 25 });
    expect(plan.candidates.length).toBe(0);
  });

  it('honours --allow-more and returns every candidate', () => {
    const classified = Array.from({ length: 30 }, (_, i) => orphan(`guac-a${i}-b${i}`));
    const plan = planReap(classified, { maxCount: 25, allowMore: true });
    expect(plan.ok).toBe(true);
    expect(plan.candidates).toHaveLength(30);
  });

  it('never includes a refused (invalid-name) instance among candidates', () => {
    const classified = [
      orphan('guac-a-b'),
      { name: 'guac-a-b-nekodesktop', state: 'running', orphaned: false, reason: 'invalid_name_refused' },
    ];
    const plan = planReap(classified, { maxCount: 25 });
    expect(plan.candidates).toHaveLength(1);
    expect(plan.refused).toHaveLength(1);
    expect(plan.refused[0].name).toBe('guac-a-b-nekodesktop');
  });
});

describe('executeReap — the dry-run-by-default guard', () => {
  it('NEVER calls terminate when dryRun is true, even with real candidates', async () => {
    const terminate = mock(() => Promise.resolve({ ok: true, terminated: true }));
    const candidates = [{ name: 'guac-a-b' }, { name: 'guac-c-d' }];
    const results = await executeReap(candidates, { dryRun: true, terminate });
    expect(terminate).not.toHaveBeenCalled();
    expect(results).toEqual([
      { name: 'guac-a-b', action: 'would_terminate', executed: false },
      { name: 'guac-c-d', action: 'would_terminate', executed: false },
    ]);
  });

  it('calls terminate exactly once per candidate when dryRun is false', async () => {
    const terminate = mock((name) => Promise.resolve({ ok: true, terminated: true, name }));
    const candidates = [{ name: 'guac-a-b' }, { name: 'guac-c-d' }];
    const results = await executeReap(candidates, { dryRun: false, terminate });
    expect(terminate).toHaveBeenCalledTimes(2);
    expect(results.every((r) => r.executed)).toBe(true);
  });

  it('propagates the terminate outcome verbatim, success or failure', async () => {
    const terminate = mock(() => Promise.resolve({ ok: false, terminated: false, error: 'still_running' }));
    const results = await executeReap([{ name: 'guac-a-b' }], { dryRun: false, terminate });
    expect(results[0].outcome).toEqual({ ok: false, terminated: false, error: 'still_running' });
  });
});

describe('parseArgs', () => {
  it('defaults to dry-run with no flags', () => {
    const args = parseArgs([]);
    expect(args.dryRun).toBe(true);
    expect(args.allowMore).toBe(false);
    expect(args.maxAgeMinutes).toBe(DEFAULT_MAX_AGE_MINUTES);
    expect(args.maxCount).toBe(DEFAULT_MAX_REAP_COUNT);
  });

  it('--confirm turns off dry-run', () => {
    expect(parseArgs(['--confirm']).dryRun).toBe(false);
  });

  it('--dry-run after --confirm still forces dry-run (last one wins, but presence is what tests care about)', () => {
    expect(parseArgs(['--confirm', '--dry-run']).dryRun).toBe(true);
  });

  it('parses --app-id, --worker-url, --only', () => {
    const args = parseArgs(['--app-id', 'abc123', '--worker-url', 'https://x.test', '--only', 'guac-a-b']);
    expect(args.appId).toBe('abc123');
    expect(args.workerUrl).toBe('https://x.test');
    expect(args.only).toBe('guac-a-b');
  });

  it('parses numeric flags and ignores garbage values', () => {
    expect(parseArgs(['--max-age-minutes', '120']).maxAgeMinutes).toBe(120);
    expect(parseArgs(['--max-count', '10']).maxCount).toBe(10);
    // Non-numeric value: guard keeps the default rather than producing NaN.
    expect(parseArgs(['--max-age-minutes', 'not-a-number']).maxAgeMinutes).toBe(DEFAULT_MAX_AGE_MINUTES);
  });

  it('--allow-more and --json are boolean switches', () => {
    const args = parseArgs(['--allow-more', '--json']);
    expect(args.allowMore).toBe(true);
    expect(args.json).toBe(true);
  });
});

describe('formatReport', () => {
  it('never includes the word "secret" or any token-shaped string', () => {
    const classified = classifyInstances(
      [{ name: 'guac-a-b', state: 'running', created: new Date(Date.now() - 999 * 60_000).toISOString() }],
      {},
    );
    const plan = planReap(classified, {});
    const report = formatReport(classified, plan, { maxAgeMinutes: 60, dryRun: true });
    expect(report).not.toMatch(/t=\d+,v1=[0-9a-f]+/);
    expect(report.toLowerCase()).not.toContain('secret');
  });

  it('reports a refused invalid-name running instance separately from candidates', () => {
    const classified = classifyInstances(
      [{ name: 'guac-a-b-nekodesktop', state: 'running', created: new Date(Date.now() - 999 * 60_000).toISOString() }],
      {},
    );
    const plan = planReap(classified, {});
    const report = formatReport(classified, plan, { maxAgeMinutes: 60, dryRun: true });
    expect(report).toContain('Refused');
    expect(report).toContain('guac-a-b-nekodesktop');
  });
});
