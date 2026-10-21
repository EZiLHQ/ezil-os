import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateResults, classifyHost, createRedactor, guardPlaywright,
  isAIAccountError, parseResources, redactEvidence, terminalBlock } from './billing-staging-journey.mjs';

const credentials = { email: 'qa+staging@example.test', password: 'P@ss word!"\\$?&' };

test('redaction removes both credentials, repeats, case variants and URL encodings', () => {
  const redact = createRedactor(credentials);
  for (const secret of Object.values(credentials)) {
    const variants = [secret, secret.toUpperCase(), encodeURIComponent(secret), encodeURI(secret),
      encodeURIComponent(encodeURIComponent(secret)),
      new URLSearchParams({ value: secret }).toString().slice(6),
      JSON.stringify(secret).slice(1, -1),
      encodeURIComponent(secret).replace(/%[\dA-F]{2}/g, text => text.toLowerCase())];
    for (const value of variants) assert.equal(redact(`before ${value} / ${value} after`), 'before [REDACTED] / [REDACTED] after');
  }
  assert.equal(createRedactor()('ordinary text'), 'ordinary text');
  assert.equal(redact('No credentials here'), 'No credentials here');
});

test('redaction covers error messages, nested evidence and overlapping secrets', () => {
  const redact = createRedactor(credentials);
  assert.equal(redact(new Error(`fill(${credentials.password}) ${credentials.email}`)), 'fill([REDACTED]) [REDACTED]');
  const result = redactEvidence({ text: credentials.email, nested: [credentials.password, { reason: new Error(credentials.email) }] }, redact);
  assert.deepEqual(result, { text: '[REDACTED]', nested: ['[REDACTED]', { reason: '[REDACTED]' }] });
  assert.equal(createRedactor({ email: 'abcdef', password: 'abc' })('abcdef abc'), '[REDACTED] [REDACTED]');
});

test('guard redacts synchronous locator failures and async fill/keyboard/frame errors', async () => {
  const leak = `${credentials.email} ${encodeURIComponent(credentials.password)}`;
  const page = guardPlaywright({
    locator() { return { first() { return this; }, async fill() { throw new Error(leak); } }; },
    getByRole() { throw new Error(leak); },
    keyboard: { async press() { throw new Error(leak); } },
    frames() { return [{ locator() { throw new Error(leak); } }]; },
  }, createRedactor(credentials));
  const safe = error => {
    assert.equal(error.message, '[REDACTED] [REDACTED]');
    assert.equal(error.cause, undefined);
    assert.ok(!error.stack.includes(credentials.email));
    return true;
  };
  assert.throws(() => page.getByRole('button'), safe);
  assert.throws(() => page.frames()[0].locator('body'), safe);
  await assert.rejects(page.locator('input').first().fill(credentials.password), safe);
  await assert.rejects(page.keyboard.press('Enter'), safe);
});

test('guard preserves locator identity in arguments and ordinary result data', async () => {
  class Locator { filter({ has }) { assert.equal(has, this); return this; } async count() { return 2; } }
  const guarded = guardPlaywright(new Locator(), createRedactor(credentials));
  assert.equal(await guarded.filter({ has: guarded }).count(), 2);
  const data = { sha: '123456', ok: true };
  assert.deepEqual(await guardPlaywright({ async json() { return data; } }, createRedactor()).json(), data);
});

test('host classification uses hostname only; Mumbai is inferred only for AWS', () => {
  assert.deepEqual(classifyHost('https://8080-box-nekodesktop.ezil.work/?secret=hidden'),
    { host: '8080-box-nekodesktop.ezil.work', hostClass: 'cloudflare', mumbai: null });
  assert.deepEqual(classifyHost('aws-box-aws.ezil.work'),
    { host: 'aws-box-aws.ezil.work', hostClass: 'aws', mumbai: true });
  assert.equal(classifyHost('https://AWS-BOX-AWS.EZIL.WORK').hostClass, 'aws');
  assert.equal(classifyHost('https://example.test/nekodesktop?x=-aws.').hostClass, 'unknown');
  assert.equal(classifyHost('https://nekodesktop@unknown.example/').hostClass, 'unknown');
  assert.equal(classifyHost('https://8443-guac-61ee4784407c4a77-03f419f2908f4fe8-code.ezil.work/').hostClass, 'cloudflare');
  assert.equal(classifyHost('https://guac-61ee-code.ezil.work/').hostClass, 'cloudflare');
  assert.equal(classifyHost('https://aws-8443-guac-61ee-03f4-aws.ezil.work/').hostClass, 'aws');
  assert.equal(classifyHost('about:blank').hostClass, 'unknown');
  assert.equal(classifyHost('not a host').hostClass, 'unknown');
});

