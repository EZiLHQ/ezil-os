import assert from 'node:assert/strict';
import {test} from 'node:test';
import {playToPresentedFrame} from './tab-segments.js';

function fixture() {
    const events = [];
    let onFrame, onTimeout, resolvePlayback;
    const playback = new Promise(resolve => { resolvePlayback = resolve; });
    const video = {
        play() {
            events.push('play requested');
            return playback;
        },
        requestVideoFrameCallback(callback) {
            events.push('frame subscribed');
            onFrame = callback;
            return 42;
        },
        cancelVideoFrameCallback(id) {
            assert.equal(id, 42);
            events.push('frame cancelled');
        },
    };
    const timers = {
        setTimeout(callback, ms) {
            assert.equal(ms, 8000);
            onTimeout = callback;
            return 12;
        },
        clearTimeout(id) {
            assert.equal(id, 12);
            events.push('timer cleared');
        },
    };
    return {
        events, video, timers, resolvePlayback,
        presentFrame() { onFrame(); },
        expire() { onTimeout(); },
    };
}

test('paint starts a real frame on a static tab while video playback is pending', async () => {
    const capture = fixture();
    const awaitFrame = playToPresentedFrame(capture.video, capture.timers, 8000, () => {
        assert.deepEqual(capture.events, ['frame subscribed', 'play requested']);
        capture.events.push('status painted');
        queueMicrotask(() => {
            capture.resolvePlayback();
            capture.presentFrame();
        });
    });
    await awaitFrame;
    assert.deepEqual(capture.events, [
        'frame subscribed', 'play requested', 'status painted', 'timer cleared', 'frame cancelled',
    ]);
});

test('a stalled play does not hang the authorized capture or outlive the frame timeout', async () => {
    const capture = fixture();
    const awaitFrame = playToPresentedFrame(capture.video, capture.timers, 8000, () => {});
    await Promise.resolve();
    capture.presentFrame();
    capture.expire();
    await assert.rejects(awaitFrame, /no_current_frame/);
    assert.deepEqual(capture.events.slice(-2), ['timer cleared', 'frame cancelled']);
});

test('successful playback without a presented frame fails closed', async () => {
    const capture = fixture();
    const awaitFrame = playToPresentedFrame(capture.video, capture.timers, 8000);
    capture.resolvePlayback();
    await Promise.resolve();
    capture.expire();
    await assert.rejects(awaitFrame, /no_current_frame/);
    assert.deepEqual(capture.events.slice(-2), ['timer cleared', 'frame cancelled']);
});
