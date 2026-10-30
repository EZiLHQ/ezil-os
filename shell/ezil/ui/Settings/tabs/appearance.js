// tabs/appearance.js — EZiL-authored. Not Puter code.
//
// Wallpaper and accent. LOCAL CODE ONLY: both persist to `localStorage` via
// `ezil/session.js`'s `get`/`set` (the shell's "puter.kv replacement"), never
// to a server. Round 3 (plan §6.7, decision D8):
//
//   - The accent drives ONE token family on `<html>`: `--ezil-accent`,
//     `--ezil-accent-strong` and the contrast-safe `--ezil-accent-contrast`
//     (`ezil-tokens.css` holds the teal defaults). Every accent-bearing shell
//     control reads those: Settings and its sheets (`--accent`), buttons,
//     focus rings, progress, the boot panel and the window controls. The
//     upstream `--select-*` triplet is still written for the context menu.
//   - `applyPersistedAppearance()` is synchronous and idempotent. `boot.js`
//     calls it right after `mount_desktop_root()` inside `build()`, so it runs
//     after hydration on the first mount AND on every `ensure_intact`
//     rebuild (a rebuilt `.desktop` used to lose the wallpaper). Nothing is
//     applied at import time any more.
//   - Keys are per account on this browser: `ezil-os:settings.<userId>.
//     {wallpaper,accent}`. The old shared keys are moved to the first account
//     that loads, once. The native macOS host keeps the old keys, which its
//     own persistence (`native-persistence.js`) reads and writes.
//   - A `storage` event from another tab of the same account re-applies.
import session from '../../../session.js';
import { isNative } from '../../../native-runtime.js';

const APPEARANCE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
    + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.5-.6 1.5-1.3 0-.4-.2-.7-.4-1a1.7 1.7 0 0 1 1.4-2.7h1.7a3.8 3.8 0 0 0 3.8-3.8C20 6.9 16.4 3 12 3Z"/>'
    + '<circle cx="7.5" cy="10.5" r="1"/><circle cx="12" cy="7.5" r="1"/><circle cx="16.5" cy="10.5" r="1"/></svg>';

/** The pre-round-3 keys: shared by every account on the browser; still the native host's keys. */
export const LEGACY_KEYS = Object.freeze({ wallpaper: 'settings.wallpaper', accent: 'settings.accent' });

/**
 * Preset wallpapers. Plain CSS `background` values (gradients, one solid) —
 * no images, so there is nothing to fetch and nothing that could be an
 * external request the CSP-equivalent "local code only" rule would object
 * to. `id` is what persists; `css` is applied directly, never parsed.
 */
const WALLPAPERS = [
    // The default. Original to EZiL OS: a teal/violet aurora above a planet's
    // rim that rises behind the dock, with a warm sunrise where the dock sits.
    // Five gradient layers, no image. `.desktop.ezil-desktop` in
    // `ui/ezil-shell.css` server-paints the same layers so the first frame and
    // the booted shell match.
    {
        id: 'horizon',
        label: 'Horizon',
        css: 'radial-gradient(24% 6% at 50% 91.2%, rgba(255, 200, 150, 0.6) 0%, rgba(255, 150, 100, 0.18) 55%, rgba(255, 150, 100, 0) 100%), '
            + 'radial-gradient(150% 72% at 50% 138%, #04060c 0%, #04060c 62%, rgba(0, 200, 208, 0.72) 63.1%, rgba(96, 110, 255, 0.38) 65.4%, rgba(112, 86, 255, 0.1) 70%, rgba(112, 86, 255, 0) 78%), '
            + 'radial-gradient(55% 45% at 82% 6%, rgba(0, 190, 200, 0.4) 0%, rgba(0, 190, 200, 0) 62%), '
            + 'radial-gradient(50% 55% at 8% 22%, rgba(112, 86, 255, 0.34) 0%, rgba(112, 86, 255, 0) 64%), '
            + 'linear-gradient(180deg, #0a0e1d 0%, #070a14 50%, #04060c 100%)',
    },
    { id: 'charcoal', label: 'Charcoal', css: '#161616' },
    { id: 'teal-dusk', label: 'Teal dusk', css: 'linear-gradient(160deg, #0d2b2d 0%, #161616 70%)' },
    { id: 'deep-slate', label: 'Deep slate', css: 'linear-gradient(160deg, #1f2933 0%, #0e1013 75%)' },
    { id: 'aurora', label: 'Aurora', css: 'linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)' },
];

