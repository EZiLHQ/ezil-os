// tab-hold-test.mjs — EZiL-OS authored. Run: node --test shell/ezil/assignment-video/tab-hold-test.mjs
//
// A server-gated hold (the trusted system pause): recording stops, no frame is sampled and no fault is raised while it
// lasts, the timeline stays the real wall clock (the pause is a gap, never compressed) with continuous sequences, and a
// deadline the server moved (time given back) is followed. Synthetic frames and timers only.
import assert from 'node:assert/strict';
import test from 'node:test';
import {encodeTabSegments} from './tab-segments.js';

function harness({muted = false, elapsedMs = 600000, cutoff = async () => null} = {}) {
    let now = 0, handle = 0, frames = 0, faults = [], resumes = 0, pauses = 0, trackMuted = muted;
    const timers = new Map(), uploads = [];
    const start = Date.now() - elapsedMs;
    const deadline = start + 3600000;
    const video = {videoWidth: 480, videoHeight: 360, readyState: 3, play: async () => {}, pause() {}, requestVideoFrameCallback(fn) { queueMicrotask(fn); }};
    class Encoder {
        constructor({output}) { this.output = output; this.state = 'configured'; this.encodeQueueSize = 0; }
        static async isConfigSupported() { return {supported: true}; }
        configure() {} close() { this.state = 'closed'; } async flush() {}
        encode(frame, {keyFrame}) { frames++; this.output({timestamp: frame.timestamp, type: keyFrame ? 'key' : 'delta', byteLength: 1, copyTo() {}}); }
    }
    const win = {performance: {now: () => now}, setTimeout(fn, ms) { timers.set(++handle, {fn, when: now + ms}); return handle; },
        clearTimeout(id) { timers.delete(id); },
        document: {createElement(name) { return name === 'video' ? video : {getContext: () => ({fillRect() {}, drawImage() {}})}; }},
        VideoEncoder: Encoder, VideoFrame: class { constructor(_, init) { this.timestamp = init.timestamp; } close() {} }};
    const track = {get muted() { return trackMuted; }, addEventListener() {}, removeEventListener() {}};
    return {start, deadline, uploads, faults, get frames() { return frames; }, get resumes() { return resumes; }, get pauses() { return pauses; },
        get timers() { return timers.size; }, mute(on) { trackMuted = on; },
        async create() {
            return encodeTabSegments({win, stream: {getVideoTracks: () => [track]}, matches: () => true, windowStart: start, deadline,
                upload: async packet => uploads.push(packet), cutoff, onFrame() {},
                onFault: code => faults.push(code), onPause() { pauses++; }, onResume() { resumes++; }});
        },
        async advance(ms) { now += ms; for (const [id, task] of [...timers]) if (task.when <= now) { timers.delete(id); task.fn(); }
            for (let i = 0; i < 4; i++) await Promise.resolve(); },
        wall: () => now};
}

test('a hold seals the clip so far, samples nothing while it lasts and raises no fault', async () => {
    const h = harness(), recorder = await h.create();
    await h.advance(1001); await h.advance(1001);
    const framesBefore = h.frames;
    recorder.hold();
    assert.equal(recorder.held(), true);
    assert.equal(h.timers, 0, 'no sampler is armed during a hold');
    for (let i = 0; i < 30; i++) await h.advance(1001);
    assert.equal(h.frames, framesBefore, 'nothing recorded while the computer upgrades');
    assert.deepEqual(h.faults, [], 'a long hold is not a fault');
    assert.equal(h.pauses, 0, 'a hold is not a brief-interruption pause');
    assert.equal(h.uploads.length, 1, 'the clip up to the hold was sealed and uploaded');
    await recorder.stop();
});

test('after release the real wall-clock timeline keeps the held time as a gap and the sequences continue', async () => {
    const h = harness(), recorder = await h.create();
    await h.advance(1001); await h.advance(1001);
    recorder.hold();
    await h.advance(20 * 60 * 1000);
    recorder.release();
    await h.advance(0);
    assert.equal(recorder.held(), false);
    assert.equal(h.resumes, 1, 'the recorder says it is recording again');
    await h.advance(1001); await h.advance(1001);
    await recorder.stop();
    assert.equal(h.uploads.length, 2);
    const [before, after] = h.uploads;
    assert.equal(after.sequence, before.sequence + 1, 'same recording, next sequence');
    const gap = after.startMs - before.endMs;
    assert.ok(gap >= 20 * 60 * 1000 - 3000 && gap <= 20 * 60 * 1000 + 3000, 'the twenty held minutes are an honest gap, not compressed: ' + gap + ' ms');
    assert.deepEqual(h.faults, []);
});

