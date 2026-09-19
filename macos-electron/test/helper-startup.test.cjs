'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { waitForReady } = require('../src/helper.cjs');
const { capabilities } = require('../src/policy.cjs');
function child() {
  const process = new EventEmitter(); process.stdout = new EventEmitter();
  process.stdout.resume = () => {};
  process.signals = []; process.kill = signal => process.signals.push(signal);
  return process;
}
function clean(process) {
  assert.equal(process.listenerCount('error'), 0);
  assert.equal(process.listenerCount('exit'), 0);
  assert.equal(process.stdout.listenerCount('data'), 0);
}
test('helper early exit is not mislabeled a timeout and never exposes output', async () => {
  const process = child(), ready = waitForReady(process);
  const failed = assert.rejects(ready, error => /exited before becoming ready/.test(error.message) && !/timeout|private|secret/.test(error.message));
  process.stdout.emit('data', Buffer.from('private path and secret capability\n'));
  process.emit('exit', 1); await failed; clean(process);
  assert.deepEqual(process.signals, ['SIGTERM']);
});
test('helper launch error, invalid protocol and output limit are distinct safe failures', async () => {
  for (const [trigger, expected] of [
    [process => process.emit('error', Error('/private/secret')), /could not start/],
    [process => process.stdout.emit('data', Buffer.from('EZIL_NATIVE_READY {"secret":true}\n')), /incompatible startup response/],
    [process => process.stdout.emit('data', Buffer.alloc(65537)), /startup response limit/],
  ]) {
    const process = child(), ready = waitForReady(process);
    const failed = assert.rejects(ready, error => expected.test(error.message) && !/private|secret/.test(error.message));
    trigger(process); await failed; clean(process);
  }
});
test('only an actual readiness deadline reports a timeout', async () => {
  const process = child(); await assert.rejects(waitForReady(process, 5), /within 20 seconds/); clean(process);
});
test('split ready messages resolve once and remove startup listeners', async () => {
  const process = child(), ready = waitForReady(process);
  const value = { contractVersion: 2, port: 54321, capabilities };
  const line = 'EZIL_NATIVE_READY ' + JSON.stringify(value) + '\n';
  process.stdout.emit('data', Buffer.from(line.slice(0, 25)));
  process.stdout.emit('data', Buffer.from(line.slice(25)));
  assert.deepEqual(await ready, value); clean(process);
  process.emit('exit', 0); assert.deepEqual(process.signals, []);
});