/**
 * Accent presets. `hue/saturation/lightness` still feed upstream's
 * `--select-*` triplet; `hex` is the same colour for the `--ezil-accent`
 * family, and `contrast` is the text colour on it (the darker of the two
 * candidates that clears WCAG AA, pinned in appearance-browser-test.mjs).
 */
function hslToRgb (h, s, l) {
    const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0), f(8), f(4)].map(v => Math.round(v * 255));
}
const hex = rgb => `#${rgb.map(v => v.toString(16).padStart(2, '0')).join('')}`;
function luminance (rgb) {
    const [r, g, b] = rgb.map(v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrastRatio (a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}
const INK = [0x04, 0x06, 0x0c], WHITE = [0xff, 0xff, 0xff];
function accentColours ({ hue, saturation, lightness }) {
    const s = parseFloat(saturation) / 100, l = parseFloat(lightness) / 100;
    const rgb = hslToRgb(hue, s, l);
    const strong = hslToRgb(hue, s, Math.max(0, l - 0.1));
    const ink = contrastRatio(rgb, INK) >= contrastRatio(rgb, WHITE) ? INK : WHITE;
    return { hex: hex(rgb), strong: hex(strong), contrast: hex(ink), rgb };
}

const ACCENTS = [
    { id: 'teal', label: 'Teal', hue: 182.65, saturation: '100%', lightness: '35.49%' },
    { id: 'violet', label: 'Violet', hue: 262, saturation: '83%', lightness: '58%' },
    { id: 'amber', label: 'Amber', hue: 38, saturation: '92%', lightness: '50%' },
    { id: 'rose', label: 'Rose', hue: 350, saturation: '78%', lightness: '58%' },
].map(accent => ({ ...accent, ...accentColours(accent) }));

function findWallpaper (id) { return WALLPAPERS.find(w => w.id === id) ?? WALLPAPERS[0]; }
function findAccent (id) { return ACCENTS.find(a => a.id === id) ?? ACCENTS[0]; }

/** Poll briefly for `.desktop` — a Settings click can land while a rebuild is in flight. */
function whenDesktopReady (fn, retriesLeft = 100) {
    const el = document.querySelector('.desktop');
    if ( el ) { fn(el); return; }
    if ( retriesLeft <= 0 ) return;
    setTimeout(() => whenDesktopReady(fn, retriesLeft - 1), 50);
}

function paintWallpaper (el, wallpaper) {
    el.style.setProperty('background', wallpaper.css);
    el.style.setProperty('background-attachment', 'fixed');
}

export function applyWallpaper (id) {
    const wallpaper = findWallpaper(id);
    whenDesktopReady(el => paintWallpaper(el, wallpaper));
    return wallpaper;
}

export function applyAccent (id) {
    const accent = findAccent(id);
    const root = document.documentElement.style;
    root.setProperty('--select-hue', String(accent.hue));
    root.setProperty('--select-saturation', accent.saturation);
    root.setProperty('--select-lightness', accent.lightness);
    root.setProperty('--ezil-accent', accent.hex);
    root.setProperty('--ezil-accent-strong', accent.strong);
    root.setProperty('--ezil-accent-contrast', accent.contrast);
    root.setProperty('--ezil-accent-rgb', accent.rgb.join(', '));
    return accent;
}

/** The signed-in account's id when it is safe inside a storage key; null otherwise. */
function accountKey () {
    const id = session.payload()?.user?.id;
    return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
}

/** `settings.<userId>.<kind>` on the web; the shared legacy key on the native host or with no account. */
export function appearanceKey (kind) {
    const account = accountKey();
    return isNative() || ! account ? LEGACY_KEYS[kind] : `settings.${account}.${kind}`;
}

/** Once: the old shared keys move to the first account that loads them on this browser. */
function migrateLegacyKeys () {
    if ( isNative() || ! accountKey() ) return;
    for ( const kind of Object.keys(LEGACY_KEYS) ) {
        const legacy = session.get(LEGACY_KEYS[kind], null);
        if ( legacy === null ) continue;
        if ( session.get(appearanceKey(kind), null) === null ) session.set(appearanceKey(kind), legacy);
        session.del(LEGACY_KEYS[kind]);
    }
}

function currentWallpaperId () { return findWallpaper(session.get(appearanceKey('wallpaper'), WALLPAPERS[0].id)).id; }
function currentAccentId () { return findAccent(session.get(appearanceKey('accent'), ACCENTS[0].id)).id; }

/**
 * Apply this account's saved wallpaper and accent now. Synchronous and
 * idempotent: `boot.js` calls it after every `mount_desktop_root()` (first
 * mount and each rebuild); a `storage` event from another tab calls it too.
 */
export function applyPersistedAppearance () {
    migrateLegacyKeys();
    const wallpaper = findWallpaper(currentWallpaperId());
    const el = document.querySelector('.desktop');
    if ( el ) paintWallpaper(el, wallpaper);
    else applyWallpaper(wallpaper.id);
    const accent = applyAccent(currentAccentId());
    return { wallpaper: wallpaper.id, accent: accent.id };
}

let openWin = null; // the Settings window showing this pane, for cross-tab repaint

function swatchesHtml (items, currentId, dataAttr) {
    return items.map(item => `
        <button type="button" class="ezil-settings-swatch${item.id === currentId ? ' active' : ''}"
            data-${dataAttr}="${item.id}" title="${html_encode(item.label)}"
            style="${dataAttr === 'wallpaper' ? `background:${item.css}` : `background:hsl(${item.hue} ${item.saturation} ${item.lightness})`}">
            <span class="ezil-settings-swatch-label">${html_encode(item.label)}</span>
        </button>`).join('');
}

function render ($win) {
    if ( ! $win?.get(0)?.isConnected ) return;
    migrateLegacyKeys();
    const $pane = $win.find('[data-pane="appearance"]');
    if ( $pane.length === 0 ) return;
    $pane.find('[data-role="wallpaper-swatches"]').html(swatchesHtml(WALLPAPERS, currentWallpaperId(), 'wallpaper'));
    $pane.find('[data-role="accent-swatches"]').html(swatchesHtml(ACCENTS, currentAccentId(), 'accent'));
}

function bind ($win) {
    const $pane = $win.find('[data-pane="appearance"]');
    $pane.on('click', '[data-wallpaper]', function () {
        const id = $(this).attr('data-wallpaper');
        session.set(appearanceKey('wallpaper'), id);
        window.dispatchEvent(new CustomEvent('ezil:preferences-changed'));
        applyWallpaper(id);
        render($win);
    });
    $pane.on('click', '[data-accent]', function () {
        const id = $(this).attr('data-accent');
        session.set(appearanceKey('accent'), id);
        window.dispatchEvent(new CustomEvent('ezil:preferences-changed'));
        applyAccent(id);
        render($win);
    });
}

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
                <p class="ezil-settings-muted" data-role="appearance-scope">Saved on this browser.</p>
            </div>`;
    },

    /** Binds every time — see the long note on `computers.js`'s `init`. The
     * handlers are delegated onto THIS window's pane, so a module-level
     * "already bound" flag made the swatches dead on the second open. */
    init ($win) {
        openWin = $win;
        bind($win);
        render($win);
    },

    onActivate ($win) {
        render($win);
    },
};

// ── another tab of the same account changed a setting ─────────────────────
// Registering a listener is the only import-time effect: nothing is painted
// until `boot.js` calls `applyPersistedAppearance()` after the mount.
if ( typeof window !== 'undefined' && typeof window.addEventListener === 'function' ) {
    window.addEventListener('storage', event => {
        const keys = ['wallpaper', 'accent'].map(kind => `ezil-os:${appearanceKey(kind)}`);
        if ( event.key !== null && ! keys.includes(event.key) ) return;
        if ( ! document.querySelector('.desktop') ) return;
        applyPersistedAppearance();
        render(openWin);
    });
}
