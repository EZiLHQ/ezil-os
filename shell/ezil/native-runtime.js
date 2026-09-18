// Versioned, credential-free renderer contract. Authentication belongs to preload.
export const NATIVE_CONTRACT_VERSION = 2;
export const NATIVE_CAPABILITIES = Object.freeze({ contractVersion: 2, executionTarget: 'macos-host',
    isolation: 'trusted-native', editor: 'embedded-code-server', externalEditor: 'optional-microsoft-vscode',
    browser: 'native-chromium', cloudSync: 'disabled' });
export function isNative (ctx) {
    const state = ctx?.desktopState ?? ctx?.payload?.desktopState ?? globalThis.window?.__EZIL_BOOT__?.desktopState;
    // Unsupported native versions must fail locally, never fall through to hosted APIs.
    return state?.provider === 'native-macos';
}
export function nativeCompatible (ctx) {
    const state = ctx?.desktopState ?? ctx?.payload?.desktopState ?? globalThis.window?.__EZIL_BOOT__?.desktopState;
    return isNative(ctx) && Object.entries(NATIVE_CAPABILITIES).every(([key, value]) => state?.runtime?.[key] === value);
}
/** @param {import('../../native/src/contract.ts').NativeOperation} operation */
export async function nativeOperation (operation) {
    if ( typeof window.ezilNative?.operation !== 'function' ) return { ok: false, error: 'native_unavailable' };
    let timer;
    try {
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
            const surfaceId = window.crypto.randomUUID();
            let generation = 0, sequence = 0, disposed = false, epoch = 0;
            let queue = Promise.resolve();
            const send = (verb, fields = {}) => {
                const op = { op: `${kind}.${verb}`, workspaceId, surfaceId, generation, sequence: ++sequence, ...fields };
                // Serialize IPC so layout/focus cannot overtake attach; close follows in-flight open.
                const pending = queue.then(async () => {
                    const r = await call(op);
                    if (r?.ok !== true || r.workspaceId !== workspaceId || r.surfaceId !== surfaceId || r.generation !== op.generation || r.sequence !== op.sequence) return { ok: false, error: 'native_surface_failed' };
                    return r;
                });
                queue = pending.catch(() => {});
                return pending;
            };
            return {
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
                    generation++; sequence = 0;
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
                command (action) { return !disposed && generation && kind === 'browser' && ['back', 'forward', 'reload'].includes(action)
                    ? send(action) : Promise.resolve({ ok: false }); },
                async snapshot () {
                    if (disposed || !generation || kind !== 'browser') return null;
                    const r = await send('snapshot');
                    return r.ok && typeof r.snapshot === 'string' && r.snapshot.length <= 2_000_000 && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(r.snapshot) ? r.snapshot : null;
                },
                dispose () { if (disposed) return; disposed = true; if (generation) void send(kind === 'browser' ? 'detach' : 'close'); },
            };
        },
    };
}