test('a track mute during a hold does not start a recovery of its own', async () => {
    const h = harness(), recorder = await h.create();
    await h.advance(1001);
    recorder.hold();
    recorder.pause('track_muted');
    await h.advance(5000);
    assert.equal(h.pauses, 0);
    assert.deepEqual(h.faults, []);
    assert.equal(recorder.held(), true);
    await recorder.stop();
});

test('holding twice or releasing without a hold changes nothing', async () => {
    const h = harness(), recorder = await h.create();
    await h.advance(1001);
    recorder.release();
    assert.equal(h.resumes, 0);
    recorder.hold(); recorder.hold();
    assert.equal(recorder.held(), true);
    recorder.release();
    await h.advance(0);
    assert.equal(h.resumes, 1);
    await recorder.stop();
});

test('a deadline the server moved is followed: the recorder does not stop at the old one', async () => {
    const unmoved = harness({elapsedMs: 3598000}), first = await unmoved.create();
    await unmoved.advance(1001); await unmoved.advance(1001); await unmoved.advance(1001);
    assert.deepEqual(unmoved.faults, ['deadline'], 'control: the old deadline ends the recording');
    await first.stop();
    const moved = harness({elapsedMs: 3598000}), recorder = await moved.create();
    await moved.advance(1001);
    // The server gave back 40 minutes.
    recorder.setDeadline(moved.deadline + 40 * 60 * 1000);
    recorder.setDeadline(NaN);
    await moved.advance(1001); await moved.advance(1001); await moved.advance(1001);
    assert.deepEqual(moved.faults, [], 'the moved deadline is followed, a NaN is ignored');
    await recorder.stop();
});

test('a hold that outlasts the original deadline is not a deadline fault when the clock was stopped', async () => {
    const h = harness(), recorder = await h.create();
    await h.advance(1001);
    recorder.hold();
    // 70 minutes pass in wall time; the server paused the clock and moved its deadline by the same amount.
    await h.advance(70 * 60 * 1000);
    recorder.setDeadline(h.deadline + 70 * 60 * 1000);
    recorder.release();
    await h.advance(0);
    await h.advance(1001);
    assert.deepEqual(h.faults, []);
    assert.equal(h.resumes, 1);
    await recorder.stop();
});

test('a stop while held uploads nothing past the hold', async () => {
    const h = harness(), recorder = await h.create();
    await h.advance(1001);
    recorder.hold();
    await h.advance(5 * 60 * 1000);
    const result = await recorder.stop(new Date(h.start + 3 * 60 * 1000).toISOString());
    assert.ok(result.expectedSegments >= 1);
    assert.equal(h.uploads.length, 1, 'only the clip sealed at the hold');
});

test('a delayed trusted pause cuts queued and current clips at its exact server time', async () => {
    let continueSeal;
    const allowSeal = new Promise(resolve => { continueSeal = resolve; });
    const h = harness({cutoff: () => allowSeal});
    const recorder = await h.create();
    for (let i = 0; i < 4; i++) await h.advance(1001);
    const pausedAt = h.start + 601500;
    recorder.hold(pausedAt);
    await h.advance(3000);
    continueSeal(null);
    await h.advance(0);
    recorder.release();
    await h.advance(0);
    await h.advance(1001);
    await recorder.stop();

    assert.equal(h.uploads.length, 2);
    assert.equal(h.uploads[0].endMs, pausedAt-h.start, 'flush drops samples after the trusted pause');
    assert.ok(h.uploads[1].startMs > pausedAt-h.start, 'resumed recording leaves the upgrade gap');
    assert.equal(h.uploads[1].sequence, h.uploads[0].sequence+1, 'discarded interrupted clip takes no sequence');
    assert.deepEqual(h.faults, []);
});
