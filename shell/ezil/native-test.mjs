import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const os = process.env.EZIL_SHELL_OUT_DIR ? pathToFileURL(`${process.env.EZIL_SHELL_OUT_DIR}/`) : new URL('../../app/public/os/', import.meta.url);
const dom = new JSDOM(`<!doctype html><html><head><style>${readFileSync(new URL('bundle.min.css', os), 'utf8')}</style></head><body><div id="ezil-os-root"></div></body></html>`, {
    runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://127.0.0.1:49152/os',
});
const { window } = dom;
const requests = []; const operations = []; const errors = [];
window.addEventListener('error', event => errors.push(event.message));
window.fetch = async url => { requests.push(String(url)); throw new Error('Unexpected native HTTP request'); };
window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.__EZIL_BOOT__ = {
    user: { id: 'guest-native', email: null },
    computer: { id: '11111111-1111-4111-8111-111111111111', name: 'Guest', slot: 1, createdAt: new Date().toISOString(), lastOpenedAt: null, isNew: false },
    apps: [{ id: 'desktop', name: 'Browser', icon: 'desktop', kind: 'desktop' }],
    desktopState: { provider: 'native-macos', configured: true, hasHmacSecret: false, status: 'idle', endpoints: {},
        runtime: { contractVersion: 2, executionTarget: 'macos-host', isolation: 'trusted-native', editor: 'embedded-code-server', externalEditor: 'optional-microsoft-vscode', browser: 'native-chromium', cloudSync: 'disabled' } },
};
let codeState = 'failed', previewState = 'ready', previewPorts = [];
window.ezilNative = { operation: async op => {
    operations.push(op);
    if (op.op === 'workspace.list') return { ok: true, workspaces: [window.__EZIL_BOOT__.computer] };
    if (op.op === 'diagnostics.read') return { ok: true, events: [{ event: 'code_ready', t: 1000, path: '/secret', token: 'secret' }, { event: 'untrusted_message', t: 1 }] };
    if (op.op === 'preview.list') return { ok: true, ports: previewPorts };
    return { ...op, ok: true, state: op.op.startsWith('code.') ? codeState : op.op.startsWith('preview.') ? previewState : 'ready',
        url: `http://127.0.0.1:${op.op.startsWith('code.') ? 8443 : 3000}/`,
        ...(op.op === 'browser.snapshot' ? { snapshot: 'data:image/png;base64,AAAA' } : {}) };
} };
window.eval(readFileSync(new URL('icons.js', os), 'utf8'));
window.eval(readFileSync(new URL('bundle.min.js', os), 'utf8'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
await wait(180);
const api = window.ezil;
assert.deepEqual([...window.document.querySelectorAll('.taskbar-item[data-app]')].map(el => el.getAttribute('data-app')).filter(id => ['desktop', 'code', 'preview', 'settings'].includes(id)), ['desktop', 'code', 'preview', 'settings']);
const ctx = { payload: window.__EZIL_BOOT__, computer: window.__EZIL_BOOT__.computer, desktopState: window.__EZIL_BOOT__.desktopState };
await api.registry.launch('code', ctx); await wait(100);
const code = window.document.querySelector('.window[data-app="code"]');
assert.ok(code?.classList.contains('ezil-code-window'), 'real Code UIWindow');
assert.equal(code.querySelector('iframe').getAttribute('src'), 'about:blank', 'failed native launch never navigates');
assert.ok(operations.some(op => op.op === 'code.open'));
assert.equal(code.getAttribute('data-ezil-computer-id'), ctx.computer.id, 'registry stamps workspace identity');
codeState = 'ready';
// Drive the visible retry in the existing spinner failure panel.
code.querySelector('.ezil-boot-retry').click(); await wait(80);
assert.equal(code.querySelector('iframe').src, 'http://127.0.0.1:8443/');
code.querySelector('iframe').dispatchEvent(new window.Event('load')); await wait(40);
assert.ok(operations.some(op => op.op === 'code.status'));
const opens = operations.filter(op => op.op === 'code.open');
assert.equal(opens.length, 2); assert.equal(opens[1].generation, 2);
await api.registry.launch('code', ctx); await wait(30);
assert.equal(operations.filter(op => op.op === 'code.open').length, 2, 'registry reuses existing Code window');
await api.registry.launch('preview', ctx); await wait(80);
const preview = window.document.querySelector('.window[data-app="preview"]');
assert.equal(preview.querySelector('.ezil-preview-unavailable').hidden, false);
assert.ok(preview.textContent.includes('register its port in Settings'));
previewPorts = [3000]; preview.querySelector('.ezil-preview-unavailable-retry').click(); await wait(80);
assert.equal(preview.querySelector('iframe').src, 'http://127.0.0.1:3000/');
assert.equal(operations.find(op => op.op === 'preview.open').port, 3000);
preview.querySelector('iframe').dispatchEvent(new window.Event('load')); await wait(40);
codeState = 'failed'; previewState = 'unavailable'; await wait(2200);
for (const el of [code, preview]) {
    assert.equal(el.querySelector('.ezil-app-spinner').hidden, false, 'post-ready failure is visible');
    assert.equal(el.querySelector('.ezil-app-spinner').dataset.kind, 'failed');
}
assert.equal(code.querySelector('.ezil-app-spinner-label').textContent, 'Code connection lost');
assert.equal(preview.querySelector('.ezil-app-spinner-label').textContent, 'Preview is unavailable');
assert.ok(preview.querySelector('.ezil-app-spinner-sub').textContent.includes('register its port in Settings'));
assert.equal(code.querySelector('iframe').src, 'http://127.0.0.1:8443/', 'failure never reloads editor automatically');
codeState = 'ready'; previewState = 'ready';
for (const el of [code, preview]) {
    el.querySelector('.ezil-boot-retry').click(); await wait(80);
    el.querySelector('iframe').dispatchEvent(new window.Event('load')); await wait(40);
    assert.equal(el.querySelector('.ezil-app-spinner').hidden, true, 'explicit Retry recovers');
}
await api.registry.launch('desktop', ctx); await wait(80);
const browser = window.document.querySelector('.window[data-app="desktop"]');
assert.ok(browser.classList.contains('ezil-desktop-window'), 'existing Browser UIWindow chrome');
browser.querySelector('.ezil-native-browser-viewport').getBoundingClientRect = () => ({ x: 12, y: 82, width: 800, height: 558 });
await wait(60);
assert.ok(operations.some(op => op.op === 'browser.layout' && op.bounds.width === 800 && op.bounds.height === 558));
const address = browser.querySelector('.ezil-native-browser-toolbar input');
address.value = 'example.com'; address.form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await wait(30);
assert.ok(operations.some(op => op.op === 'browser.navigate' && op.url === 'https://example.com/'));
browser.querySelector('[data-action="reload"]').click(); await wait(20);
assert.ok(operations.some(op => op.op === 'browser.reload'));
browser.dispatchEvent(new window.CustomEvent('ezil:native-cover', { detail: { covered: true } })); await wait(80);
assert.ok(operations.some(op => op.op === 'browser.layout' && op.occluded));
assert.ok(!operations.some(op => op.op === 'browser.snapshot'), 'occlusion does not wait on capture');
assert.equal(browser.querySelector('.ezil-native-browser-cover').hidden, false);
browser.setAttribute('data-is_minimized', 'true'); await wait(50);
assert.equal(operations.filter(op => op.op === 'browser.layout').at(-1).visible, false);
await api.registry.launch('settings', ctx); await wait(80);
const settings = window.document.querySelector('.window[data-app="settings"]');
assert.equal(settings.querySelectorAll('.ezil-settings-pane').length, 5, 'real Settings tabs');
assert.ok(operations.some(op => op.op === 'workspace.list'), 'Computers uses native workspace adapter');
assert.ok(settings.querySelectorAll('.ezil-settings-row').length >= 1, 'native project rows remain visible');
assert.equal(settings.querySelector('[data-action="import"]')?.textContent, 'Open project folder…');
settings.querySelector('[data-tab="system"]')?.click(); await wait(50);
assert.ok(settings.textContent.includes('Cloud sync'));
settings.querySelector('[data-tab="troubleshoot"]')?.click(); await wait(50);
settings.querySelector('[data-action="copy-diagnostics"]').click(); await wait(70);
const report = settings.querySelector('[data-role="diagnostic-text"]')?.value ?? '';
assert.ok(report.includes('code_ready'), report);
assert.ok(!report.includes('/secret') && !report.includes('untrusted_message'));
await browser.on_before_exit(); await code.on_before_exit(); await preview.on_before_exit(); await wait(50);
for (const op of ['browser.detach', 'code.close', 'preview.close']) assert.ok(operations.some(x => x.op === op), op);
const before = operations.filter(op => !op.op.startsWith('desktop.')).length; window.dispatchEvent(new window.Event('ezil:teardown')); await wait(2200);
assert.equal(operations.filter(op => !op.op.startsWith('desktop.')).length, before, 'surface disposal idempotent; desktop flush may persist');
assert.equal(requests.length, 0, JSON.stringify(requests));
assert.equal(errors.length, 0, JSON.stringify(errors));
console.log('PASS native real-window parity: registry, Code retry/readiness, Preview port, Browser bounds/cover/minimize/disposal, Settings, diagnostics, no hosted requests');
process.exit(0);
