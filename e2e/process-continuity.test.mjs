import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminalContinuityCommand, readProcessSample, assertProcessContinuity, waitForProcessSample } from './process-continuity.mjs';

const nonce = 'a'.repeat(24);
const sample = sequence => ({ sequence, terminal: { pid: 101, startTicks: 123 },
  shell: { pid: 100, startTicks: 122 }, chrome: { pid: 50, startTicks: 50 }, code: { pid: 51, startTicks: 51 } });
const line = value => `EZILPROC:${nonce}:${JSON.stringify(value)}:END`;

test('process reports tolerate soft wraps and require the current probe', () => {
  assert.equal(readProcessSample(line(sample(0)), 'b'.repeat(24)), null);
  const wrapped = line(sample(1)).match(/.{1,40}/g).join('\n');
  assert.deepEqual(readProcessSample(line(sample(0)) + '\n' + wrapped, nonce), sample(1));
  assert.equal(readProcessSample(`EZILPROC:${nonce}:{"sequence":`, nonce), null);
});

test('observation failures and missing process identities fail explicitly', () => {
  assert.throws(() => readProcessSample(line({ failure: true }), nonce), /observation failed/);
  for (const key of ['terminal', 'shell', 'chrome', 'code']) {
    const value = sample(1); delete value[key];
    assert.throws(() => readProcessSample(line(value), nonce), /process identity|report fields/);
  }
});

test('heartbeat must advance and each process must retain its Linux identity', () => {
  assertProcessContinuity(sample(1), sample(2));
  assert.throws(() => assertProcessContinuity(sample(1), sample(1)), /did not advance/);
  for (const key of ['terminal', 'shell', 'chrome', 'code']) {
    for (const field of ['pid', 'startTicks']) {
      const after = sample(2); after[key][field] += 1;
      assert.throws(() => assertProcessContinuity(sample(1), after), /was replaced/);
    }
  }
});

test('terminal command accepts only a fixed nonce and encodes its script without shell interpolation', () => {
  assert.throws(() => terminalContinuityCommand('$(unsafe)'), /did not match/);
  const command = terminalContinuityCommand(nonce);
  assert.match(command, /^python3 -u -c "import base64;exec\(base64.b64decode\('[a-zA-Z0-9+/=]+'\)\)"$/);
});

test('fresh heartbeat waits past buffered terminal output', async () => {
  const outputs = [line(sample(1)), line(sample(1)), line(sample(2))];
  assert.deepEqual(await waitForProcessSample({ nonce, afterSequence: 1,
    observe: async () => outputs.shift(), sleep: async () => {} }), sample(2));
});

test('first observation cannot establish readiness from buffered output', async () => {
  const outputs = [line(sample(10)), line(sample(10)), line(sample(11))];
  assert.deepEqual(await waitForProcessSample({ nonce, afterSequence: 1,
    observe: async () => outputs.shift(), sleep: async () => {} }), sample(11));
});

test('a hung terminal observation cannot exceed the test deadline', async () => {
  await assert.rejects(waitForProcessSample({ nonce, observe: () => new Promise(() => {}), timeoutMs: 20 }), /timed out/);
});

test('arbitrary diagnostics never enter a process report', () => {
  assert.throws(() => readProcessSample(line({ ...sample(1), credential: 'private' }), nonce), /Unexpected/);
  const value = sample(1); value.code.command = 'private';
  assert.throws(() => readProcessSample(line(value), nonce), /process identity/);
});
