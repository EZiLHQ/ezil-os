// floating-controls-test.mjs — EZiL-authored. Run from the worktree root:
// node shell/ezil/ui/floating-controls-test.mjs
//
// Evaluate the actual drawer and vendored jQuery in jsdom, replacing only
// module imports/exports and telemetry. Fake time makes the focus/menu veto
// of the 1500ms timer observable (app-drawer.js:375). jsdom has no layout:
// CSS assertions pin declarations, not browser pixel/hit-testing results.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
const source = read('./app-drawer.js');
const settings_source = read('./Settings/drawer-action.js');
const css = read('./floating-controls.css');
const jquery = read('../../src/lib/jquery-3.6.1/jquery-3.6.1.min.js');
const checks = [];

function harness ({ fine = true, coarse = false, bodyClass = '' } = {}) {
    const dom = new JSDOM('<!doctype html><html><head></head><body><button id="previous">Previous</button></body></html>',
        { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://ezil.test/os' });
    const w = dom.window;
    const d = w.document;
    d.body.className = bodyClass;
    const events = [];
    const errors = [];
    const uncaught = [];
    w.console.error = (...args) => errors.push(args);
    w.console.info = () => {};
    w.addEventListener('error', e => uncaught.push(e.error));
    w.__capture = entry => events.push(entry);
    const queries = new Map();
    for ( const [query, matches] of [
        ['(hover: hover) and (pointer: fine)', fine], ['(any-pointer: coarse)', coarse],
    ] ) {
        const listeners = new Set();
        queries.set(query, { matches, listeners,
            addEventListener: (name, listener) => listeners.add(listener),
            removeEventListener: (name, listener) => listeners.delete(listener),
            change (value) { this.matches = value; for ( const listener of listeners ) listener({ matches: value }); },
        });
    }
    w.matchMedia = query => {
        assert.ok(queries.has(query), `unexpected media query: ${query}`);
        return queries.get(query);
    };
    let time = 1000;
    let sequence = 0;
    const timers = new Map();
    const frames = new Map();
    w.Date.now = () => time;
    w.setTimeout = (fn, delay = 0) => { timers.set(++sequence, { fn, at: time + delay }); return sequence; };
    w.clearTimeout = id => timers.delete(id);
    w.requestAnimationFrame = fn => { frames.set(++sequence, fn); return sequence; };
    w.cancelAnimationFrame = id => frames.delete(id);
    const advance = ms => {
        const end = time + ms;
        for (;;) {
            const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if ( ! next ) break;
            time = next[1].at;
            timers.delete(next[0]);
            next[1].fn();
        }
        time = end;
    };
    const frame = () => {
        const pending = [...frames.values()];
        frames.clear();
        for ( const callback of pending ) callback();
    };
    w.eval(jquery);
    let focused = 0;
    let closed = 0;
    w.$.fn.focusWindow = function () { focused++; return this; };
    w.$.fn.close = function () { closed++; return this; };
    w.html_encode = value => {
        const el = d.createElement('div');
        el.textContent = value;
        return el.innerHTML.replaceAll('"', '&quot;');
    };
    const telemetry_stub = 'const telemetry = { capture: window.__capture };';
    const code = source.replace("import telemetry from '../telemetry.js';", telemetry_stub)
        .replaceAll('export function ', 'function ').replace('export default attach_app_drawer;', '')
        + '\nwindow.attach = attach_app_drawer; window.syncWidth = sync_drawer_width;';
    w.eval(`{ ${code} }`);
    w.eval(`{ ${settings_source
        .replace("import { sync_drawer_width } from '../app-drawer.js';", 'const sync_drawer_width = window.syncWidth;')
        .replace("import telemetry from '../../telemetry.js';", telemetry_stub)
        .replaceAll('export const ', 'const ').replaceAll('export function ', 'function ')
        .replace('export default { ensureSettingsDrawerButton, MARKER_CLASS, SETTINGS_DRAWER_SVG };', '')}
        window.ensureSettings = ensureSettingsDrawerButton; }`);
    const previous = d.getElementById('previous');
    const calls = [];
    const attach = (overrides = {}) => {
        const host = d.createElement('div');
        host.className = 'window ezil-desktop-window ezil-fullbleed';
        host.innerHTML = '<div class="window-body window-body-app"></div>';
        d.body.append(host);
        const drawer = w.attach(host, {
            variant: 'floating', title: 'My <computer>', icon: 'data:image/png;base64,AA==', flash_on_attach: false,
            traffic: { expand_supported: true, on_close: () => calls.push('close'),
                on_minimize: () => calls.push('minimize'), on_expand: () => calls.push('expand') },
            overflow: [
                { id: 'focus', label: 'Focus Chrome', className: 'dashboard-app-drawer-focus-chromium', onClick: () => calls.push('focus') },
                { id: 'second', label: 'Second', onClick: () => calls.push('second') },
            ],
            ...overrides,
        });
        return { host, drawer, api: drawer?.ezil_controls,
            q: selector => drawer.querySelector(selector),
            toggle: drawer?.querySelector('.dashboard-app-drawer-toggle') };
    };
    const key = (target, value, repeat = false) => target.dispatchEvent(new w.KeyboardEvent('keydown',
        { key: value, repeat, bubbles: true, cancelable: true }));
    const pointer = (target, type, pointerType = 'mouse') => {
        const event = new w.Event(type, { bubbles: ! ['pointerenter', 'pointerleave'].includes(type), cancelable: true });
        Object.defineProperty(event, 'pointerType', { value: pointerType });
        target.dispatchEvent(event);
    };
    return { w, d, dom, events, errors, uncaught, queries, previous, calls, attach, key, pointer, advance, frame,
        focused: () => focused, closed: () => closed, frames, timers };
}

async function test (name, fn, options) {
    const h = harness(options);
    try {
        await fn(h);
        // Let removal observers dispose while jsdom still has a document;
        // window.close() deletes that global before pending callbacks run.
        h.d.body.replaceChildren();
        await Promise.resolve();
        assert.deepEqual(h.uncaught, []);
        checks.push({ name, pass: true });
    }
    catch (error) { checks.push({ name, pass: false, error: error.stack }); }
    finally {
        h.d.body.replaceChildren();
        await Promise.resolve();
        h.dom.window.close();
    }
}
const collapsed = drawer => drawer.classList.contains('collapsed');
const tree = el => [el.tagName.toLowerCase(), el.getAttribute('class') || '', [...el.children].map(tree)];

await test('legacy DOM snapshot and unknown variant match the unchanged legacy attach', h => {
    const opts = { variant: undefined, actions: [{ id: 'minimize', label: 'Minimise', svg: '', onClick: () => {} }] };
    const a = h.attach(opts);
    const b = h.attach({ ...opts, variant: 'other' });
    assert.deepEqual(tree(a.drawer), ['div', 'dashboard-app-drawer ezil-app-drawer collapsed', [
        ['button', 'dashboard-app-drawer-toggle', [['span', 'dashboard-app-drawer-grabber', []]]],
        ['div', 'dashboard-app-drawer-clip', [['div', 'dashboard-app-drawer-controls', [
            ['img', 'dashboard-app-drawer-icon', []], ['span', 'dashboard-app-drawer-title', []],
            ['button', 'dashboard-app-drawer-btn dashboard-app-drawer-minimize', []],
            ['button', 'dashboard-app-drawer-btn dashboard-app-drawer-close', [['svg', '', [['line', '', []], ['line', '', []]]]]],
        ]]]],
    ]]);
    assert.equal(a.drawer.outerHTML, b.drawer.outerHTML);
    assert.equal(a.drawer.ezil_controls, undefined);
    assert.equal(a.drawer.style.getPropertyValue('--btn-count'), '2');
    assert.equal(a.host.className, 'window ezil-desktop-window ezil-fullbleed');
});

await test('floating hooks, traffic order, title text, toolbar, live region and initial tab stops', h => {
    const { drawer, api, toggle, q } = h.attach({ on_feedback: () => {} });
    assert.ok(drawer.matches('.dashboard-app-drawer.ezil-app-drawer.ezil-floating-drawer.collapsed'));
    assert.equal(drawer.firstElementChild, toggle);
    assert.equal(toggle.tabIndex, 0);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(q('[role="toolbar"]').getAttribute('aria-label'), 'Window controls');
    assert.deepEqual([...q('.ezil-traffic-lights').children].map(el => el.getAttribute('aria-label')),
        ['Close', 'Minimise', 'Enter full screen']);
    assert.ok(q('.dashboard-app-drawer-close.dashboard-app-drawer-btn'));
    assert.ok(q('.dashboard-app-drawer-minimize.dashboard-app-drawer-btn'));
    assert.equal(q('.dashboard-app-drawer-title').textContent, 'My <computer>');
    assert.equal(q('.ezil-drawer-status').getAttribute('aria-live'), 'polite');
    assert.ok(q('.ezil-drawer-actions').lastElementChild.matches('.ezil-drawer-feedback'));
    assert.ok([...q('[role="toolbar"]').querySelectorAll('button')].every(btn => btn.tabIndex === -1));
    assert.deepEqual(Object.keys(api).sort(), ['add_overflow_item', 'collapse', 'focus_grabber', 'reveal', 'set_fullscreen', 'set_status']);
});

await test('unsupported fullscreen and absent feedback omit their buttons', h => {
    const { q, api } = h.attach({ traffic: { expand_supported: false } });
    assert.equal(q('.ezil-traffic-expand'), null);
    assert.equal(q('.ezil-drawer-feedback'), null);
    api.set_fullscreen(true);
});

await test('set_fullscreen toggles pressed state and accessible label in both directions', h => {
    const { q, api } = h.attach();
    const expand = q('.ezil-traffic-expand');
    assert.equal(expand.getAttribute('aria-pressed'), 'false');
    api.set_fullscreen(true);
    assert.equal(expand.getAttribute('aria-pressed'), 'true');
    assert.equal(expand.getAttribute('aria-label'), 'Exit full screen');
    api.set_fullscreen(false);
    assert.equal(expand.getAttribute('aria-pressed'), 'false');
    assert.equal(expand.getAttribute('aria-label'), 'Enter full screen');
});

await test('roving Left/Right/Home/End wraps and Escape restores focus before reveal', h => {
    const { drawer, toggle, q } = h.attach();
    h.previous.focus();
    toggle.focus();
    assert.equal(collapsed(drawer), false);
    const buttons = [...q('[role="toolbar"]').querySelectorAll('button')];
    buttons[0].focus();
    h.key(buttons[0], 'ArrowLeft');
    assert.equal(h.d.activeElement, buttons.at(-1));
    h.key(h.d.activeElement, 'ArrowRight');
    assert.equal(h.d.activeElement, buttons[0]);
    h.key(h.d.activeElement, 'End');
    assert.equal(h.d.activeElement, buttons.at(-1));
    h.key(h.d.activeElement, 'Home');
    h.key(h.d.activeElement, 'ArrowRight');
    assert.equal(h.d.activeElement, buttons[1]);
    assert.deepEqual(buttons.filter(btn => btn.tabIndex === 0), [buttons[1]]);
    h.key(h.d.activeElement, 'Escape');
    assert.ok(collapsed(drawer));
    assert.equal(h.d.activeElement, h.previous);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
});

await test('Escape fallback focuses grabber without reopening when previous focus is removed', h => {
    const { drawer, api, toggle } = h.attach();
    h.previous.focus();
    api.reveal();
    api.focus_grabber();
    h.previous.remove();
    h.key(toggle, 'Escape');
    assert.ok(collapsed(drawer));
    assert.equal(h.d.activeElement, toggle);
});

await test('Escape falls back to grabber when reveal began on document body', h => {
    const { drawer, api, toggle } = h.attach();
    api.reveal();
    api.focus_grabber();
    h.key(toggle, 'Escape');
    assert.ok(collapsed(drawer));
    assert.equal(h.d.activeElement, toggle);
});

await test('Escape fallback handles a still-connected element that can no longer focus', h => {
    const { drawer, api, toggle } = h.attach();
    h.previous.focus();
    api.reveal();
    h.previous.disabled = true;
    api.focus_grabber();
    h.key(toggle, 'Escape');
    assert.ok(collapsed(drawer));
    assert.equal(h.d.activeElement, toggle);
});

await test('menu keyboard wraps, closes to overflow, then Escape restores original focus', h => {
    const { drawer, api, q } = h.attach();
    h.previous.focus();
    api.reveal();
    const more = q('.ezil-drawer-overflow');
    more.focus();
    h.key(more, 'Enter');
    const menu = q('[role="menu"]');
    const items = [...menu.children];
    assert.equal(menu.hidden, false);
    assert.equal(more.getAttribute('aria-expanded'), 'true');
    assert.equal(h.d.activeElement, items[0]);
    assert.ok(items.every(item => item.matches('button[role="menuitem"]')));
    assert.ok(items[0].classList.contains('dashboard-app-drawer-focus-chromium'));
    h.key(items[0], 'ArrowUp');
    assert.equal(h.d.activeElement, items[1]);
    h.key(items[1], 'ArrowDown');
    assert.equal(h.d.activeElement, items[0]);
    h.key(items[0], 'End');
    assert.equal(h.d.activeElement, items[1]);
    h.key(items[1], 'Home');
    assert.equal(h.d.activeElement, items[0]);
    h.key(items[0], 'Escape');
    assert.ok(menu.hidden);
    assert.equal(h.d.activeElement, more);
    assert.equal(more.getAttribute('aria-expanded'), 'false');
    assert.equal(collapsed(drawer), false);
    h.key(more, 'Escape');
    assert.ok(collapsed(drawer));
    assert.equal(h.d.activeElement, h.previous);
});

await test('menu button toggles, Tab dismisses, and Space activates a menu action once', h => {
    const { drawer, api, q } = h.attach();
    api.reveal();
    const more = q('.ezil-drawer-overflow');
    const menu = q('[role="menu"]');
    more.click();
    more.click();
    assert.ok(menu.hidden);
    more.click();
    h.key(h.d.activeElement, 'Tab');
    assert.ok(menu.hidden);
    assert.equal(h.d.activeElement, more);
    more.click();
    h.key(h.d.activeElement, ' ');
    assert.deepEqual(h.calls, ['focus']);
    assert.ok(menu.hidden);
    assert.ok(collapsed(drawer));
});

await test('empty overflow menu still closes with Escape', h => {
    const { q, api } = h.attach({ overflow: [] });
    api.reveal();
    const more = q('.ezil-drawer-overflow');
    more.focus();
    more.click();
    h.key(more, 'Escape');
    assert.ok(q('[role="menu"]').hidden);
    assert.equal(h.d.activeElement, more);
});

await test('overflow insertion is idempotent by id and preserves original callback', h => {
    const { q, api } = h.attach({ overflow: [] });
    api.add_overflow_item({ id: 'settings', label: 'Settings <text>', className: 'dashboard-app-drawer-settings', onClick: () => h.calls.push('original') });
    api.add_overflow_item({ id: 'settings', label: 'Duplicate', onClick: () => h.calls.push('duplicate') });
    assert.equal(q('[role="menu"]').children.length, 1);
    const item = q('.dashboard-app-drawer-settings');
    assert.equal(item.textContent, 'Settings <text>');
    assert.equal(item.querySelector('text'), null);
    item.click();
    assert.deepEqual(h.calls, ['original']);
});

await test('traffic callbacks and Feedback work; held activation does not repeat', h => {
    const { q, api, drawer } = h.attach({ on_feedback: () => h.calls.push('feedback') });
    api.reveal();
    const green = q('.ezil-traffic-expand');
    green.focus();
    h.key(green, 'Enter');
    h.key(green, 'Enter', true);
    assert.equal(collapsed(drawer), false);
    q('.dashboard-app-drawer-minimize').click();
    q('.dashboard-app-drawer-close').click();
    q('.ezil-drawer-feedback').click();
    assert.deepEqual(h.calls, ['expand', 'minimize', 'close', 'feedback']);
});

await test('set_status writes text into the live region without parsing markup', h => {
    const { q, api } = h.attach();
    api.set_status('Opening <Chrome>…');
    assert.equal(q('.ezil-drawer-status').textContent, 'Opening <Chrome>…');
    assert.equal(q('.ezil-drawer-status').children.length, 0);
    api.set_status('');
    assert.equal(q('.ezil-drawer-status').textContent, '');
});

for ( const [name, options, mode] of [
    ['fine mouse', {}, 'overlay'], ['coarse', { fine: false, coarse: true }, 'strip'],
    ['hybrid', { fine: true, coarse: true }, 'strip'], ['no hover', { fine: false }, 'strip'],
    ['phone class', { bodyClass: 'device-phone' }, 'strip'], ['tablet class', { bodyClass: 'device-tablet' }, 'strip'],
] ) {
    await test(`${name} selects ${mode} on drawer and window`, h => {
        const { host, drawer } = h.attach();
        assert.ok(host.classList.contains('ezil-floating-controls'));
        for ( const el of [host, drawer] ) {
            assert.ok(el.classList.contains(`ezil-mode-${mode}`));
            assert.equal(el.classList.contains(`ezil-mode-${mode === 'overlay' ? 'strip' : 'overlay'}`), false);
        }
    }, options);
}

await test('media changes and body device-class changes swap mode without rebuilding', async h => {
    const { host, drawer } = h.attach();
    const fine = h.queries.get('(hover: hover) and (pointer: fine)');
    const coarse = h.queries.get('(any-pointer: coarse)');
    fine.change(false);
    assert.ok(drawer.classList.contains('ezil-mode-strip'));
    fine.change(true);
    assert.ok(drawer.classList.contains('ezil-mode-overlay'));
    coarse.change(true);
    assert.ok(host.classList.contains('ezil-mode-strip'));
    coarse.change(false);
    h.d.body.classList.add('device-tablet');
    await Promise.resolve();
    assert.ok(drawer.classList.contains('ezil-mode-strip'));
    h.d.body.classList.remove('device-tablet');
    await Promise.resolve();
    assert.ok(drawer.classList.contains('ezil-mode-overlay'));
});

await test('only mouse hover reveals; leaving waits exactly 1500ms and re-entry cancels', h => {
    const { drawer } = h.attach();
    h.pointer(drawer, 'pointerenter', 'touch');
    h.pointer(drawer, 'pointerenter', 'pen');
    assert.ok(collapsed(drawer));
    h.pointer(drawer, 'pointerenter');
    h.pointer(drawer, 'pointerleave', 'touch');
    h.advance(10000);
    assert.equal(collapsed(drawer), false);
    h.pointer(drawer, 'pointerleave');
    h.advance(1499);
    assert.equal(collapsed(drawer), false);
    h.advance(1);
    assert.ok(collapsed(drawer));
    h.pointer(drawer, 'pointerenter');
    h.pointer(drawer, 'pointerleave');
    h.advance(1400);
    h.pointer(drawer, 'pointerenter');
    h.advance(1000);
    assert.equal(collapsed(drawer), false);
});

await test('collapse timer cannot hide focused controls; leaving focus starts a fresh timer', h => {
    const { drawer, q } = h.attach();
    h.pointer(drawer, 'pointerenter');
    q('.dashboard-app-drawer-close').focus();
    h.pointer(drawer, 'pointerleave');
    h.advance(1500);
    assert.equal(collapsed(drawer), false);
    h.previous.focus();
    h.advance(1499);
    assert.equal(collapsed(drawer), false);
    h.advance(1);
    assert.ok(collapsed(drawer));
});

await test('open menu vetoes timer even after focus leaves', h => {
    const { drawer, q } = h.attach();
    q('.ezil-drawer-overflow').click();
    h.previous.focus();
    h.pointer(drawer, 'pointerleave');
    h.advance(5000);
    assert.equal(collapsed(drawer), false);
    assert.equal(q('[role="menu"]').hidden, false);
});

await test('tap and keyboard reveal grabber; a later click collapses', h => {
    const { drawer, toggle } = h.attach();
    h.pointer(drawer, 'pointerenter', 'touch');
    toggle.focus();
    toggle.click();
    assert.equal(collapsed(drawer), false);
    h.advance(501);
    toggle.click();
    assert.ok(collapsed(drawer));
    h.key(toggle, ' ');
    assert.equal(collapsed(drawer), false);
});

await test('coarse outside press dismisses menu and drawer; inside presses do not', h => {
    const { drawer, q } = h.attach();
    q('.ezil-drawer-overflow').click();
    h.pointer(q('[role="menuitem"]'), 'pointerdown', 'touch');
    assert.equal(collapsed(drawer), false);
    h.pointer(h.previous, 'pointerdown', 'touch');
    assert.ok(collapsed(drawer));
    assert.ok(q('[role="menu"]').hidden);
}, { coarse: true, fine: false });

await test('fine outside mouse press does not dismiss; touch outside does', h => {
    const { drawer, api } = h.attach();
    api.reveal();
    h.pointer(h.previous, 'pointerdown');
    assert.equal(collapsed(drawer), false);
    h.pointer(h.previous, 'pointerdown', 'touch');
    assert.ok(collapsed(drawer));
});

await test('coarse iframe press dismisses without stealing stream focus; unrelated blur does not', h => {
    const { drawer, q, host } = h.attach();
    q('.ezil-drawer-overflow').click();
    h.previous.focus();
    h.w.dispatchEvent(new h.w.Event('blur'));
    h.advance(0);
    assert.equal(collapsed(drawer), false);
    const frame = h.d.createElement('iframe');
    host.append(frame);
    frame.focus();
    h.w.dispatchEvent(new h.w.Event('blur'));
    h.advance(0);
    assert.ok(collapsed(drawer));
    assert.ok(q('[role="menu"]').hidden);
    assert.equal(h.d.activeElement, frame);
}, { coarse: true });

await test('fine-pointer iframe blur does not force dismissal', h => {
    const { drawer, api, host } = h.attach();
    api.reveal();
    const frame = h.d.createElement('iframe');
    host.append(frame);
    frame.focus();
    h.w.dispatchEvent(new h.w.Event('blur'));
    h.advance(0);
    assert.equal(collapsed(drawer), false);
});

await test('window activation deduplicates pointerdown plus synthetic mousedown', h => {
    const { drawer } = h.attach();
    h.pointer(drawer, 'pointerdown', 'touch');
    drawer.dispatchEvent(new h.w.MouseEvent('mousedown', { bubbles: true }));
    h.advance(0);
    assert.equal(h.focused(), 1);
    drawer.dispatchEvent(new h.w.MouseEvent('mousedown', { bubbles: true }));
    h.advance(0);
    assert.equal(h.focused(), 2);
});

await test('intro paints collapsed for two frames and respects hover/focus vetoes', h => {
    const { drawer, toggle } = h.attach({ flash_on_attach: true });
    assert.ok(collapsed(drawer));
    h.frame();
    assert.ok(collapsed(drawer));
    h.frame();
    assert.equal(collapsed(drawer), false);
    h.advance(2600);
    assert.ok(collapsed(drawer));
    h.pointer(drawer, 'pointerenter');
    drawer.parentElement._ezil_drawer_flash();
    h.advance(2600);
    assert.equal(collapsed(drawer), false);
    h.pointer(drawer, 'pointerleave');
    toggle.focus();
    h.advance(1500);
    assert.equal(collapsed(drawer), false);
});

await test('Settings goes into floating overflow once and preserves legacy insertion', h => {
    const floating = h.attach();
    h.w.ensureSettings(floating.host, () => h.calls.push('settings'));
    h.w.ensureSettings(floating.host, () => h.calls.push('duplicate'));
    const item = floating.q('.dashboard-app-drawer-settings');
    assert.equal(item.parentElement.getAttribute('role'), 'menu');
    assert.equal(item.getAttribute('role'), 'menuitem');
    assert.equal(item.getAttribute('aria-label'), 'Settings');
    assert.equal(item.title, 'Settings');
    assert.equal(floating.drawer.querySelectorAll('.dashboard-app-drawer-settings').length, 1);
    item.click();
    assert.deepEqual(h.calls, ['settings']);
    const legacy = h.attach({ variant: undefined });
    h.w.ensureSettings(legacy.host, () => {});
    assert.equal(legacy.q('.dashboard-app-drawer-settings').nextElementSibling, legacy.q('.dashboard-app-drawer-close'));
    assert.equal(legacy.drawer.style.getPropertyValue('--btn-count'), '2');
});

await test('predeclared Settings is marked without duplication', h => {
    const { host, drawer } = h.attach({ overflow: [{ id: 'settings', label: 'Settings', className: 'dashboard-app-drawer-settings', onClick: () => {} }] });
    h.w.ensureSettings(host, () => {});
    assert.ok(drawer.classList.contains('ezil-has-settings-action'));
    assert.equal(drawer.querySelectorAll('.dashboard-app-drawer-settings').length, 1);
});

await test('throwing action is contained and reported; other controls remain usable', h => {
    const { q, api } = h.attach({ on_feedback: () => { throw new Error('callback failure'); } });
    q('.ezil-drawer-feedback').click();
    assert.equal(h.events.at(-1).code, 'drawer_handler_threw');
    api.reveal();
    q('.dashboard-app-drawer-close').click();
    assert.deepEqual(h.calls, ['close']);
});

await test('Settings preserves collapse/open telemetry without losing the open callback', h => {
    const { host, q } = h.attach();
    h.w.ensureSettings(host, () => { h.calls.push('settings'); throw new Error('open failure'); });
    host._dashboard_drawer_collapse = () => { throw new Error('collapse failure'); };
    q('.dashboard-app-drawer-settings').click();
    assert.deepEqual(h.calls, ['settings']);
    assert.deepEqual(h.events.map(entry => entry.code), ['collapse_threw', 'settings_handler_threw']);
});

await test('null window returns null and reports the existing contract violation', h => {
    assert.equal(h.w.attach(null, { variant: 'floating' }), null);
    assert.equal(h.events.at(-1).code, 'null_window');
});

await test('attach failure returns null, cleans partial chrome and reports telemetry', h => {
    h.w.matchMedia = () => { throw new Error('media setup failed'); };
    const { drawer, host } = h.attach();
    assert.equal(drawer, null);
    assert.equal(host.querySelector('.ezil-floating-drawer'), null);
    assert.equal(host.classList.contains('ezil-floating-controls'), false);
    assert.equal(h.events.at(-1).code, 'drawer_attach_failed');
});

await test('removed drawer releases observers, media/outside listeners and intro frames', async h => {
    const { host, drawer } = h.attach({ flash_on_attach: true });
    host.remove();
    await Promise.resolve();
    assert.ok([...h.queries.values()].every(query => query.listeners.size === 0));
    assert.equal(h.frames.size, 0);
    drawer.ezil_controls.reveal();
    h.pointer(h.previous, 'pointerdown', 'touch');
    assert.equal(collapsed(drawer), false);
    h.d.body.classList.add('device-phone');
    await Promise.resolve();
    assert.ok(drawer.classList.contains('ezil-mode-overlay'));
});

await test('attaching to a detached window keeps mode listeners until it is mounted and removed', async h => {
    const host = h.d.createElement('div');
    const drawer = h.w.attach(host, { variant: 'floating', flash_on_attach: false });
    assert.ok(drawer);
    h.d.body.classList.add('device-phone');
    await Promise.resolve();
    assert.ok(drawer.classList.contains('ezil-mode-strip'));
    h.d.body.append(host);
    await Promise.resolve();
    host.remove();
    await Promise.resolve();
    assert.ok([...h.queries.values()].every(query => query.listeners.size === 0));
});

await test('CSS is fully scoped, disables hit pad, reserves stable strip and uses traffic tokens', h => {
    const style = h.d.createElement('style');
    style.textContent = css;
    h.d.head.append(style);
    const rules = [];
    const collect = list => { for ( const rule of list ) { if ( rule.selectorText ) rules.push(rule); else if ( rule.cssRules ) collect(rule.cssRules); } };
    collect(style.sheet.cssRules);
    assert.ok(rules.length > 30);
    for ( const rule of rules ) {
        for ( const selector of rule.selectorText.split(',') ) assert.ok(selector.trim().startsWith('.ezil-desktop-window.ezil-fullbleed.ezil-floating-controls'));
    }
    const find = suffix => rules.find(rule => rule.selectorText.endsWith(suffix));
    assert.equal(find('.ezil-mode-overlay').style.getPropertyValue('--ezil-control-strip-height'), '0px');
    assert.equal(find('.ezil-mode-strip').style.getPropertyValue('--ezil-control-strip-height'), '43px');
    assert.equal(find('.dashboard-app-drawer-toggle::after').style.getPropertyValue('content'), 'none');
    assert.equal(find('> .ezil-floating-drawer').style.getPropertyValue('z-index'), '600');
    assert.ok(css.includes('--ezil-control-target: 44px'));
    assert.ok(css.includes('--ezil-control-strip-height: 59px'));
    assert.ok(css.includes('--ezil-control-target: 24px'));
    for ( const token of ['size', 'close', 'minimise', 'expand', 'glyph'] ) assert.ok(css.includes(`var(--win-ctl-${token})`));
    for ( const inset of ['top', 'left', 'right'] ) assert.ok(css.includes(`env(safe-area-inset-${inset}`));
    const reduced = [...style.sheet.cssRules].find(rule => rule.conditionText === '(prefers-reduced-motion: reduce)');
    assert.equal(reduced.cssRules[0].style.getPropertyValue('transition'), 'opacity 0.15s ease');
    assert.equal(reduced.cssRules[0].style.getPropertyPriority('transition'), 'important');
    assert.ok(rules.filter(rule => rule.selectorText.includes('collapsed')).every(rule => ! rule.style.getPropertyValue('--ezil-control-strip-height')));
});

for ( const check of checks ) {
    console.log(`${check.pass ? 'PASS' : 'FAIL'}  ${check.name}`);
    if ( check.error ) console.log(check.error);
}
const failed = checks.filter(check => ! check.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exitCode = failed.length ? 1 : 0;
