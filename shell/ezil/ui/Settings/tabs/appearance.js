// tabs/appearance.js — EZiL-authored. Not Puter code.
//
// Wallpaper and theme tokens. LOCAL CODE ONLY: both persist to `localStorage`
// via `ezil/session.js`'s existing `get`/`set` (the same "puter.kv
// replacement" every other preference in this shell already goes through —
// see that file's header), never to a server.
//
// ── Why this file has a module-level side effect ────────────────────────────
// A preference that only takes effect while the Settings window happens to be
// open is not a preference, it is a demo. `applyPersistedAppearance()` at the
// bottom of this file runs once, at import time — which is at PAGE LOAD, not
// at "the user opened Settings": `boot.js` imports `apps/registry.js`, which
// imports `Settings/index.js` (to register the app), which imports this file,
// so the whole chain evaluates before `boot()` even runs. That is what makes
// "pick a wallpaper, close Settings, reload the page, still see it" work
// without touching `boot.js` — a file this task does not own.
//
// The desktop root does not exist yet at that moment (`boot.js` builds it
// inside `mount()`, which the hydration handshake can delay), so applying is
// a short bounded poll for `.desktop` rather than a one-shot query. Inline
// styles are used throughout — `el.style.setProperty(...)` on the element
// itself, and `document.documentElement.style.setProperty(...)` for theme
// tokens — specifically so this never has to win a cascade-order argument
// against `ezil-shell.css` / `ezil-tokens.css` (files this task does not
// own): an inline style wins over any external stylesheet rule regardless of
// which one the build concatenates first or last.
import session from '../../session.js';

const APPEARANCE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
    + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.5-.6 1.5-1.3 0-.4-.2-.7-.4-1a1.7 1.7 0 0 1 1.4-2.7h1.7a3.8 3.8 0 0 0 3.8-3.8C20 6.9 16.4 3 12 3Z"/>'
    + '<circle cx="7.5" cy="10.5" r="1"/><circle cx="12" cy="7.5" r="1"/><circle cx="16.5" cy="10.5" r="1"/></svg>';

const WALLPAPER_KEY = 'settings.wallpaper';
const ACCENT_KEY = 'settings.accent';

/**
 * Preset wallpapers. Plain CSS `background` values (gradients, one solid) —
 * no images, so there is nothing to fetch and nothing that could be an
 * external request the CSP-equivalent "local code only" rule would object
 * to. `id` is what persists; `css` is applied directly, never parsed.
 */
const WALLPAPERS = [
    { id: 'charcoal', label: 'Charcoal', css: '#161616' },
    { id: 'teal-dusk', label: 'Teal dusk', css: 'linear-gradient(160deg, #0d2b2d 0%, #161616 70%)' },
    { id: 'deep-slate', label: 'Deep slate', css: 'linear-gradient(160deg, #1f2933 0%, #0e1013 75%)' },
    { id: 'aurora', label: 'Aurora', css: 'linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)' },
];

/**
 * Accent presets. Written as the same `--select-hue/-saturation/-lightness`
 * triplet `ezil-tokens.css` sets on `:root` — upstream's `style.css` derives
 * `--select-color` from exactly those three via `hsl()`, so overriding them
 * (rather than `--select-color` itself) also flows through anything upstream
 * computed FROM the individual channels.
 */
const ACCENTS = [
    { id: 'teal', label: 'Teal', hue: 182.65, saturation: '100%', lightness: '35.49%' },
    { id: 'violet', label: 'Violet', hue: 262, saturation: '83%', lightness: '58%' },
    { id: 'amber', label: 'Amber', hue: 38, saturation: '92%', lightness: '50%' },
    { id: 'rose', label: 'Rose', hue: 350, saturation: '78%', lightness: '58%' },
];

function findWallpaper (id) { return WALLPAPERS.find(w => w.id === id) ?? WALLPAPERS[0]; }
function findAccent (id) { return ACCENTS.find(a => a.id === id) ?? ACCENTS[0]; }

/** Poll briefly for `.desktop` rather than assume it already exists — see
 * the header. Gives up silently past the budget (a bare/headless host that
 * never builds one), matching this fork's bounded-retry convention. */
function whenDesktopReady (fn, retriesLeft = 100) {
    const el = document.querySelector('.desktop');
    if ( el ) { fn(el); return; }
    if ( retriesLeft <= 0 ) return;
    setTimeout(() => whenDesktopReady(fn, retriesLeft - 1), 50);
}

function applyWallpaper (id) {
    const wallpaper = findWallpaper(id);
    whenDesktopReady((el) => {
        el.style.setProperty('background', wallpaper.css);
        el.style.setProperty('background-attachment', 'fixed');
    });
    return wallpaper;
}

function applyAccent (id) {
    const accent = findAccent(id);
    const root = document.documentElement.style;
    root.setProperty('--select-hue', String(accent.hue));
    root.setProperty('--select-saturation', accent.saturation);
    root.setProperty('--select-lightness', accent.lightness);
    return accent;
}

function currentWallpaperId () { return session.get(WALLPAPER_KEY, WALLPAPERS[0].id); }
function currentAccentId () { return session.get(ACCENT_KEY, ACCENTS[0].id); }

function swatchesHtml (items, currentId, dataAttr) {
    return items.map(item => `
        <button type="button" class="ezil-settings-swatch${item.id === currentId ? ' active' : ''}"
            data-${dataAttr}="${item.id}" title="${html_encode(item.label)}"
            style="${dataAttr === 'wallpaper' ? `background:${item.css}` : `background:hsl(${item.hue} ${item.saturation} ${item.lightness})`}">
            <span class="ezil-settings-swatch-label">${html_encode(item.label)}</span>
        </button>`).join('');
}

function render ($win) {
    const $pane = $win.find('[data-pane="appearance"]');
    if ( $pane.length === 0 ) return;
    $pane.find('[data-role="wallpaper-swatches"]').html(swatchesHtml(WALLPAPERS, currentWallpaperId(), 'wallpaper'));
    $pane.find('[data-role="accent-swatches"]').html(swatchesHtml(ACCENTS, currentAccentId(), 'accent'));
}

function bind ($win) {
    const $pane = $win.find('[data-pane="appearance"]');
    $pane.on('click', '[data-wallpaper]', function () {
        const id = $(this).attr('data-wallpaper');
        session.set(WALLPAPER_KEY, id);
        applyWallpaper(id);
        render($win);
    });
    $pane.on('click', '[data-accent]', function () {
        const id = $(this).attr('data-accent');
        session.set(ACCENT_KEY, id);
        applyAccent(id);
        render($win);
    });
}

let bound = false;

export default {
    id: 'appearance',
    label: 'Appearance',
    icon: APPEARANCE_ICON,

    html () {
        return `
            <div class="ezil-settings-appearance">
                <section class="ezil-settings-section">
                    <h3>Wallpaper</h3>
                    <div class="ezil-settings-swatch-row" data-role="wallpaper-swatches"></div>
                </section>
                <section class="ezil-settings-section">
                    <h3>Accent colour</h3>
                    <div class="ezil-settings-swatch-row" data-role="accent-swatches"></div>
                </section>
            </div>`;
    },

    init ($win) {
        if ( ! bound ) {
            bound = true;
            bind($win);
        }
        render($win);
    },

    onActivate ($win) {
        render($win);
    },
};

// ── the module-level side effect described in the header ───────────────────
// Runs once, at import time, independent of whether Settings is ever opened.
whenDesktopReady(() => applyWallpaper(currentWallpaperId()));
applyAccent(currentAccentId()); // `:root` always exists; no need to wait.
