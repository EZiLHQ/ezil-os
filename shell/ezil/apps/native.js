import { selectRuntimeAdapter, validBounds, browserOmnibox, safeBrowserTabs } from '../native-runtime.js';
import AppSpinner from '../ui/app-spinner.js';
import { computeBootUiState } from '../boot-phases.js';

const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
const shown = el => {
    const css = getComputedStyle(el);
    return !el.hidden && css.display !== 'none' && css.visibility !== 'hidden' && css.opacity !== '0';
};
export async function openSecureBrowser (ctx, destination) {
    const adapter = selectRuntimeAdapter(ctx);
    const workspaceId = ctx?.computer?.id ?? ctx?.payload?.computer?.id ?? window.__EZIL_BOOT__?.computer?.id;
    const result = await adapter?.operation({ op: 'secureBrowser.open', workspaceId, ...(destination ? { destination } : {}) });
    if (result?.opened) return 'Opened in Google Chrome. Sign in there; the session stays in this workspace’s Chrome profile.';
    return ({ missing: 'Install Google Chrome from google.com/chrome, then try again.',
        outdated: 'Update Google Chrome using Chrome → About Google Chrome, then try again.',
        untrusted: 'Chrome’s Google signature could not be verified. Reinstall Chrome from google.com/chrome.',
        profile_busy: 'This Chrome profile is busy. Close its Chrome windows and try again.' })[result?.reason] || 'Secure Browser could not open. Check Chrome and try again. Only HTTPS websites are supported.';
}
export function bindNativeBrowser (el, ctx) {
    const adapter = selectRuntimeAdapter(ctx), body = el.querySelector('.window-body');
    el.querySelector('.window-app-iframe').hidden = true; body.style.position = 'relative';
    const chrome = document.createElement('div'); chrome.className = 'ezil-native-browser-chrome';
    const strip = document.createElement('div'); strip.className = 'ezil-native-browser-tabs'; strip.setAttribute('role', 'tablist'); strip.setAttribute('aria-label', 'Browser tabs');
    const add = document.createElement('button'); add.type = 'button'; add.className = 'ezil-native-browser-add'; add.textContent = '+'; add.setAttribute('aria-label', 'New tab');
    const tabRow = document.createElement('div'); tabRow.className = 'ezil-native-browser-tab-row'; tabRow.append(strip, add);
    const toolbar = document.createElement('form'); toolbar.className = 'ezil-native-browser-toolbar';
    const button = (label, action, title) => {
        const control = document.createElement('button'); control.type = 'button'; control.textContent = label; control.title = title; control.setAttribute('aria-label', title);
        control.dataset.action = action; toolbar.appendChild(control); return control;
    };
    const back = button('‹', 'back', 'Back'), forward = button('›', 'forward', 'Forward'), reload = button('↻', 'reload', 'Reload');
    const address = document.createElement('input'); address.type = 'text'; address.inputMode = 'url'; address.autocomplete = 'off'; address.spellcheck = false;
    address.placeholder = 'Search Google or enter a web address'; address.setAttribute('aria-label', 'Browser address');
    const zoomOut = button('−', 'zoom-out', 'Zoom out');
    const zoomReset = button('100%', 'zoom-reset', 'Reset page zoom'); zoomReset.className = 'ezil-native-browser-zoom-value';
    const zoomIn = button('+', 'zoom-in', 'Zoom in');
    const status = document.createElement('span'); status.setAttribute('role', 'status'); toolbar.append(address, zoomOut, zoomReset, zoomIn, status);
    const auth = document.createElement('div'); auth.className = 'ezil-native-browser-auth';
    const hint = document.createElement('span'); hint.textContent = 'Google sign-in requires a normal Chrome window. Embedded tabs are for browsing and previews.';
    const secure = document.createElement('button'); secure.type = 'button'; secure.textContent = 'Open in Secure Browser';
    const secureStatus = document.createElement('span'); secureStatus.setAttribute('role', 'status');
    auth.append(hint, secure, secureStatus); chrome.append(tabRow, toolbar, auth); body.appendChild(chrome);
    const viewport = document.createElement('div'); viewport.className = 'ezil-native-browser-viewport';
    const cover = document.createElement('div'); cover.className = 'ezil-native-browser-cover'; cover.hidden = true;
    viewport.appendChild(cover); body.appendChild(viewport);
    const tabs = [], overlays = new Set();
    let active, disposed = false, forcedCover = false, explicitlyHidden = false, raf, nextId = 0;
    let composition = Promise.resolve(), compositionRevision = 0, lastComposition, canFocus = false;
    const trace = ctx.trace ?? { step () {}, end () {} };
    const progress = AppSpinner({ label: 'Opening Browser…', onRetry: () => { if (active) void start(active); },
        failureCopy: { title: 'Browser is unavailable', body: 'The local browser could not start. Try again. If this continues, relaunch EZiL OS.' } });
    viewport.appendChild(progress.el);
    const alive = tab => !disposed && tabs.includes(tab);
    const changed = () => window.dispatchEvent(new window.CustomEvent('ezil:preferences-changed'));
    // Preserve a validated submission during startup/navigation, but never an
    // unsubmitted address draft. Committed native state replaces it on arrival.
    const destination = tab => tab.submittedURL || tab.url;
    secure.addEventListener('click', async () => {
        secure.disabled = true;
        try { secureStatus.textContent = await openSecureBrowser(ctx, active ? destination(active) : undefined); }
        finally { secure.disabled = false; }
    });
    el.ezilBrowserTabs = () => ({ tabs: tabs.map(destination), activeIndex: Math.max(0, tabs.indexOf(active)) });
    function render () {
        if (!active || disposed) return;
        for (const tab of tabs) {
            tab.label.textContent = tab.state.title || destination(tab) || 'New tab'; tab.label.title = tab.label.textContent;
            tab.label.setAttribute('aria-selected', String(tab === active)); tab.label.tabIndex = tab === active ? 0 : -1;
            tab.label.setAttribute('aria-busy', String(tab.opening || tab.state.loading)); tab.label.dataset.failed = String(tab.failed || !!tab.state.error);
            tab.close.setAttribute('aria-label', `Close ${tab.state.title || tab.url || 'new tab'}`);
        }
        add.disabled = tabs.length >= 20; add.title = add.disabled ? 'Maximum of 20 tabs' : 'New tab';
        const tab = active, state = tab.state;
        address.value = tab.editing ? tab.draft : destination(tab); address.disabled = false;
        back.disabled = !tab.ready || !state.canGoBack; forward.disabled = !tab.ready || !state.canGoForward;
        reload.disabled = tab.opening; reload.title = tab.failed ? 'Retry' : 'Reload';
        zoomReset.textContent = `${Math.round((state.zoomFactor ?? 1) * 100)}%`;
        zoomOut.disabled = !tab.ready || (state.zoomFactor ?? 1) <= 0.25; zoomIn.disabled = !tab.ready || (state.zoomFactor ?? 1) >= 5;
        status.textContent = tab.invalid ? 'Enter a safe address or search' : tab.failed || state.error ? 'Page failed to load' : state.loading ? 'Loading…' : '';
        address.setAttribute('aria-invalid', String(tab.invalid || !!state.error)); viewport.setAttribute('aria-busy', String(tab.opening || state.loading));
        el.dataset.browserTitle = state.title;
        const title = el.querySelector('.window-head-title'); if (title) title.textContent = state.title || 'Browser';
        progress.el.hidden = !tab.opening && !tab.failed;
        if (!progress.el.hidden) progress.render(computeBootUiState({ requestStatus: tab.failed ? 'error' : 'pending', elapsedMs: 0, errorCode: tab.failed ? 'native_surface_failed' : undefined }));
    }
    async function start (tab) {
        if (!alive(tab) || tab.opening || tab.ready) return;
        tab.opening = true; tab.failed = false;
        if (!tab.surface) {
            tab.surface = adapter.surface('browser');
            tab.unsubscribers = [tab.surface.subscribeBrowserState(state => {
                if (!alive(tab)) return;
                if (tab.submittedURL) {
                    if (state.loading) tab.sawSubmittedLoad = true;
                    if (state.url && (state.url !== tab.state.url || state.url === tab.submittedURL
                        || state.error || !state.loading && tab.sawSubmittedLoad)) {
                        tab.submittedURL = null; tab.sawSubmittedLoad = false; changed();
                    }
                }
                tab.state = state;
                if (state.url && state.url !== tab.url) { tab.url = state.url; tab.retryURL = null; changed(); }
                render();
            }), tab.surface.subscribeBrowserShortcut(action => { if (alive(tab) && active === tab) shortcut(action); }),
            tab.surface.subscribeBrowserNewTab(({ url, background }) => { if (alive(tab)) createTab(url, !background); })];
        }
        render(); const result = await tab.surface.open(); if (!alive(tab)) return;
        tab.opening = false; tab.ready = result.ok; tab.failed = !result.ok;
        if (tab.ready && (tab.pendingURL || tab.url)) { const url = tab.pendingURL || tab.url; tab.pendingURL = null; navigateTab(tab, url); }
        render(); sample(false); trace.step(tab.ready ? 'confirm_ok' : 'confirm_error');
    }
    function navigateTab (tab, url) {
        tab.submittedURL = url; tab.sawSubmittedLoad = false; changed();
        tab.retryURL = url; const revision = tab.navigation = (tab.navigation ?? 0) + 1;
        void tab.surface.navigate(url).then(result => {
            if (alive(tab) && revision === tab.navigation && !result.ok) { tab.state = { ...tab.state, loading: false, error: 'navigation_failed' }; render(); }
        });
    }
    function selectTab (tab, focusAddress = false) {
        if (!alive(tab)) return;
        if (active?.editing) active.draft = address.value;
        active = tab; render(); sample(false); void start(tab); changed();
        if (focusAddress || tab.editing || !destination(tab)) { tab.editing = true; tab.draft = address.value; address.focus(); if (focusAddress) address.select(); }
    }
    function createTab (url = '', select = true) {
        if (disposed || tabs.length >= 20) { status.textContent = 'Maximum of 20 tabs'; return null; }
        const tab = { id: ++nextId, url, draft: url, editing: false, ready: false, opening: false, failed: false, invalid: false,
            state: { url: '', title: '', loading: false, error: null, canGoBack: false, canGoForward: false, zoomFactor: 1 }, surface: null, unsubscribers: [] };
        tab.node = document.createElement('div'); tab.node.className = 'ezil-native-browser-tab'; tab.node.setAttribute('role', 'presentation');
        tab.label = document.createElement('button'); tab.label.type = 'button'; tab.label.setAttribute('role', 'tab'); tab.label.addEventListener('click', () => selectTab(tab));
        tab.close = document.createElement('button'); tab.close.type = 'button'; tab.close.className = 'ezil-native-browser-tab-close'; tab.close.textContent = '×'; tab.close.addEventListener('click', () => closeTab(tab));
        tab.node.append(tab.label, tab.close); strip.appendChild(tab.node); tabs.push(tab);
        if (select) selectTab(tab, !url); else render(); changed(); return tab;
    }
    function closeTab (tab) {
        if (!alive(tab)) return;
        const index = tabs.indexOf(tab), wasActive = tab === active;
        tabs.splice(index, 1); tab.unsubscribers.forEach(unsubscribe => unsubscribe()); tab.surface?.dispose(); tab.node.remove();
        if (wasActive) { active = null; if (tabs.length) selectTab(tabs[Math.min(index, tabs.length - 1)]); else createTab(); }
        render(); sample(false); changed();
    }
    function shortcut (action) {
        if (!active || disposed) return;
        if (action === 'new-tab') { createTab(); return; }
        if (action === 'close-tab') { closeTab(active); return; }
        if (action === 'next-tab' || action === 'previous-tab') { selectTab(tabs[(tabs.indexOf(active) + (action === 'next-tab' ? 1 : tabs.length - 1)) % tabs.length]); if (!active.editing && active.ready) focusPage(); return; }
        if (action === 'address') { active.editing = true; active.draft = address.value; address.focus(); address.select(); }
        else if (action === 'reload' && !active.ready) void start(active);
        else if (action === 'reload' && active.state.error && active.retryURL) navigateTab(active, active.retryURL);
        else if (active.ready) void active.surface.command(action);
    }
    function sample (schedule = true) {
        if (disposed) return;
        if (schedule) raf = requestAnimationFrame(() => sample());
        const chromeRect = chrome.getBoundingClientRect(), chromeHeight = chromeRect.height;
        if (chromeRect.width > 0) chrome.dataset.compact = String(chromeRect.width <= 530);
        if (chromeHeight > 0) body.style.setProperty('--ezil-browser-chrome-height', `${chromeHeight}px`);
        const rect = viewport.getBoundingClientRect(), bounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        if (!validBounds(bounds)) return;
        const visible = !explicitlyHidden && el.isConnected && shown(el) && !['true', '1'].includes(el.getAttribute('data-is_minimized'))
            && el.getAttribute('data-closing') !== '1' && document.visibilityState !== 'hidden' && bounds.width > 0 && bounds.height > 0;
        const z = Number(getComputedStyle(el).zIndex) || 0;
        const occluded = forcedCover || overlays.size > 0 || [...document.querySelectorAll('.window, .context-menu, .ui-context-menu, .popover, .ui-popover, .start-menu, .ezil-launcher, .context-menu-sheet-backdrop, .ui-alert, .window-disabled-overlay, [data-native-occluder]')]
            .some(other => other !== el && !el.contains(other) && shown(other)
                && (!other.classList.contains('window') || (Number(getComputedStyle(other).zIndex) || 0) >= z) && overlaps(bounds, other.getBoundingClientRect()));
        canFocus = visible && !occluded; cover.hidden = !occluded;
        const key = JSON.stringify({ bounds, visible, occluded, active: active?.id, ready: tabs.filter(tab => tab.ready).map(tab => tab.id) });
        if (lastComposition === key) return;
        lastComposition = key; const revision = ++compositionRevision, selected = active;
        // Separate surface queues: hide old tabs before showing the selected one.
        composition = composition.then(async () => {
            if (disposed || revision !== compositionRevision) return;
            const hidden = await Promise.all(tabs.filter(tab => tab.ready && tab !== selected).map(tab => tab.surface.layout(bounds, false, true)));
            if (hidden.some(result => !result.ok)) { if (lastComposition === key) lastComposition = null; return; }
            if (disposed || revision !== compositionRevision || !alive(selected) || !selected.ready) return;
            const result = await selected.surface.layout(bounds, visible, occluded);
            if (!result.ok && lastComposition === key) lastComposition = null;
        }).catch(() => { if (lastComposition === key) lastComposition = null; });
    }
    function focusPage () {
        const tab = active; sample(false);
        void composition.then(() => { if (alive(tab) && active === tab && tab.ready && canFocus) void tab.surface.focus(); });
    }
    const onCover = event => { forcedCover = event.detail?.covered === true; sample(false); };
    const onComposition = event => {
        const detail = event.detail;
        if (detail?.window === el && typeof detail.visible === 'boolean') explicitlyHidden = !detail.visible;
        if (detail?.overlay) { if (detail.open) overlays.add(detail.overlay); else overlays.delete(detail.overlay); }
        sample(false); if (detail?.focus === el && !chrome.contains(document.activeElement) && !detail.pointer) focusPage();
    };
    const onFocus = event => { if (viewport.contains(event.target)) focusPage(); };
    const onKey = event => {
        if (!el.classList.contains('window-active') || event.altKey) return;
        let action;
        if (event.ctrlKey && event.key === 'Tab') action = event.shiftKey ? 'previous-tab' : 'next-tab';
        else if (event.metaKey || event.ctrlKey) action = ({ l: 'address', r: 'reload', '[': event.shiftKey ? 'previous-tab' : 'back', ']': event.shiftKey ? 'next-tab' : 'forward', '{': 'previous-tab', '}': 'next-tab', t: 'new-tab', w: 'close-tab', '+': 'zoom-in', '=': 'zoom-in', '-': 'zoom-out', '0': 'zoom-reset' })[event.key.toLowerCase()];
        if (action) { event.preventDefault(); event.stopPropagation(); shortcut(action); }
    };
    strip.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (tabs.indexOf(active) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
        selectTab(tabs[index]); active.label.focus();
    });
    add.addEventListener('click', () => createTab());
    address.addEventListener('focus', () => { if (active) { active.editing = true; active.draft = address.value; } });
    address.addEventListener('input', () => { if (active) { active.editing = true; active.draft = address.value; active.invalid = false; } });
    address.addEventListener('keydown', event => { if (event.key === 'Escape' && active) { active.editing = false; active.invalid = false; render(); address.blur(); focusPage(); } });
    toolbar.addEventListener('submit', event => {
        event.preventDefault(); const tab = active, url = browserOmnibox(address.value); if (!tab) return;
        if (!url) { tab.invalid = true; render(); return; }
        tab.editing = false; tab.invalid = false; tab.pendingURL = url; tab.submittedURL = url; tab.sawSubmittedLoad = false; changed(); address.blur();
        if (tab.ready) { tab.pendingURL = null; navigateTab(tab, url); } else void start(tab);
        render(); focusPage();
    });
    for (const control of [back, forward, reload, zoomOut, zoomReset, zoomIn]) control.addEventListener('click', () => shortcut(control.dataset.action));
    window.addEventListener('ezil:native-composition', onComposition); window.addEventListener('keydown', onKey, true);
    el.addEventListener('ezil:native-cover', onCover); el.addEventListener('pointerdown', onFocus);
    const dispose = () => {
        if (disposed) return; disposed = true; ++compositionRevision; cancelAnimationFrame(raf);
        for (const tab of tabs) { tab.unsubscribers.forEach(unsubscribe => unsubscribe()); tab.surface?.dispose(); }
        window.removeEventListener('ezil:native-composition', onComposition); window.removeEventListener('keydown', onKey, true);
        el.removeEventListener('ezil:native-cover', onCover); el.removeEventListener('pointerdown', onFocus); window.removeEventListener('ezil:teardown', dispose);
        trace.step('disposed'); trace.end('skipped');
    };
    el.on_before_exit = async () => { dispose(); return true; }; window.addEventListener('ezil:teardown', dispose);
    const restored = safeBrowserTabs(ctx.browserTabs) ?? { tabs: [''], activeIndex: 0 };
    for (const url of restored.tabs) createTab(url, false);
    selectTab(tabs[restored.activeIndex]); raf = requestAnimationFrame(() => sample());
    return el;
}
