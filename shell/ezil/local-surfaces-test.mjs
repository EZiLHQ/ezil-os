import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const os = new URL('../../app/public/os/', import.meta.url);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
for (const surface of ['code', 'preview']) {
    const dom = new JSDOM('<!doctype html><body><div id="ezil-os-root"></div></body>', {
        runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://127.0.0.1:3001/os',
    });
    const { window } = dom;
    const requests = [];
    let running = false;
    const computer = { id: 'local-test', name: 'Local', slot: 1, createdAt: new Date().toISOString(), lastOpenedAt: null, isNew: false };
    const payload = {
        user: { id: 'local-user', email: null }, computer,
        apps: [{ id: 'desktop', name: 'Browser', icon: 'desktop', kind: 'desktop' }],
        desktopState: { provider: 'local-vm', configured: true, hasHmacSecret: false, status: 'idle', endpoints: {
            desktop: '/api/shell/desktop', previewUrl: '/api/shell/preview-url', codePreviewUrl: '/api/shell/code-preview-url',
        } },
    };
    window.__EZIL_BOOT__ = payload;
    window.fetch = async (raw, init = {}) => {
        const url = new URL(raw, window.location.origin); requests.push({ url, method: init.method ?? 'GET' });
        let body;
        if (url.pathname === '/api/shell/desktop' && init.method === 'POST') {
            await wait(10); running = true;
            body = { ok: true, guacamoleUrl: 'http://127.0.0.1:8181/', frame: { confirmed: true } };
        } else if (url.searchParams.get('confirm') === 'frame') {
            body = { ok: true, confirmed: url.searchParams.get('surface') === surface };
        } else if (url.pathname === '/api/shell/desktop') body = { ok: true, guacamoleRunning: running };
        else {
            assert.equal(running, true, `${surface} minted before cold start completed`);
            body = { ok: true, codePreviewUrl: 'http://127.0.0.1:8443/', appPreviewUrl: 'http://127.0.0.1:3002/' };
        }
        return { ok: true, status: 200, json: async () => body };
    };
    window.eval(readFileSync(new URL('icons.js', os), 'utf8'));
    window.eval(readFileSync(new URL('bundle.min.js', os), 'utf8'));
    await wait(180);
    assert.equal(requests.length, 0, 'login must not start a desktop');
    await window.ezil.registry.launch(surface, { payload, computer, desktopState: payload.desktopState });
    let frame;
    for (let i = 0; i < 50; i++) {
        frame = window.document.querySelector(`.window[data-app="${surface}"] iframe`);
        if (frame?.src.startsWith('http://127.0.0.1:')) break;
        await wait(20);
    }
    assert.ok(frame?.src.startsWith(surface === 'code' ? 'http://127.0.0.1:8443/' : 'http://127.0.0.1:3002/'));
    assert.equal(requests[0].method, 'POST'); assert.equal(requests[0].url.pathname, '/api/shell/desktop');
    frame.dispatchEvent(new window.Event('load')); await wait(40);
    assert.ok(requests.some(request => request.url.searchParams.get('surface') === surface));
    console.log(`PASS local ${surface}-first cold start: ensure before mint and surface-specific confirmation`);
}
process.exit(0);
