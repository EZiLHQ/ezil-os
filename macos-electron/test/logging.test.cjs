'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Writable } = require('node:stream');
const { installBrokenPipeGuards } = require('../src/stdio-guard.cjs');
const { Diagnostics, createDiagnosticSink } = require('../src/diagnostics.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const pipeError = () => Object.assign(Error('private error'), { code: 'EPIPE' });
test('real disconnected stdout and stderr pipes do not terminate the child process', async () => {
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['-e', `
    require(${JSON.stringify(require.resolve('../src/stdio-guard.cjs'))}).installBrokenPipeGuards({ onBrokenPipe: sink => process.send(sink) });
    process.once('message', () => {
      process.stdout.write('output'); process.stderr.write('warning');
      setTimeout(() => { console.error('later warning'); console.log('later output'); process.exit(0); }, 100);
    });
  `], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout.destroy(); child.stderr.destroy();
  const seen = []; child.on('message', message => seen.push(message));
  const exit = new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject); });
  child.send('write');
  assert.deepEqual(await exit, { code: 0, signal: null }); assert.deepEqual(seen.sort(), ['stderr', 'stdout']);
});

test('synchronous EPIPE disables only the broken sink and disposal restores writes', () => {
  const stdout = new EventEmitter(), stderr = new EventEmitter();
  let attempts = 0, otherWrites = 0, notes = 0;
  stdout.write = () => { attempts++; throw pipeError(); };
  stderr.write = () => { otherWrites++; return true; };
  const original = stdout.write;
  const dispose = installBrokenPipeGuards({ stdout, stderr, onBrokenPipe: () => { notes++; throw Error('disk'); } });
  assert.equal(stdout.write('a'), true); stdout.write('b'); stderr.write('c');
  assert.equal(attempts, 1); assert.equal(otherWrites, 1); assert.equal(notes, 1);
  dispose(); dispose(); assert.equal(stdout.write, original); assert.equal(stdout.listenerCount('error'), 0);
});

test('asynchronous stream EPIPE is handled once, including write callbacks', async () => {
  let attempts = 0, notes = 0, callbacks = 0;
  const sink = new Writable({ write(_chunk, _encoding, done) { attempts++; setImmediate(() => done(pipeError())); } });
  const dispose = installBrokenPipeGuards({ stdout: sink, stderr: sink, onBrokenPipe: async () => { notes++; throw Error('note'); } });
  sink.write('a', error => { assert.equal(error, undefined); callbacks++; });
  await tick(); await tick();
  sink.write('b', () => { callbacks++; }); await tick();
  assert.equal(attempts, 1); assert.equal(notes, 1); assert.equal(callbacks, 2); dispose();
});

test('unrelated errors remain observable both synchronously and through error listeners', () => {
  const sink = new EventEmitter(), error = Object.assign(Error('other'), { code: 'EIO' });
  sink.write = () => { throw error; };
  const dispose = installBrokenPipeGuards({ stdout: sink, stderr: sink });
  assert.throws(() => sink.write('a'), e => e === error);
  assert.throws(() => sink.emit('error', error), e => e === error);
  let observed;
  sink.on('error', e => { observed = e; }); sink.emit('error', error);
  assert.equal(observed, error); dispose();
});

test('diagnostic persistence failures are bounded, credential-free and never retried recursively', async () => {
  const diagnostics = new Diagnostics(); let writes = 0;
  const note = createDiagnosticSink('/unused', diagnostics, () => { writes++; throw Error('secret disk path'); });
  for (let i = 0; i < 150; i++) assert.doesNotThrow(() => note('STDIO_PIPE_CLOSED', { password: 'private', state: 'ready' }));
  assert.equal(writes, 150); assert.equal(diagnostics.events.length, 100);
  assert.equal(diagnostics.events.at(-1).code, 'DIAGNOSTICS_WRITE_FAILED');
  assert.doesNotMatch(diagnostics.report(), /private|secret disk path|unused/);
  const asyncNote = createDiagnosticSink('/unused', diagnostics, async () => { throw Error('disk'); });
  asyncNote('EDITOR_CLEANUP_FAILED'); await tick();
  assert.equal(diagnostics.events.at(-2).code, 'EDITOR_CLEANUP_FAILED');
  assert.equal(diagnostics.events.at(-1).code, 'DIAGNOSTICS_WRITE_FAILED');
});

test('asynchronous EPIPE without a callback is guarded and unrelated async errors reach existing once listeners', async () => {
  const broken = new Writable({ write(_chunk, _encoding, done) { setImmediate(() => done(pipeError())); } });
  const error = Object.assign(Error('other'), { code: 'EIO' });
  const other = new Writable({ write(_chunk, _encoding, done) { setImmediate(() => done(error)); } });
  let observed, notes = 0;
  other.once('error', e => { observed = e; });
  const dispose = installBrokenPipeGuards({ stdout: broken, stderr: other, onBrokenPipe: () => { notes++; broken.write('recursive'); } });
  broken.write('a'); other.write('b'); await tick(); await tick();
  assert.equal(notes, 1); assert.equal(observed, error); dispose();
});
