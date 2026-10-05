import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const { isCurrentViewerMessage, viewerFramesAdvance } = await import(
    'data:text/javascript;base64,' + Buffer.from(readFileSync(new URL('./viewer-evidence.js', import.meta.url))).toString('base64'));
const source = {};
const origin = 'https://viewer.example';
const attempt = 'navigation-2';
const message = () => ({ source, origin, data: { attempt } });
test('only the active iframe, expected origin and navigation may supply evidence', () => {
    assert.equal(isCurrentViewerMessage(message(), source, origin, attempt), true);
    for (const changed of [{ source: {} }, { origin: 'https://other.example' },
        { data: { attempt: 'navigation-1' } }, { data: {} }]) {
        assert.equal(isCurrentViewerMessage({ ...message(), ...changed }, source, origin, attempt), false);
    }
    assert.equal(isCurrentViewerMessage(message(), source, '', attempt), false);
    assert.equal(isCurrentViewerMessage(message(), source, origin, null), false);
    assert.equal(isCurrentViewerMessage({source:null,origin,data:{attempt}}, null, origin, attempt), false);
});
const previous = { bytesReceived: 100, framesDecoded: 2 };
const live = { bytesReceived: 200, framesDecoded: 3, width: 1280, height: 720, connectionState: 'connected' };
test('requires actual received bytes and decoded-frame progress for this viewer', () => {
    assert.equal(viewerFramesAdvance(previous, live), true);
    for (const changed of [{ bytesReceived:100 }, { framesDecoded:2 }, { framesDecoded:0 },
        { connectionState:'connecting' }, { connectionState:'disconnected' }, { width:0 },
        { height:0 }, { bytesReceived:NaN }, { width:'1280' }, { framesDecoded:'3' }]) {
        assert.equal(viewerFramesAdvance(previous, {...live,...changed}), false);
    }
    for (const baseline of [null, {}, { bytesReceived:'100',framesDecoded:2 }, {bytesReceived:-1,framesDecoded:2}]) {
        assert.equal(viewerFramesAdvance(baseline, live), false);
    }
    // First report is a baseline, not proof; after a reconnect counter reset,
    // a second growing report is required again.
    assert.equal(viewerFramesAdvance(previous, {...live,bytesReceived:10,framesDecoded:1}), false);
    assert.equal(viewerFramesAdvance({bytesReceived:10,framesDecoded:1}, live), true);
});
