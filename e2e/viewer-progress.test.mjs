import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestViewerProbe, waitForViewerProgress } from './viewer-progress.mjs';

test('cold startup waits for a runtime URL and probes only its current attempt', () => {
  const previous = globalThis.document;
  const calls = [];
  let frame;
  globalThis.document = { querySelector: () => frame };
  try {
    assert.equal(requestViewerProbe(), false);
    for (const src of ['', 'about:blank', 'invalid', 'https://runtime.example/']) {
      frame = { src, contentWindow: { postMessage: (...args) => calls.push(args) } };
      assert.equal(requestViewerProbe(), false);
    }
    assert.deepEqual(calls, []);
    frame.src = 'https://runtime.example/viewer?ezilAttempt=current-attempt';
    assert.equal(requestViewerProbe(), true);
    assert.deepEqual(calls, [[{ source: 'ezil-shell', type: 'viewer_probe', attempt: 'current-attempt' }, 'https://runtime.example']]);
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});

const live = (sequence, bytesReceived = sequence * 100, framesDecoded = sequence) => ({
  sequence, receivedAt: 1000, bytesReceived, framesDecoded, width: 1280, height: 720,
  connectionState: 'connected', localCandidateType: 'relay', relayProtocol: 'udp',
});
function observe(samples, options = {}) {
  let clock = 1000, index = 0;
  return waitForViewerProgress({ sample: async () => samples[Math.min(index++, samples.length - 1)],
    afterSequence: 10, timeoutMs: 1000, now: () => clock, sleep: async () => { clock += 100; }, ...options });
}
test('old buffered samples cannot establish readiness after return or reconnect', async () => {
  await assert.rejects(observe([live(8), live(9), live(10)]), /timed out/);
  await assert.rejects(observe([{ ...live(11), receivedAt: -20000 }, { ...live(12), receivedAt: -20000 }]), /timed out/);
  await assert.rejects(observe([live(11)]), /timed out/);
  await assert.rejects(observe([live(11), live(12, 1200, 11)]), /timed out/);
});
test('readiness requires fresh bytes and decoded frames, including after counter resets', async () => {
  assert.equal((await observe([live(11), live(12)])).sequence, 12);
  assert.equal((await observe([live(11, 5000, 50), live(12, 100, 1), live(13, 200, 2)])).sequence, 13);
  assert.equal((await observe([live(11), { ...live(12), connectionState: 'disconnected' }, live(13), live(14)])).sequence, 14);
});
test('missing media, TURN and TCP/TLS fallback fail explicitly', async () => {
  await assert.rejects(observe([{ ...live(11), framesDecoded: undefined }, { ...live(12), framesDecoded: undefined }]), /timed out/);
  await assert.rejects(observe([live(11), { ...live(12), localCandidateType: 'host' }]), /does not use TURN/);
  await assert.rejects(observe([live(11), live(12)], { fallback: true }), /TCP\/TLS/);
  assert.equal((await observe([live(11), { ...live(12), relayProtocol: 'tls' }], { fallback: true })).relayProtocol, 'tls');
});
test('a hung browser observation has a real wall-clock deadline', async () => {
  await assert.rejects(waitForViewerProgress({ sample: () => new Promise(() => {}), afterSequence: 0, timeoutMs: 20 }), /timed out/);
});
