import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const { attachCodeAuthRecovery, resetOriginRecovery, CODE_AUTH_REQUIRED, CODE_ORIGIN_UNAVAILABLE } = await import(`data:text/javascript;base64,${Buffer.from(fs.readFileSync(new URL('./code-auth-recovery.js', import.meta.url))).toString('base64')}`);
const frameUrl = 'https://aws-8443-guac-user-computer-aws.example.org/preview-bootstrap?token=fixture';
const flush = () => new Promise(r => setImmediate(r));
function setup(over = {}) {
    const win = new EventTarget(), contentWindow = {}, iframe = { src: frameUrl, contentWindow };
    const store = new Map(), seen = [], state = { current: true, running: true, probes: 0, retry: null };
    const storage = { getItem: k => store.get(k) ?? null, setItem: (k,v) => store.set(k,v), removeItem: k => store.delete(k) };
    const options = { win, iframe, frameUrl, storage, now: () => 100_000,
        current: () => state.current, desktopRunning: async () => { state.probes++; return state.running; },
        onStopped: () => seen.push('stopped'), onUnknown: retry => { seen.push('unknown'); state.retry = retry; },
        reload: () => seen.push('full-os-reload'), ...over };
    const dispose = attachCodeAuthRecovery(options);
    const send = (override = {}) => {
        const e = new Event('message'); Object.assign(e, { source: contentWindow, origin: new URL(frameUrl).origin,
            data: { type: CODE_AUTH_REQUIRED, url: 'https://attacker.invalid/' }, ...override }); win.dispatchEvent(e);
    };
    return { win, iframe, store, state, seen, options, dispose, send };
}
test('expired Code document triggers one authenticated status check and full OS reload, never message URL', async () => {
    const h = setup(); h.send(); h.send(); await flush(); h.send(); await flush();
    assert.equal(h.state.probes, 1); assert.deepEqual(h.seen, ['full-os-reload']);
});
test('stopped computer exposes existing Start CTA and never automatically starts or reloads', async () => {
    const h = setup(); h.state.running = false; h.send(); await flush();
    assert.deepEqual(h.seen, ['stopped']); assert.equal(h.store.size, 0);
});
test('unknown status uses the guarded full OS auth bootstrap instead of a permanent status Retry', async () => {
    const h = setup(); h.state.running = undefined; h.send(); await flush();
    assert.deepEqual(h.seen, ['full-os-reload']); h.dispose();
    const next = setup({ storage: h.options.storage }); next.state.running = undefined; next.send(); await flush();
    assert.deepEqual(next.seen, ['unknown']); next.state.retry(); await flush();
    assert.deepEqual(next.seen, ['unknown', 'full-os-reload']);
});
test('actual session desktopRunning maps expired401, redirectHTML and network failure to unknown; each can rebootstrap', async () => {
    const { desktopRunning } = await import('../session.js');
    const originalFetch = globalThis.fetch;
    try {
        for (const mode of ['401', 'redirect-html', 'offline']) {
            const calls = [];
            globalThis.fetch = async (url, init) => {
                calls.push({url,credentials:init.credentials});
                if (mode === 'offline') throw new TypeError('local fixture offline');
                return mode === '401' ? new Response(JSON.stringify({error:{code:'UNAUTHORIZED'}}),{status:401})
                    : new Response('<html>Sign in</html>',{status:200});
            };
            const h = setup({ desktopRunning: () => desktopRunning('fixture-computer') });
            h.send(); await flush(); assert.deepEqual(h.seen,['full-os-reload'],mode);
            assert.deepEqual(calls,[{url:'/api/shell/desktop?computerId=fixture-computer',credentials:'same-origin'}]);
            h.dispose();
        }
    } finally { globalThis.fetch = originalFetch; }
});
test('foreign origin, sibling frame, missing source, other message and stale mint are ignored', async () => {
    const h = setup(); h.send({ origin: 'https://attacker.invalid' }); h.send({ source: {} }); h.send({ source: null });
    h.send({ data: { type: 'other' } }); h.iframe.src = frameUrl + '&new'; h.send(); h.iframe.src = frameUrl;
    h.state.current = false; h.send(); await flush(); assert.equal(h.state.probes, 0); assert.deepEqual(h.seen, []);
});

