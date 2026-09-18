import { selectRuntimeAdapter, validBounds } from '../native-runtime.js';
import AppSpinner from '../ui/app-spinner.js';
import { computeBootUiState } from '../boot-phases.js';

const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
const shown = el => {
    const css = getComputedStyle(el);
    return !el.hidden && css.display !== 'none' && css.visibility !== 'hidden' && css.opacity !== '0';
};
/** DOM cover hook: dispatch ezil:native-cover with { covered: boolean } on this UIWindow.
 * Host snapshots are raster-only, never HTML; any shell overlay hides the entire native view.
 */
export function bindNativeBrowser (el, ctx) {
    const surface = selectRuntimeAdapter(ctx).surface('browser');
    const body = el.querySelector('.window-body');
    const frame = el.querySelector('.window-app-iframe');
    frame.hidden = true;
    body.style.position = 'relative';
    const toolbar = document.createElement('form');
    toolbar.className = 'ezil-native-browser-toolbar';
    Object.assign(toolbar.style, { position: 'absolute', inset: '0 0 auto 0', height: '42px', display: 'flex', gap: '6px', alignItems: 'center', padding: '6px 8px', boxSizing: 'border-box', background: 'rgba(24,25,27,.96)', borderBottom: '1px solid rgba(255,255,255,.1)', zIndex: '2' });
    const button = (label, action, title) => {
        const control = document.createElement('button'); control.type = 'button'; control.textContent = label; control.title = title;
        control.dataset.action = action; Object.assign(control.style, { width: '30px', height: '28px', border: '0', borderRadius: '6px', background: 'transparent', color: 'inherit' });
        toolbar.appendChild(control); return control;
    };
    const back = button('‹', 'back', 'Back'), forward = button('›', 'forward', 'Forward'), reload = button('↻', 'reload', 'Reload');
    const address = document.createElement('input'); address.type = 'text'; address.inputMode = 'url'; address.autocomplete = 'off'; address.spellcheck = false;
    address.placeholder = 'Enter a web address'; address.setAttribute('aria-label', 'Browser address');
    Object.assign(address.style, { flex: '1', minWidth: '80px', height: '28px', border: '1px solid rgba(255,255,255,.16)', borderRadius: '7px', padding: '0 10px', color: 'inherit', background: 'rgba(255,255,255,.08)' });
    toolbar.appendChild(address); body.appendChild(toolbar);
    const viewport = document.createElement('div'); viewport.className = 'ezil-native-browser-viewport';
    Object.assign(viewport.style, { position: 'absolute', inset: '42px 0 0 0', overflow: 'hidden', background: '#111' }); body.appendChild(viewport);
    const cover = document.createElement('img');
    cover.className = 'ezil-native-browser-cover';
    cover.alt = ''; cover.hidden = true;
    Object.assign(cover.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: 'fill', pointerEvents: 'none' });
    cover.style.background = '#111'; viewport.appendChild(cover);
    let disposed = false, ready = false, forcedCover = false, raf, lastLayout, sending = false, wasOccluded = false, wasFocused = false, attempt = 0;
    const progress = AppSpinner({ label: 'Opening Browser…', onRetry: () => { void start(); } });
    viewport.appendChild(progress.el);
    const trace = ctx.trace ?? { step () {}, end () {} };
    async function start () {
        const current = ++attempt;
        ready = false; lastLayout = null;
        progress.el.hidden = false;
        progress.render(computeBootUiState({ requestStatus: 'pending', elapsedMs: 0 }));
        const result = await surface.open();
        if (disposed || current !== attempt) return;
        ready = result.ok;
        progress.el.hidden = ready;
        for (const control of [back, forward, reload, address]) control.disabled = !ready;
        if (!ready) progress.render(computeBootUiState({ requestStatus: 'error', elapsedMs: 0, errorCode: 'native_surface_failed' }));
        trace.step(ready ? 'confirm_ok' : 'confirm_error'); trace.end(ready ? 'ok' : 'error');
    }
    function sample () {
        if (disposed) return;
        raf = requestAnimationFrame(sample);
        if (!ready || sending) return;
        const rect = viewport.getBoundingClientRect();
        const bounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        if (!validBounds(bounds)) return;
        const visible = el.isConnected && shown(el) && el.getAttribute('data-is_minimized') !== 'true'
            && el.getAttribute('data-is_minimized') !== '1' && el.getAttribute('data-closing') !== '1'
            && document.visibilityState !== 'hidden' && bounds.width > 0 && bounds.height > 0;
        const z = Number(getComputedStyle(el).zIndex) || 0;
        const occluded = forcedCover || [...document.querySelectorAll('.window, .context-menu, .ui-context-menu, .popover, .ui-popover, .start-menu, .ezil-launcher, .context-menu-sheet-backdrop, .ui-alert, .window-disabled-overlay, [data-native-occluder]')]
            .some(other => other !== el && !el.contains(other) && shown(other)
                && (!other.classList.contains('window') || (Number(getComputedStyle(other).zIndex) || 0) >= z)
                && overlaps(bounds, other.getBoundingClientRect()));
        const focused = el.classList.contains('window-active') && visible && !occluded;
        if (focused && !wasFocused) void surface.focus();
        wasFocused = focused;
        const layout = JSON.stringify({ bounds, visible, occluded });
        if (layout === lastLayout) return;
        lastLayout = layout; sending = true;
        // Capture while visible, then let the host detach it. The DOM image never covers shell chrome.
        void (async () => {
            if (!disposed && occluded && !wasOccluded) {
                const snapshot = await surface.snapshot();
                if (!disposed) { if (snapshot) cover.src = snapshot; else cover.removeAttribute('src'); cover.hidden = false; }
            }
            const result = await surface.layout(bounds, visible, occluded);
            if (!result.ok) lastLayout = null;
            if (!occluded) { cover.hidden = true; cover.removeAttribute('src'); }
            wasOccluded = occluded;
        })().finally(() => { sending = false; });
    }
    const onCover = ev => { forcedCover = ev.detail?.covered === true; lastLayout = null; };
    const onFocus = () => { if (ready) void surface.focus(); };
    el.addEventListener('ezil:native-cover', onCover);
    el.addEventListener('pointerdown', onFocus);
    const dispose = () => {
        if (disposed) return;
        disposed = true; cancelAnimationFrame(raf); surface.dispose();
        el.removeEventListener('ezil:native-cover', onCover); el.removeEventListener('pointerdown', onFocus);
        window.removeEventListener('ezil:teardown', dispose);
        cover.remove(); trace.step('disposed'); trace.end('skipped');
    };
    el.on_before_exit = async () => { dispose(); return true; };
    window.addEventListener('ezil:teardown', dispose);
    const normalise = value => {
        const raw = value.trim(); if (!raw) return null;
        try { return new URL(raw).href; } catch { try { return new URL(`https://${raw}`).href; } catch { return null; } }
    };
    toolbar.addEventListener('submit', event => {
        event.preventDefault(); const url = normalise(address.value); if (!url || !ready) return;
        address.value = url; void surface.navigate(url);
    });
    for (const control of [back, forward, reload]) control.addEventListener('click', () => { if (ready) void surface.command(control.dataset.action); });
    for (const control of [back, forward, reload, address]) control.disabled = true;
    raf = requestAnimationFrame(sample);
    void start();
    return el;
}
