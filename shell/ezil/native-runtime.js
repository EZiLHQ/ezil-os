// Versioned, credential-free renderer contract. Authentication belongs to preload.
export const NATIVE_CONTRACT_VERSION = 2;
export const NATIVE_CAPABILITIES = Object.freeze({ contractVersion: 2, executionTarget: 'macos-host',
    isolation: 'trusted-native', editor: 'embedded-code-server', externalEditor: 'optional-microsoft-vscode',
    browser: 'native-chromium', cloudSync: 'disabled' });
// Reuse surface identities only after the old close request settles, retaining
// a monotonic generation across windows. Host tombstones can then reject every
// late message without growing for each tab/window opened during the session.
const surfaceSlots = new Map();
function leaseSurface (workspaceId, kind) {
    const key = `${workspaceId}:${kind}`;
    if (!surfaceSlots.has(key)) surfaceSlots.set(key, []);
    const slots = surfaceSlots.get(key);
    let slot = slots.find(value => !value.busy);
    if (!slot) { slot = { id: window.crypto.randomUUID(), generation: 0, busy: false }; slots.push(slot); }
    slot.busy = true; return slot;
}
export function isNative (ctx) {
    const state = ctx?.desktopState ?? ctx?.payload?.desktopState ?? globalThis.window?.__EZIL_BOOT__?.desktopState;
    // Unsupported native versions must fail locally, never fall through to hosted APIs.
    return state?.provider === 'native-macos';
}
export function nativeCompatible (ctx) {
    const state = ctx?.desktopState ?? ctx?.payload?.desktopState ?? globalThis.window?.__EZIL_BOOT__?.desktopState;
    return isNative(ctx) && Object.entries(NATIVE_CAPABILITIES).every(([key, value]) => state?.runtime?.[key] === value);
}
// These host operations may await a picker or confirmation for an arbitrary
// amount of time. The bridge has no dialog-phase signal: await the host result
// rather than report failure while it can still complete the user's action.
// Keep this explicit so noninteractive operations retain bounded deadlines.
const HOST_DIALOG_OPERATIONS = new Set([
    'workspace.import', 'workspace.attach', 'workspace.relink',
    'workspace.select', 'workspace.remove', 'workspace.openXcode',
]);
/** @param {import('../../native/src/contract.ts').NativeOperation} operation */
export async function nativeOperation (operation) {
    if ( typeof window.ezilNative?.operation !== 'function' ) return { ok: false, error: 'native_unavailable' };
    let timer;
    try {
        if (HOST_DIALOG_OPERATIONS.has(operation?.op)) return await window.ezilNative.operation(operation);
        const timeoutMs = operation?.op === 'provider.configure' ? 300_000 : operation?.op === 'code.open' ? 35_000 : 10_000;
        return await Promise.race([
            window.ezilNative.operation(operation),
            new Promise(resolve => { timer = setTimeout(() => resolve({ ok: false, error: 'native_unavailable' }), timeoutMs); }),
        ]);
    } catch { return { ok: false, error: 'native_unavailable' }; }
    finally { clearTimeout(timer); }
}
export function validBounds (b) {
    return b && ['x', 'y', 'width', 'height'].every(key => typeof b[key] === 'number' && Number.isFinite(b[key]) && Math.abs(b[key]) <= 32768)
        && b.width >= 0 && b.height >= 0;
}
// One outstanding status request per mounted surface. Failure never reloads
// editor content automatically: the user chooses Retry. Disposal also rejects
// late replies so an old window cannot cover its replacement.
export function watchNativeSurface (surface, onFailure, { schedule = setTimeout, cancel = clearTimeout, interval = 2000 } = {}) {
    if (!surface) return () => {};
    let stopped = false, timer;
    const check = async () => {
        if (stopped) return;
        let ready = false;
        try { ready = await surface.confirm(); } catch { /* Fixed failure UI only. */ }
        if (stopped) return;
        if (ready !== true) { stopped = true; onFailure(); }
        else timer = schedule(check, interval);
    };
    timer = schedule(check, interval);
    return () => { stopped = true; cancel(timer); };
}
export function browserAddress (value) {
    if (typeof value !== 'string' || value.length > 4096) return null;
    const raw = value.trim(); if (!raw) return null;
    const loopback = /^(localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/i.test(raw);
    try {
        const url = new URL(loopback ? `http://${raw}` : /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
        return !url.username && !url.password && (url.protocol === 'https:' || url.protocol === 'http:'
            && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) ? url.href : null;
    } catch { return null; }
}
export function browserOmnibox (value) {
    if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) return null;
    const raw = value.trim();
    if (!raw || /[@\\]/.test(raw) || /^(?:[~/.]|[a-z]:[\/\\])/i.test(raw)) return null;
    const urlLike = /[:.\/[\]]/.test(raw) || /^localhost(?:\b|$)/i.test(raw);
    if (urlLike) {
        // URL-like failures never become searches, including paths and bad ports.
        if (/\s/.test(raw) || (!/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[^/]*\.|^localhost[:/]|^\[::1\]/i.test(raw) && raw !== 'localhost')) return null;
        const candidate = !/^127\.0\.0\.1[:/]/.test(raw) && /^[^/:]+\.[^/:]+:\d+(?:\/|$)/.test(raw) ? `https://${raw}` : raw;
        const result = browserAddress(candidate); if (!result) return null;
        const host = new URL(result).hostname;
        if (host !== '[::1]' && !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) return null;
        return result;
    }
    const search = `https://www.google.com/search?q=${encodeURIComponent(raw)}`;
    return search.length <= 4096 ? search : null;
}
export function safeBrowserTabs (value) {
    if (!value || !Array.isArray(value.tabs) || value.tabs.length < 1 || value.tabs.length > 20
        || !Number.isInteger(value.activeIndex) || value.activeIndex < 0 || value.activeIndex >= value.tabs.length
        || !value.tabs.every(url => url === '' || typeof url === 'string' && browserAddress(url) === url)) return null;
    return { tabs: [...value.tabs], activeIndex: value.activeIndex };
}
const BROWSER_SHORTCUTS = ['address', 'reload', 'back', 'forward', 'new-tab', 'close-tab', 'next-tab', 'previous-tab', 'zoom-in', 'zoom-out', 'zoom-reset'];
function browserState (value) {
    return value && Number.isSafeInteger(value.revision) && value.revision > 0
        && (value.url === '' || browserAddress(value.url) === value.url)
        && typeof value.title === 'string' && value.title.length <= 512
        && typeof value.loading === 'boolean' && [null, 'navigation_failed'].includes(value.error)
        && typeof value.canGoBack === 'boolean' && typeof value.canGoForward === 'boolean'
        && (value.zoomFactor === undefined || typeof value.zoomFactor === 'number' && Number.isFinite(value.zoomFactor) && value.zoomFactor >= 0.25 && value.zoomFactor <= 5)
        ? { ...Object.fromEntries(['revision', 'url', 'title', 'loading', 'error', 'canGoBack', 'canGoForward'].map(key => [key, value[key]])), zoomFactor: value.zoomFactor ?? 1 } : null;
}
function frameUrl (value) {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number(url.port) >= 1024 && Number(url.port) <= 65535
            && !url.username && !url.password && !url.search && !url.hash ? url.href : null;
    } catch { return null; }
}
const EVENTS = new Set(['code_starting', 'code_ready', 'code_failed', 'browser_attached', 'browser_detached',
    'browser_failed', 'preview_ready', 'preview_failed', 'workspace_changed']);
