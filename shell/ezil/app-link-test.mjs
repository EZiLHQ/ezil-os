import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
const source = readFileSync(new URL('./app-link.js', import.meta.url), 'utf8');
const { parseAppLink } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const apps = ['desktop', 'code', 'settings'].map(id => ({ id }));
for (const search of ['?app=__proto__', '?app=javascript:alert(1)', '?app=%22%5D', '?app=code&app=browser', '?app=preview', '?app=unknown&settings=billing', '?app=code&app=browser&settings=billing', '?settings=account&settings=billing', '?app=https://evil.example']) assert.equal(parseAppLink(search, apps), null);
assert.deepEqual(parseAppLink('?app=browser&path=%2Fdemo', apps), { id: 'desktop' });
assert.deepEqual(parseAppLink('?settings=account', apps), { id: 'settings', initialTab: 'account' });
const os = new URL('../../app/public/os/', import.meta.url);
const bundle = readFileSync(new URL('bundle.min.js', os), 'utf8');
const icons = readFileSync(new URL('icons.js', os), 'utf8');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function boot(search) {
    const dom = new JSDOM('<!doctype html><div id="ezil-os-root"></div>', { url: `https://os.example/os${search}`, runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    w.fetch = async () => ({ ok: true, json: async () => ({ result: { data: { json: [] } } }) });
    w.__EZIL_BOOT__ = { user: { id: 'user', email: 'test@example.com' }, computer: { id: '11111111-1111-4111-8111-111111111111', name: 'Test', slot: 1 }, apps: [{ id: 'desktop' }], desktopState: { configured: false, provider: 'cloudflare-guacamole' } };
    w.eval(icons); w.eval(bundle); await wait(250);
    return { dom, w, ctx: { payload: w.__EZIL_BOOT__, computer: w.__EZIL_BOOT__.computer, desktopState: w.__EZIL_BOOT__.desktopState } };
}
for (const target of ['code', 'browser']) {
    const { dom, w, ctx } = await boot(`?app=${target}&project=demo&path=%2Fa%20b`);
    const id = target === 'browser' ? 'desktop' : target;
    assert.deepEqual([...w.document.querySelectorAll('.window[data-app]')].map(el => el.dataset.app), [id], 'fresh target opens only requested app');
    const original = w.document.querySelector('.window');
    await Promise.all([w.ezil.registry.launch(id, ctx), w.ezil.registry.launch(id, ctx)]);
    assert.equal(w.document.querySelectorAll('.window').length, 1);
    await w.ezil.registry.launch('settings', ctx);
    assert.ok(w.document.querySelector('[data-pane="account"].active'));
    await w.ezil.registry.launch('settings', { ...ctx, initialTab: 'system' });
    assert.ok(w.document.querySelector('[data-pane="system"].active'), 'existing Settings honors explicit section');
    await w.ezil.registry.launch('settings', ctx);
    assert.ok(w.document.querySelector('[data-pane="account"].active'), 'normal Settings opening returns to Account');
    w.dispatchEvent(new w.PopStateEvent('popstate')); await wait(180);
    assert.equal(w.document.querySelectorAll('.window').length, 2, 'history app request preserves other windows');
    assert.equal(w.document.querySelector(`.window[data-app="${id}"]`), original, 'same app focuses its original window');
    assert.equal(new URL(w.location.href).searchParams.get('path'), '/a b');
    w.dispatchEvent(new w.Event('ezil:teardown'));
}
const invalid = await boot('?app=unknown&settings=billing');
assert.equal(invalid.w.document.querySelectorAll('.window').length, 0, 'invalid app cannot fall through to billing launch');
const fallback = await boot('?app=settings&settings=billing');
assert.ok(fallback.w.document.querySelector('[data-pane="account"].active'), 'unavailable Billing section falls back to Account');
const ordinary = await boot('');
assert.equal(ordinary.w.document.querySelectorAll('.window').length, 0, 'ordinary hosted login does not start compute');
await Promise.all([ordinary.w.ezil.registry.launch('settings', ordinary.ctx), ordinary.w.ezil.registry.launch('settings', ordinary.ctx)]);
assert.equal(ordinary.w.document.querySelectorAll('.window').length, 1, 'concurrent initial opens coalesce');
ordinary.w.dispatchEvent(new ordinary.w.Event('ezil:teardown'));
console.log('PASS app allowlist, direct entry, repeated target, existing windows, Settings section/default and concurrent opens');

process.exit(0);
