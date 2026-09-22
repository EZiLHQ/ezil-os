'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('production sampler is asynchronous, bounded, serialized and recovers after errors', async t => {
  const callbacks = [];
  t.mock.method(require('node:child_process'), 'execFile', (file, args, options, callback) => {
    assert.equal(file, '/bin/ps');
    assert.deepEqual(args, ['-axo', 'pid=,ppid=,pgid=,lstart=,stat=']);
    assert.equal(options.timeout, 1000); assert.equal(options.killSignal, 'SIGKILL');
    assert.equal(options.maxBuffer, 4 * 1024 * 1024);
    callbacks.push(callback);
  });
  // The host suite runs without test-file isolation. Load a fresh module so
  // its captured execFile references this test's mock, then restore the cache.
  const file = require.resolve('../src/editor.cjs'), previous = require.cache[file];
  delete require.cache[file];
  t.after(() => { if (previous) require.cache[file] = previous; else delete require.cache[file]; });
  const { EditorSupervisor } = require(file);
  const first = new EditorSupervisor(), second = new EditorSupervisor();
  const a = first.snapshot(), b = second.snapshot();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(callbacks.length, 1);
  callbacks[0](null, ' 100 1 100 Sun Sep 20 10:00:00 2026 S\n');
  assert.deepEqual(await a, [{ pid: 100, ppid: 1, pgid: 100, identity: '100:Sun Sep 20 10:00:00 2026', zombie: false }]);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(callbacks.length, 2);
  const rejected = assert.rejects(b, /Process inventory unavailable/);
  callbacks[1](Error('timeout')); await rejected;
  const c = first.snapshot(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(callbacks.length, 3); callbacks[2](null, ''); assert.deepEqual(await c, []);
});
