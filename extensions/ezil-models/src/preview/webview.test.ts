import { expect, test } from 'bun:test';
import { createHash, webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { previewScript, previewSourceHash } from './script.generated';
import vectors from '../../../../docs/contracts/code-preview-v1.vectors.json';

// Execute the actual dependency-free browser bundle with a minimal DOM and VS Code bridge.
const bundle = await Bun.build({ entrypoints: [new URL('./webview.ts', import.meta.url).pathname], target: 'browser' });
if (!bundle.success) throw new Error('Preview browser bundle failed');
const sourceScript = await bundle.outputs[0]!.text();
const origin = 'https://3002-guac-u1-c1-app.ezil.org';
const sel = vectors.selection.accept[0]!.sel;

function browser(script = previewScript) {
    const posts: any[] = [], states: any[] = [], hellos: any[] = [];
    const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
    class Element {
        textContent = ''; hidden = false; disabled = false; value = ''; src = ''; style: Record<string, string> = {};
        dataset: Record<string, string> = {}; attrs = new Map<string, string>();
        listeners = new Map<string, (event?: unknown) => void>();
        contentWindow = { postMessage: (message: unknown, target: string) => hellos.push({ message, target }) };
        addEventListener(type: string, fn: (event?: unknown) => void) { this.listeners.set(type, fn); }
        setAttribute(key: string, value: string) { this.attrs.set(key, value); }
        hasAttribute(key: string) { return key === 'src' ? !!this.src : this.attrs.has(key); }
        emit(type: string, event?: unknown) { this.listeners.get(type)?.(event); }
    }
    const elements = new Map<string, Element>();
    for (const id of ['app', 'address', 'back', 'forward', 'reload', 'copy', 'external', 'retry', 'viewport', 'select', 'interact', 'status']) elements.set(id, new Element());
    const frame = elements.get('app')!;
    frame.dataset = { origin, url: `${origin}/preview-bootstrap?token=PRIVATE`, path: '/saved?token=OLD&tab=2', viewport: '390x844' };
    const window = new Element();
    runInNewContext(script, {
        window, document: { getElementById: (id: string) => elements.get(id) },
        acquireVsCodeApi: () => ({ postMessage: (value: unknown) => posts.push(value), setState: (state: unknown) => states.push(state) }),
        URL, URLSearchParams, crypto: webcrypto, Uint8Array, btoa,
        setTimeout: (fn: () => void, ms: number) => { const timer = { fn, ms, cancelled: false }; timers.push(timer); return timer; },
        clearTimeout: (timer?: { cancelled: boolean }) => { if (timer) timer.cancelled = true; },
    });
    const send = (type: string, payload = {}, overrides = {}) => window.emit('message', {
        source: frame.contentWindow, origin,
        data: { type: `ezil.preview.${type}`, v: 1, nonce: hellos.filter(value => value.message.type === 'ezil.preview.hello').at(-1)?.message.nonce, ...payload }, ...overrides,
    });
    const host = (message: unknown) => window.emit('message', { source: null, data: message });
    return { posts, states, hellos, timers, elements, frame, send, host };
}

test('browser persists only safe state and waits for ready after every load', () => {
    const b = browser();
    expect(b.states).toEqual([{ open: true, path: '/saved?tab=2', viewport: '390x844' }]);
    expect(JSON.stringify(b.states)).not.toMatch(/PRIVATE|OLD|url|token/i);
    expect(b.frame.src).toContain('token=PRIVATE');
    expect(b.elements.get('address')!.textContent).toBe(`${origin}/saved?tab=2`);
    expect(b.frame.style).toEqual({ width: '390px', height: '844px' });
    b.frame.emit('load');
    expect(b.hellos[0].message.type).toBe('ezil.preview.hello'); expect(b.hellos[0].target).toBe(origin);
    expect(b.hellos[0].message.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const waiting = b.timers.find(timer => timer.ms === 10_000)!;
    waiting.fn(); expect(b.elements.get('status')!.textContent).toBe('Waiting for the app…');
    b.send('ready', { doc: sel.doc }); expect(b.elements.get('status')!.textContent).toBe('Preview ready.');
    expect(waiting.cancelled).toBe(true);
    b.send('navigate', { doc: { ...sel.doc, path: '/next' } });
    expect(b.states.at(-1)).toEqual({ open: true, path: '/next', viewport: '390x844' });
    b.elements.get('back')!.emit('click'); expect(b.posts.at(-1)).toEqual({ type: 'history', path: '/pricing' });
    b.host({ type: 'load', url: `${origin}/preview/pricing` });
    b.frame.emit('load'); b.send('ready', { doc: sel.doc });
    b.elements.get('forward')!.emit('click'); expect(b.posts.at(-1)).toEqual({ type: 'history', path: '/next' });
});

test('browser forwards only valid frame messages in the current document and user-selected mode', () => {
    const b = browser(); b.frame.emit('load');
    const nonce = b.hellos[0].message.nonce;
    b.send('ready', { doc: sel.doc }); b.send('select', { sel });
    expect(b.posts.some(message => message.type === 'select')).toBe(false);
    b.elements.get('select')!.emit('click'); expect(b.elements.get('select')!.attrs.get('aria-pressed')).toBe('true');
    const before = b.posts.length;
    b.send('select', { sel }, { origin: 'https://evil.test' });
    b.send('select', { sel }, { source: {} }); b.send('select', { sel, nonce: 'BAD' });
    expect(b.posts).toHaveLength(before);
    b.send('select', { sel }); expect(b.posts.at(-1)).toEqual({ type: 'select', sel });
    b.host({ type: 'load', url: `${origin}/new` });
    const afterLoad = b.posts.length;
    b.send('select', { sel, nonce }); expect(b.posts).toHaveLength(afterLoad);
    b.frame.emit('load'); b.send('ready', { doc: sel.doc, nonce });
    expect(b.posts.at(-1).type).not.toBe('ready');
    b.send('ready', { doc: sel.doc });
    b.send('state', { state: 'upstream_error' }); expect(b.elements.get('status')!.textContent).toBe('upstream_error');
    expect(b.elements.get('retry')!.hidden).toBe(false);
    for (const timer of b.timers) if (!timer.cancelled) timer.fn();
    expect(b.elements.get('status')!.textContent).toBe('upstream_error');
    b.host({ type: 'load', url: 'https://3002-other-app.ezil.org/' }); expect(b.frame.src).toBe(`${origin}/new`);
});


test('the embedded VSIX payload matches the browser sources and runs with the same state boundary', () => {
    const hash = createHash('sha256');
    for (const file of ['contract.ts', 'messages.ts', 'state.ts', 'webview.ts']) hash.update(readFileSync(new URL(file, import.meta.url)));
    expect(previewSourceHash).toBe(hash.digest('hex'));
    expect(browser(sourceScript).states).toEqual(browser(previewScript).states);
});