// S13: the Worker's 502 recovery document (an unavailable origin) instead of raw JSON.
const sendOrigin = (h, override = {}) => h.send({ data: { type: CODE_ORIGIN_UNAVAILABLE, url: 'https://attacker.invalid/' }, ...override });
test('unavailable origin on a running computer: one status check and one automatic reopen, never the OS reload', async () => {
    const acts = [];
    const h = setup({ reopen: () => acts.push('reopen'), onUnreachable: () => acts.push('unreachable') });
    sendOrigin(h); sendOrigin(h); await flush(); sendOrigin(h); await flush();
    assert.equal(h.state.probes, 1); assert.deepEqual(acts, ['reopen']); assert.deepEqual(h.seen, []);
});
test('a second unavailable origin in the same episode is unreachable with an explicit retry, not another reopen', async () => {
    const acts = [];
    const h = setup({ reopen: () => acts.push('reopen'), onUnreachable: () => acts.push('unreachable') });
    sendOrigin(h); await flush(); h.dispose();
    let retry = null;
    const next = setup({ storage: h.options.storage, reopen: () => acts.push('reopen'), onUnreachable: r => { acts.push('unreachable'); retry = r; } });
    sendOrigin(next); await flush(); sendOrigin(next); await flush();
    assert.deepEqual(acts, ['reopen', 'unreachable', 'unreachable']); assert.deepEqual(next.seen, []);
    retry(); await flush();
    assert.deepEqual(acts, ['reopen', 'unreachable', 'unreachable', 'reopen']);
    sendOrigin(next); await flush();
    assert.deepEqual(acts, ['reopen', 'unreachable', 'unreachable', 'reopen'], 'a reopened attachment acts once');
});
test('slow failing reopens (31s or more apart, no confirmed editor between) earn ONE automatic reopen per episode, then stay terminal', async () => {
    // The static counterexample to a time-window guard: each failed reopen takes longer than any window, so a
    // window would re-arm every attempt and a dead origin would drive reopens for ever.
    let t = 100_000; const acts = [];
    const attempt = (storage) => setup({ ...(storage ? { storage } : {}), now: () => t, reopen: () => acts.push('reopen'), onUnreachable: () => acts.push('unreachable') });
    let h = attempt(null); const storage = h.options.storage;
    sendOrigin(h); await flush(); h.dispose();
    for (let i = 0; i < 3; i++) {
        t += 31_000 + i * 120_000;
        h = attempt(storage); sendOrigin(h); await flush(); h.dispose();
    }
    assert.deepEqual(acts, ['reopen', 'unreachable', 'unreachable', 'unreachable']);
    // An explicit retry runs the reopen but does not re-arm the automatic one.
    let retry = null;
    h = setup({ storage, now: () => t, reopen: () => acts.push('reopen'), onUnreachable: r => { acts.push('unreachable'); retry = r; } });
    sendOrigin(h); await flush(); retry(); await flush(); h.dispose();
    t += 200_000;
    h = attempt(storage); sendOrigin(h); await flush(); h.dispose();
    assert.deepEqual(acts, ['reopen', 'unreachable', 'unreachable', 'unreachable', 'unreachable', 'reopen', 'unreachable']);
});
test('a confirmed healthy editor ends the episode: the next unavailable origin gets one automatic reopen again', async () => {
    const acts = [];
    const h = setup({ reopen: () => acts.push('reopen'), onUnreachable: () => acts.push('unreachable') });
    sendOrigin(h); await flush(); h.dispose();
    const storage = h.options.storage;
    resetOriginRecovery({ storage });
    const next = setup({ storage, reopen: () => acts.push('reopen'), onUnreachable: () => acts.push('unreachable') });
    sendOrigin(next); await flush();
    assert.deepEqual(acts, ['reopen', 'reopen']);
    // Unusable storage: the reset is harmless and the guard stays conservative (terminal, explicit retry only).
    resetOriginRecovery({ storage: { removeItem() { throw new Error('blocked'); } } });
    const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    const c = setup({ storage: blocked, reopen: () => acts.push('reopen'), onUnreachable: () => acts.push('unreachable') });
    sendOrigin(c); await flush();
    assert.deepEqual(acts, ['reopen', 'reopen', 'unreachable']);
});
test('unavailable origin: a stopped computer gets Start and an unknown status gets Retry; neither reopens on its own', async () => {
    const acts = [];
    const h = setup({ reopen: () => acts.push('reopen') }); h.state.running = false; sendOrigin(h); await flush();
    assert.deepEqual(h.seen, ['stopped']); assert.deepEqual(acts, []); assert.equal(h.store.size, 0);
    const u = setup({ reopen: () => acts.push('reopen') }); u.state.running = undefined; sendOrigin(u); await flush();
    assert.deepEqual(u.seen, ['unknown']); assert.deepEqual(acts, []); assert.equal(u.store.size, 0);
    u.state.running = true; u.state.retry(); await flush();
    assert.deepEqual(acts, ['reopen'], 'the explicit Retry re-checks and then reopens');
});
test('an older caller without reopen or onUnreachable gets the guarded OS reload and the unknown cover', async () => {
    const h = setup(); sendOrigin(h); await flush(); assert.deepEqual(h.seen, ['full-os-reload']); h.dispose();
    const next = setup({ storage: h.options.storage }); sendOrigin(next); await flush(); assert.deepEqual(next.seen, ['unknown']);
});
test('the auth and origin guards are separate: an auth reload does not block the origin reopen, nor the reverse', async () => {
    const acts = [];
    const a = setup(); a.send(); await flush(); assert.deepEqual(a.seen, ['full-os-reload']); a.dispose();
    const b = setup({ storage: a.options.storage, reopen: () => acts.push('reopen'), onUnreachable: () => acts.push('unreachable') });
    sendOrigin(b); await flush(); assert.deepEqual(acts, ['reopen']);
});
test('origin message from a foreign origin, sibling frame, missing source or stale mint is ignored', async () => {
    const acts = [];
    const h = setup({ reopen: () => acts.push('reopen') });
    sendOrigin(h, { origin: 'https://attacker.invalid' }); sendOrigin(h, { source: {} }); sendOrigin(h, { source: null });
    h.iframe.src = frameUrl + '&new'; sendOrigin(h); h.iframe.src = frameUrl;
    h.state.current = false; sendOrigin(h); await flush(); assert.equal(h.state.probes, 0); assert.deepEqual(acts, []);
});
test('superseded or disposed generation cannot reload after pending status response', async () => {
    for (const dispose of [false, true]) {
        let resolve; const h = setup({ desktopRunning: () => new Promise(r => { resolve = r; }) });
        h.send(); if (dispose) h.dispose(); else h.state.current = false; resolve(true); await flush();
        assert.deepEqual(h.seen, []);
    }
});
test('cross-page time guard prevents automatic reload cycles but never strands explicit Retry/Start', async () => {
    const h = setup(); h.send(); await flush(); h.dispose();
    const next = setup({ storage: h.options.storage }); next.send(); await flush();
    assert.deepEqual(next.seen, ['unknown']); next.state.running = false; next.state.retry(); await flush();
    assert.deepEqual(next.seen, ['unknown', 'stopped']); next.state.running = true; next.state.retry(); await flush();
    assert.deepEqual(next.seen, ['unknown', 'stopped', 'full-os-reload']);
});
test('guard expires and unavailable session storage requires explicit safe Retry', async () => {
    const h = setup(); h.send(); await flush(); h.dispose();
    const later = setup({ storage: h.options.storage, now: () => 130_001 }); later.send(); await flush();
    assert.deepEqual(later.seen, ['full-os-reload']);
    const denied = setup({ storage: { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } } });
    denied.send(); await flush(); assert.deepEqual(denied.seen, ['unknown']); denied.state.retry(); await flush();
    assert.deepEqual(denied.seen, ['unknown', 'full-os-reload']);
});
test('cleanup removes listener and a genuine new launch gets independent duplicate-suppression state', async () => {
    const h = setup(); h.dispose(); h.send(); await flush(); assert.equal(h.state.probes, 0);
    const next = setup(); next.send(); await flush(); assert.deepEqual(next.seen, ['full-os-reload']);
});
