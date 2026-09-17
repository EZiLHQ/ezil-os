import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const os = new URL('../../app/public/os/', import.meta.url);
const dom = new JSDOM('<!doctype html><html><body><div id="ezil-os-root"></div></body></html>', {
    runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://127.0.0.1:49152/os',
});
const { window } = dom;
const requests = []; const operations = [];
const errors = [];
window.addEventListener('error', event => errors.push(event.message));
window.fetch = async (url) => { requests.push(String(url)); throw new Error('Native shell made an unexpected HTTP request'); };
window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.__EZIL_BOOT__ = {
    user: { id: 'guest-native', email: null },
    computer: { id: '11111111-1111-4111-8111-111111111111', name: 'Guest', slot: 0, createdAt: new Date().toISOString(), lastOpenedAt: null, isNew: false },
    apps: [{ id: 'desktop', name: 'Browser', icon: 'desktop', kind: 'desktop' }],
    desktopState: { provider: 'native-macos', configured: true, hasHmacSecret: false, status: 'idle', endpoints: {},
        runtime: { contractVersion: 1, executionTarget: 'macos-host', isolation: 'trusted-native', editor: 'external-vscode', browser: 'native-chromium', cloudSync: false } },
};
let state = 'unavailable';
window.ezilNative = { operation: async op => { operations.push(op); return { ok: true, state }; } };
window.eval(readFileSync(new URL('icons.js', os), 'utf8'));
window.eval(readFileSync(new URL('bundle.min.js', os), 'utf8'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
await wait(180);
const api = window.ezil;
assert.ok(api, 'built bundle exports');
const ctx = { payload: window.__EZIL_BOOT__, computer: window.__EZIL_BOOT__.computer, desktopState: window.__EZIL_BOOT__.desktopState };
// Real registry and windows; no cloud transport stubs.
await api.registry.launch('code', ctx);
await wait(50);
let code = window.document.querySelector('.window[data-app="code"]');
assert.ok(code?.textContent.includes('VS Code is unavailable'));
assert.equal(code.querySelectorAll('iframe').length, 0);
state = 'opened';
await api.registry.launch('desktop', ctx); await wait(50);
const browser = window.document.querySelector('.window[data-app="desktop"]');
assert.ok(browser?.textContent.includes('Browser opened in its own window'));
await api.registry.launch('desktop', ctx); await wait(30);
assert.equal(operations.at(-1).op, 'surface.focus');
assert.deepEqual(Object.keys(operations[0]).sort(), ['op', 'surface', 'workspaceId']);
await api.registry.launch('settings', ctx); await wait(50);
assert.ok(window.document.querySelector('.window[data-app="settings"]')?.textContent.includes('Cloud sync is off'));
// Native hover must not warm the hosted desktop either.
window.document.querySelector('[data-app="desktop"]')?.dispatchEvent(new window.Event('pointerenter'));
await wait(30);
assert.equal(requests.length, 0, JSON.stringify(requests));
assert.equal(errors.length, 0, JSON.stringify(errors));
delete window.ezilNative;
await api.registry.launch('code', ctx); await wait(30);
assert.ok(code.textContent.includes('VS Code is unavailable'));
console.log('PASS native shell: Code-first unavailable, Browser open/focus, missing bridge, no iframe or hosted/telemetry calls, native Settings');
// The production mount observer intentionally repairs a removed desktop;
// jsdom.close() would trigger that observer while destroying its document.
process.exit(0);