test('parse free -m plus nproc with CRLF and terminal formatting', () => {
  const text = '$ free -m | head -2 && nproc\r\n              total used free shared buff/cache available\r\n'
    + '\x1b[32mMem:           15872  2080  1700  0  12092  13120\x1b[0m\r\n4\r\nuser@host:~$';
  assert.deepEqual(parseResources(text), { ramMiB: 15872, vcpus: 4 });
  assert.deepEqual(parseResources('99\nMem: 7680 123 7000 0 0 0\nSwap: 0 0 0\n2\nE2E_RC=0'), { ramMiB: 7680, vcpus: 2 });
});

test('resource parser does not invent missing RAM or CPU from commands/prompts', () => {
  assert.deepEqual(parseResources('echo free -m && nproc\n4'), { ramMiB: null, vcpus: null });
  assert.deepEqual(parseResources('Mem: 2048 40 2000\nuser@host:~$ 8'), { ramMiB: 2048, vcpus: null });
  assert.deepEqual(parseResources('Mem: 0 0 0\n0'), { ramMiB: null, vcpus: null });
  assert.deepEqual(parseResources('Mem: 9999999999999999999 0 0\n9999999999999999999'), { ramMiB: null, vcpus: null });
});

test('aggregation keeps all statuses, durations and explicit skip reasons', () => {
  const steps = [{ id: 'health', status: 'PASS', ms: 12, evidence: { sha: 'abc' } },
    { id: 'code', status: 'FAIL', ms: 100 }, { id: 'chat', status: 'SKIP', reason: 'no_ai_account', ms: 3 }];
  assert.deepEqual(aggregateResults(steps), { status: 'FAIL', counts: { PASS: 1, FAIL: 1, SKIP: 1 },
    statuses: { health: 'PASS', code: 'FAIL', chat: 'SKIP:no_ai_account' }, ms: 115 });
  assert.equal(steps[0].evidence.sha, 'abc');
  assert.equal(aggregateResults([]).status, 'SKIP');
  assert.equal(aggregateResults(steps.slice(0, 1)).status, 'PASS');
  assert.equal(aggregateResults([steps[2]]).status, 'SKIP');
});

test('aggregation rejects invalid durations, statuses and duplicate step ids', () => {
  for (const step of [{ id: 'a', status: 'OK', ms: 1 }, { id: 'a', status: 'PASS', ms: -1 },
    { id: 'a', status: 'PASS', ms: NaN }]) assert.throws(() => aggregateResults([step]));
  assert.throws(() => aggregateResults([{ id: 'a', status: 'PASS', ms: 1 }, { id: 'a', status: 'FAIL', ms: 1 }]));
});

test('desktop diagnostic failures remain results alongside later journey steps', () => {
  const result = aggregateResults([
    { id: 'placement', status: 'PASS', ms: 10 }, { id: 'latency', status: 'FAIL', ms: 20 },
    { id: 'typing', status: 'FAIL', ms: 30 }, { id: 'clipboard', status: 'SKIP', reason: 'sidecar_has_no_omnibox_text_readback', ms: 40 },
    { id: 'fonts', status: 'SKIP', reason: 'glyph_rendering_requires_visual_review', ms: 50 },
    { id: 'persistence', status: 'PASS', ms: 60 },
  ]);
  assert.deepEqual(result.counts, { PASS: 2, FAIL: 2, SKIP: 2 });
  assert.equal(result.statuses.persistence, 'PASS');
  assert.equal(result.ms, 210);
});

test('terminal output requires complete fresh standalone markers', () => {
  assert.equal(terminalBlock("$ printf 'BEGIN'; cat file; printf 'END'", 'BEGIN', 'END'), null);
  assert.equal(terminalBlock('BEGIN\r\ne2e-run-id\r\nEND\r\n$', 'BEGIN', 'END'), 'e2e-run-id');
  assert.equal(terminalBlock('BEGIN\nold\nEND\nBEGIN\nnew', 'BEGIN', 'END'), null);
});

test('AI account notices skip while generic service failures remain failures', () => {
  for (const message of ['no_ai_account', 'No AI account connected', 'AI account is required',
    'Sign in to use GitHub Copilot', 'Invalid API key']) assert.equal(isAIAccountError(message), true, message);
  for (const message of ['OK', 'Network timeout', 'Rate limit exceeded', 'Internal server error']) assert.equal(isAIAccountError(message), false, message);
});
