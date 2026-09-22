import session from './session.js';
import { safeBrowserTabs } from './native-runtime.js';
import { applyWallpaper, applyAccent } from './ui/Settings/tabs/appearance.js';

const APPS = Object.freeze({ browser: 'desktop', code: 'code', preview: 'preview', settings: 'settings' });
const WALLPAPERS = new Set(['charcoal', 'teal-dusk', 'deep-slate', 'aurora']);
const ACCENTS = new Set(['teal', 'violet', 'amber', 'rose']);
export function safeDesktopPreferences (input = {}, width = 1280, height = 800) {
    const output = {};
    if (WALLPAPERS.has(input?.wallpaper)) output.wallpaper = input.wallpaper;
    if (ACCENTS.has(input?.accent)) output.accent = input.accent;
    if (Number.isInteger(input?.previewPort) && input.previewPort >= 1024 && input.previewPort <= 65535) output.previewPort = input.previewPort;
    const browser = safeBrowserTabs(input?.browser); if (browser) output.browser = browser;
    const seen = new Set();
    if (Array.isArray(input?.layout)) output.layout = input.layout.slice(0, 20).flatMap(row => {
        if (!row || !Object.hasOwn(APPS, row.app) || seen.has(row.app) || typeof row.minimized !== 'boolean'
            || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(row[key])) || row.width <= 0 || row.height <= 0) return [];
        seen.add(row.app);
        const w = Math.min(Math.max(1, width), Math.max(240, row.width));
        const h = Math.min(Math.max(1, height - 64), Math.max(160, row.height));
        return [{ app: row.app, x: Math.max(0, Math.min(width - w, row.x)), y: Math.max(0, Math.min(height - 64 - h, row.y)), width: w, height: h, minimized: row.minimized }];
    });
    return output;
}

// Read before app restore. Only allowlisted settings cross the host boundary.
export async function prepareNativePersistence (ctx) {
    if (ctx?.desktopState?.provider !== 'native-macos') return null;
    const workspaceId = ctx.computer?.id;
    let timer;
    let result;
    try {
        result = await Promise.race([window.ezilNative.operation({ op: 'desktop.read', workspaceId }),
            new Promise(resolve => { timer = setTimeout(() => resolve(null), 3000); })]);
    } catch { return null; } finally { clearTimeout(timer); }
    // A failed read must never overwrite an existing saved desktop with defaults.
    if (!result?.ok) return null;
    const preferences = safeDesktopPreferences(result.preferences, window.innerWidth, window.innerHeight);
    ctx.browserTabs = preferences.browser;
    session.set('settings.wallpaper', preferences.wallpaper ?? 'charcoal');
    session.set('settings.accent', preferences.accent ?? 'teal');
    applyWallpaper(preferences.wallpaper ?? 'charcoal'); applyAccent(preferences.accent ?? 'teal');
    try {
        const key = `ezil:preview-port:${workspaceId}`;
        if (preferences.previewPort) localStorage.setItem(key, String(preferences.previewPort)); else localStorage.removeItem(key);
    } catch { /* Restricted local storage must not prevent desktop startup. */ }
    return { workspaceId, preferences };
}