export function sanitizeNativeEvents (events) {
    return (Array.isArray(events) ? events : []).slice(-100).flatMap(e => e && EVENTS.has(e.event) && Number.isFinite(e.t) && e.t >= 0
        ? [{ event: e.event, t: e.t, ...(Number.isFinite(e.durationMs) && e.durationMs >= 0 && e.durationMs <= 3600000 ? { durationMs: e.durationMs } : {}) }] : []);
}
export function selectRuntimeAdapter (ctx) {
    if (!isNative(ctx)) return null; // Existing cloud/session paths remain the hosted adapter.
    const call = op => nativeCompatible(ctx) ? nativeOperation(op) : Promise.resolve({ ok: false, error: 'native_version_unsupported' });
    const workspaceId = ctx?.computer?.id ?? ctx?.payload?.computer?.id ?? window.__EZIL_BOOT__?.computer?.id;
    return {
        capabilities: NATIVE_CAPABILITIES,
        operation: call,
        async diagnostics () { const r = await call({ op: 'diagnostics.read', workspaceId }); return sanitizeNativeEvents(r?.events); },
        surface (kind) {
            const slot = leaseSurface(workspaceId, kind), surfaceId = slot.id;
            let generation = 0, sequence = 0, disposed = false, epoch = 0;
            let currentState = null;
            const stateListeners = new Set(), shortcutListeners = new Set(), newTabListeners = new Set();
            const acceptState = value => {
                const state = browserState(value);
                if (disposed || !state || state.revision <= (currentState?.revision ?? 0)) return;
                currentState = state;
                for (const listener of stateListeners) listener({ ...state });
            };
            const matches = value => !disposed && generation > 0 && value?.workspaceId === workspaceId
                && value.surfaceId === surfaceId && value.generation === generation;
            const unsubscribeState = kind === 'browser' ? window.ezilNative?.subscribeBrowserState?.(value => { if (matches(value)) acceptState(value); }) : null;
            const unsubscribeShortcut = kind === 'browser' ? window.ezilNative?.subscribeBrowserShortcut?.(value => {
                if (matches(value) && BROWSER_SHORTCUTS.includes(value.action))
                    for (const listener of shortcutListeners) listener(value.action);
            }) : null;
            const unsubscribeNewTab = kind === 'browser' ? window.ezilNative?.subscribeBrowserNewTab?.(value => {
                if (matches(value) && typeof value.background === 'boolean' && typeof value.url === 'string' && browserAddress(value.url) === value.url)
                    for (const listener of newTabListeners) listener({ url: value.url, background: value.background });
            }) : null;
            let queue = Promise.resolve();
            const send = (verb, fields = {}) => {
                const op = { op: `${kind}.${verb}`, workspaceId, surfaceId, generation, sequence: ++sequence, ...fields };
                // Serialize IPC so layout/focus cannot overtake attach; close follows in-flight open.
                const pending = queue.then(async () => {
                    const r = await call(op);
                    if (r?.ok !== true || r.workspaceId !== workspaceId || r.surfaceId !== surfaceId || r.generation !== op.generation || r.sequence !== op.sequence) return { ok: false, error: 'native_surface_failed' };
                    if (kind === 'browser' && op.generation === generation) acceptState(r.browserState);
                    return r;
                });
                queue = pending.catch(() => {});
                return pending;
            };
            return {
                subscribeBrowserState (listener) { stateListeners.add(listener); if (currentState) listener({ ...currentState }); return () => stateListeners.delete(listener); },
                subscribeBrowserShortcut (listener) { shortcutListeners.add(listener); return () => shortcutListeners.delete(listener); },
                subscribeBrowserNewTab (listener) { newTabListeners.add(listener); return () => newTabListeners.delete(listener); },
                async open (requestedPort) {
                    if (disposed) return { ok: false, errorCode: 'native_surface_closed' };
                    const currentEpoch = ++epoch;
                    let port;
                    if (kind === 'preview') {
                        const r = await call({ op: 'preview.list', workspaceId });
                        const ports = (r?.ok === true && Array.isArray(r.ports) ? r.ports : []).filter(p => Number.isInteger(p) && p >= 1024 && p <= 65535);
                        port = requestedPort ?? ports[0];
                        if (disposed || epoch !== currentEpoch || !ports.includes(port)) return { ok: false, errorCode: 'app_preview_unavailable' };
                    }
                    generation = ++slot.generation; sequence = 0; currentState = null;
                    let r = await send(kind === 'browser' ? 'attach' : 'open', kind === 'preview' ? { port } : {});
                    const deadline = Date.now() + 30_000;
                    while (!disposed && epoch === currentEpoch && r.ok && r.state === 'starting' && Date.now() < deadline && kind !== 'browser') {
                        await new Promise(resolve => setTimeout(resolve, 250));
                        if (!disposed && epoch === currentEpoch) r = await send('status');
                    }
                    if (disposed || epoch !== currentEpoch || !r.ok || r.state !== 'ready') return { ok: false, errorCode: 'native_surface_failed' };
                    if (kind === 'browser') return { ok: true };
                    const url = frameUrl(r.url);
                    if (!url || (kind === 'preview' && Number(new URL(url).port) !== port)) return { ok: false, errorCode: 'native_surface_failed' };
                    return { ok: true, url };
                },
                async confirm () { if (disposed) return false; const r = await send('status'); return !disposed && r.ok === true && r.state === 'ready'; },
                layout (bounds, visible, occluded) {
                    if (disposed || !generation || kind !== 'browser' || !validBounds(bounds) || typeof visible !== 'boolean' || typeof occluded !== 'boolean') return Promise.resolve({ ok: false });
                    return send('layout', { bounds, visible, occluded });
                },
                focus () { if (!disposed && generation && kind === 'browser') return send('focus'); },
                navigate (url) { return !disposed && generation && kind === 'browser' ? send('navigate', { url }) : Promise.resolve({ ok: false }); },
                command (action) { return !disposed && generation && kind === 'browser' && ['back', 'forward', 'reload', 'zoom-in', 'zoom-out', 'zoom-reset'].includes(action)
                    ? send(action) : Promise.resolve({ ok: false }); },
                async snapshot () {
                    if (disposed || !generation || kind !== 'browser') return null;
                    const r = await send('snapshot');
                    return r.ok && typeof r.snapshot === 'string' && r.snapshot.length <= 2_000_000 && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(r.snapshot) ? r.snapshot : null;
                },
                dispose () {
                    if (disposed) return; disposed = true;
                    unsubscribeState?.(); unsubscribeShortcut?.(); unsubscribeNewTab?.(); stateListeners.clear(); shortcutListeners.clear(); newTabListeners.clear();
                    if (generation) void send(kind === 'browser' ? 'detach' : 'close').finally(() => { slot.busy = false; });
                    else slot.busy = false;
                },
            };
        },
    };
}
