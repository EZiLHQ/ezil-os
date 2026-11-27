// Tab-local breadcrumbs for a consented feedback report, including after reload.
const key = 'ezil-os:code-lifecycle:v1';
const site = 'ezil-os:apps/code#lifecycle';
const maxAge = 30 * 60_000;
const limit = 20;
const codes = new Set([
    'opened', 'opened_after_reload', 'tab_hidden', 'tab_visible', 'page_hidden', 'page_restored',
    'frame_navigation', 'frame_leaving', 'frame_loaded', 'frame_confirmed', 'frame_recovery', 'runtime_return_check',
    'runtime_unknown', 'runtime_stopped', 'auth_reload', 'origin_reopen', 'recovery_offline', 'window_disposed',
]);

const scoped = scope => typeof scope?.userId === 'string' && scope.userId.length > 0
    && typeof scope.computerId === 'string' && scope.computerId.length > 0;

function entries (storage, scope, now) {
    if (!scoped(scope)) return [];
    const raw = storage.getItem(key);
    let saved;
    try { saved = JSON.parse(raw); } catch { return []; }
    if (saved?.userId !== scope.userId || saved?.computerId !== scope.computerId || !Array.isArray(saved.entries)) return [];
    return saved.entries.slice(-limit).filter(item => codes.has(item?.code) && Number.isFinite(item.t)
        && item.t <= now && now - item.t <= maxAge).map(({ code, t }) => ({ code, t }));
}

export function recentCodeLifecycle (scope, now = Date.now(), win = globalThis.window) {
    try {
        return entries(win.sessionStorage, scope, now).map(({ code, t }) => ({ eventClass: 'code_lifecycle', site, code, t }));
    } catch { return []; }
}

export function watchCodeLifecycle ({ scope, current, iframe, win = window, doc = document, now = Date.now }) {
    let stopped = false;
    function record (code) {
        try {
            if (stopped || !current() || !scoped(scope) || !codes.has(code)) return;
            const storage = win.sessionStorage;
            const t = now();
            const previous = entries(storage, scope, t);
            if (previous.at(-1)?.code === code) return;
            storage.setItem(key, JSON.stringify({ userId: scope.userId, computerId: scope.computerId,
                entries: [...previous, { code, t }].slice(-limit) }));
        } catch { /* Diagnostics must never affect Code. */ }
    }
    const visibility = () => record(doc.visibilityState === 'hidden' ? 'tab_hidden' : 'tab_visible');
    const hide = () => record('page_hidden');
    const show = event => { if (event.persisted) record('page_restored'); };
    const loaded = () => { if (iframe.getAttribute('src')) record('frame_loaded'); };
    doc.addEventListener('visibilitychange', visibility);
    win.addEventListener('pagehide', hide);
    win.addEventListener('pageshow', show);
    iframe.addEventListener('load', loaded);
    const navigation = win.performance?.getEntriesByType?.('navigation')?.[0];
    record(navigation?.type === 'reload' ? 'opened_after_reload' : 'opened');
    const stop = () => {
        record('window_disposed');
        stopped = true;
        doc.removeEventListener('visibilitychange', visibility);
        win.removeEventListener('pagehide', hide);
        win.removeEventListener('pageshow', show);
        iframe.removeEventListener('load', loaded);
    };
    return { record, stop };
}