export async function restoreNativeDesktop (saved, ctx, launch) {
    if (!saved) return null;
    ctx.browserTabs = safeBrowserTabs(saved.preferences.browser) ?? undefined;
    let browser = ctx.browserTabs;
    const rememberBrowser = () => {
        for (const el of document.querySelectorAll('.window[data-app]')) {
            if (el.getAttribute('data-app') !== 'desktop') continue;
            const owner = el.getAttribute('data-ezil-computer-id'); if (owner && owner !== saved.workspaceId) continue;
            const current = safeBrowserTabs(el.ezilBrowserTabs?.());
            if (current) { browser = current; ctx.browserTabs = current; }
        }
    };
    const remembered = new WeakMap();
    for (const row of saved.preferences.layout ?? []) {
        let el;
        try { el = await launch(APPS[row.app], ctx); } catch { continue; }
        if (!el?.isConnected) continue;
        remembered.set(el, row);
        Object.assign(el.style, { left: `${row.x}px`, top: `${row.y}px`, width: `${row.width}px`, height: `${row.height}px`,
            minWidth: '0', minHeight: '0', maxWidth: '100vw', maxHeight: 'calc(100vh - 64px)', right: 'auto', bottom: 'auto' });
        if (row.minimized) window.$(el).hideWindow();
    }
    let timer, stopped = false, queue = Promise.resolve(), last = JSON.stringify(saved.preferences);
    const capture = () => {
        rememberBrowser();
        const layout = [];
        for (const el of document.querySelectorAll('.window[data-app]')) {
            const app = Object.keys(APPS).find(key => APPS[key] === el.getAttribute('data-app'));
            if (!app) continue;
            const owner = el.getAttribute('data-ezil-computer-id'); if (owner && owner !== saved.workspaceId) continue;
            const minimized = ['true', '1'].includes(el.getAttribute('data-is_minimized'));
            const rect = el.getBoundingClientRect();
            const previous = remembered.get(el);
            const original = key => Number.parseFloat(el.getAttribute(`data-orig-${key}`));
            const bounds = minimized ? previous ?? { x: original('left'), y: original('top'), width: original('width'), height: original('height') }
                : { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
            const row = { app, ...bounds, minimized }; remembered.set(el, row); layout.push(row);
        }
        let previewPort;
        try { previewPort = Number(localStorage.getItem(`ezil:preview-port:${saved.workspaceId}`)); } catch { /* Optional preference. */ }
        return safeDesktopPreferences({ wallpaper: session.get('settings.wallpaper'), accent: session.get('settings.accent'), previewPort, browser, layout }, window.innerWidth, window.innerHeight);
    };
    const flush = () => {
        clearTimeout(timer);
        const preferences = capture(), serialized = JSON.stringify(preferences);
        if (serialized === last) return queue;
        last = serialized;
        queue = queue.then(async () => {
            try { const result = await window.ezilNative.operation({ op: 'desktop.write', workspaceId: saved.workspaceId, preferences });
                if (!result?.ok && last === serialized) last = null;
            } catch { if (last === serialized) last = null; }
        });
        return queue;
    };
    const schedule = () => { if (!stopped) { rememberBrowser(); clearTimeout(timer); timer = setTimeout(flush, 500); } };
    const composition = event => {
        // Capture pre-animation geometry synchronously before minimize mutates it.
        const el = event.detail?.window;
        if (el && event.detail.visible === false && !['true', '1'].includes(el.getAttribute('data-is_minimized'))) {
            const r = el.getBoundingClientRect(); remembered.set(el, { x: r.x, y: r.y, width: r.width, height: r.height });
        }
        schedule();
    };
    const observer = new MutationObserver(records => {
        if (records.some(record => record.type === 'childList' ? [...record.addedNodes, ...record.removedNodes].some(node => node.matches?.('.window') || node.querySelector?.('.window')) : record.target.matches?.('.window'))) schedule();
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'data-is_minimized'] });
    const dispose = (save = true) => {
        if (stopped) return; stopped = true; if (save) void flush(); else clearTimeout(timer); observer.disconnect();
        window.removeEventListener('ezil:native-composition', composition); window.removeEventListener('ezil:preferences-changed', schedule);
        window.removeEventListener('pagehide', dispose); window.removeEventListener('ezil:teardown', dispose);
        window.removeEventListener('resize', schedule);
        document.removeEventListener('dashboard-app-windows-changed', schedule);
    };
    window.addEventListener('ezil:native-composition', composition); window.addEventListener('ezil:preferences-changed', schedule);
    window.addEventListener('pagehide', dispose); window.addEventListener('ezil:teardown', dispose);
    window.addEventListener('resize', schedule);
    document.addEventListener('dashboard-app-windows-changed', schedule);
    // Fixed host lifecycle hook: wait for the last write before destroying
    // the renderer. The host never supplies code, paths or commands here.
    window.ezilFlushDesktop = flush;
    return { flush, dispose };
}
