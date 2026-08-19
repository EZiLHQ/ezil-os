/**
 * Regression guard for the EZiL neko-branding overlay (worker task: replace
 * the third-party n.eko wordmark/favicons/chat sound and disable audio
 * capture at the source).
 *
 * Every check here is written to go RED if its fix is reverted — per the
 * plan's own verification rule, a check that cannot fail is worse than none.
 * These are static/text checks only (no docker, no network) so they run
 * everywhere `bun test` does; the actual branding/audio behavior was
 * verified against a real running container (see the task report), not by
 * this file.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DOCKERFILE = readFileSync(join(import.meta.dir, '..', 'Dockerfile'), 'utf8');
const START_NEKO = readFileSync(join(import.meta.dir, 'start-neko.sh'), 'utf8');

const BRANDING_DIR = join(import.meta.dir, '..', 'assets', 'neko-branding');
const BRANDING_DOCKERFILE = readFileSync(join(BRANDING_DIR, 'Dockerfile'), 'utf8');
const BRANDED_INDEX_HTML = readFileSync(join(BRANDING_DIR, 'www', 'index.html'), 'utf8');
const BRANDED_MANIFEST = readFileSync(join(BRANDING_DIR, 'www', 'site.webmanifest'), 'utf8');
const BRANDED_LOGO_SVG = readFileSync(join(BRANDING_DIR, 'www', 'logo.svg'), 'utf8');

describe('worker/Dockerfile pins the EZiL-branded neko image', () => {
    it('defaults ARG NEKO_IMAGE to the -ezil-brand tag, not the raw upstream tag', () => {
        const match = DOCKERFILE.match(/^ARG NEKO_IMAGE=(\S+)$/m);
        expect(match).not.toBeNull();
        const pinned = match![1];
        expect(pinned).toContain('ezil-brand');
        // Guards the OTHER direction too: it must still be the same pinned
        // upstream SHAs, not some unrelated tag someone typo'd in.
        expect(pinned).toContain('d74052bb-049931d7');
    });
});

describe('worker/assets/neko-branding overlay', () => {
    it('has a build-time check that fails the image if n.eko branding survives', () => {
        // The Dockerfile itself must refuse to produce an image where the
        // overlay silently no-op'd (e.g. a COPY path typo that left the
        // upstream file in place).
        expect(BRANDING_DOCKERFILE).toMatch(/grep -qi "n\\\.eko" \/var\/www\/index\.html/);
        expect(BRANDING_DOCKERFILE).toContain('exit 1');
    });

    it('index.html no longer names n.eko anywhere', () => {
        expect(BRANDED_INDEX_HTML.toLowerCase()).not.toContain('n.eko');
    });

    it('index.html no longer uses n.eko’s teal accent color (#19bd9c)', () => {
        expect(BRANDED_INDEX_HTML).not.toContain('19bd9c');
    });

    it('site.webmanifest is renamed away from "n.eko"', () => {
        const parsed = JSON.parse(BRANDED_MANIFEST);
        expect(parsed.name.toLowerCase()).not.toContain('n.eko');
        expect(parsed.short_name.toLowerCase()).not.toContain('n.eko');
    });

    it('the wordmark SVG no longer contains the upstream cat-silhouette path data', () => {
        // The upstream img/logo.800bec71.svg is a single large <path> element
        // (a cat/paw mark, confirmed by inspecting its "d" data). A neutral
        // placeholder has no <path> at all.
        expect(BRANDED_LOGO_SVG).not.toContain('<path');
    });
});

describe('start-neko.sh disables audio capture at the source', () => {
    it('does not unconditionally launch pulseaudio in the boot path', () => {
        // Matches the exact upstream invocation this task removed. If this
        // reappears, the container regains a real desktop-audio source for
        // neko's WebRTC audio track to capture from.
        expect(START_NEKO).not.toMatch(
            /pulseaudio --log-level=error --disallow-module-loading --disallow-exit --exit-idle-time=-1/,
        );
    });

    it('points NEKO_CAPTURE_AUDIO_DEVICE at a name that cannot resolve to a real source', () => {
        expect(START_NEKO).toMatch(/export NEKO_CAPTURE_AUDIO_DEVICE=/);
    });

    it('documents that NEKO_CAPTURE_AUDIO_ENABLED does not exist in the pinned build', () => {
        // Regression guard against silently reintroducing the plan's
        // unverified assumption without the verification note that
        // disproved it.
        expect(START_NEKO).toContain('NEKO_CAPTURE_AUDIO_ENABLED');
        expect(START_NEKO).toContain('does not exist in this pinned build');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// The mobile on-screen-keyboard affordance (www/ezil-mobile.js).
//
// Read the header comment of `worker/assets/neko-branding/www/ezil-mobile.js`
// first: almost all of the keyboard machinery is upstream's, and that file only
// repairs reachability. The real proof that a keystroke lands in the remote
// browser is a container run driven from a touch-enabled browser (recorded in
// the task report) — it cannot be a unit test, because it needs Xvfb, XTEST and
// a WebRTC data channel. What CAN be tested here, and is, is the logic this
// repo actually owns: the touch gate, the arming, and the two calls the button
// makes. Those run against a deliberately minimal DOM stub, so a passing test
// means "this code does what it claims when the DOM behaves" — NOT "the
// keyboard rises on a phone". Nothing here is evidence for the latter.
// ─────────────────────────────────────────────────────────────────────────────

const EZIL_MOBILE_JS = readFileSync(join(BRANDING_DIR, 'www', 'ezil-mobile.js'), 'utf8');

/** Every <script>/<link> tag upstream's index.html carries, in order. */
const UPSTREAM_INDEX_TAGS = [
    '<link rel="apple-touch-icon" sizes="180x180" href="apple-touch-icon.png">',
    '<link rel="icon" type="image/png" sizes="32x32" href="favicon-32x32.png">',
    '<link rel="icon" type="image/png" sizes="16x16" href="favicon-16x16.png">',
    '<link rel="manifest" href="site.webmanifest">',
    '<link rel="mask-icon" href="safari-pinned-tab.svg" color="#00adb5">',
    '<script defer="defer" type="module" src="js/chunk-vendors.025e045d.js">',
    '<script defer="defer" type="module" src="js/app.4919abb0.js">',
    '<link href="css/app.8dceb2fa.css" rel="stylesheet">',
    '<script defer="defer" src="js/chunk-vendors-legacy.58879166.js" nomodule>',
    '<script defer="defer" src="js/app-legacy.4a0d07b4.js" nomodule>',
];

describe('index.html keeps the compiled bundle wired up exactly as upstream left it', () => {
    it('still carries every upstream <script>/<link> tag, byte-identical and in order', () => {
        // The compiled Vue bundle's DOM/module expectations depend on these
        // hashed filenames and on the module/nomodule pairing. This goes RED if
        // anyone "tidies" index.html, re-orders it, or bumps a hash by hand
        // without also replacing the asset the hash names.
        const tags = BRANDED_INDEX_HTML.match(/<(?:script|link)\b[^>]*>/g) ?? [];
        expect(tags.slice(0, UPSTREAM_INDEX_TAGS.length)).toEqual(UPSTREAM_INDEX_TAGS);
    });

    it('adds exactly one tag of its own, and it loads ezil-mobile.js', () => {
        const tags = BRANDED_INDEX_HTML.match(/<(?:script|link)\b[^>]*>/g) ?? [];
        const added = tags.filter((t) => !UPSTREAM_INDEX_TAGS.includes(t));
        expect(added).toEqual(['<script defer="defer" src="ezil-mobile.js">']);
    });
});

describe('the branding overlay actually ships ezil-mobile.js', () => {
    it('COPYs it into /var/www', () => {
        expect(BRANDING_DOCKERFILE).toMatch(/^COPY\s+www\/ezil-mobile\.js\s+\/var\/www\/ezil-mobile\.js$/m);
    });

    it('fails the image build if the file or the tag that loads it goes missing', () => {
        // Same reasoning as the n.eko checks above: a COPY path typo, or an
        // index.html that no longer references the script, must break the build
        // rather than produce an image whose keyboard silently does nothing.
        expect(BRANDING_DOCKERFILE).toContain('test -s /var/www/ezil-mobile.js');
        expect(BRANDING_DOCKERFILE).toContain('grep -q \'src="ezil-mobile.js"\' /var/www/index.html');
    });

    it('does not reintroduce n.eko branding through the new file', () => {
        expect(EZIL_MOBILE_JS.toLowerCase()).not.toContain('n.eko');
        expect(EZIL_MOBILE_JS).not.toContain('19bd9c');
    });
});

type StubEl = Record<string, any>;

/**
 * Run ezil-mobile.js against a stub DOM and report what it did.
 *
 * Deliberately minimal: anything the script needs that the stub does not
 * provide will throw, which is the point — a generous stub would let the script
 * "pass" while doing nothing.
 */
function runMobileScript(opts: {
    touch: boolean;
    coarsePointer: boolean;
    overlayPointerEvents?: 'auto' | 'none';
    controlIconClass?: string | null;
}) {
    const calls: string[] = [];
    const created: StubEl[] = [];

    const makeEl = (tag: string): StubEl => {
        const el: StubEl = {
            tagName: tag.toUpperCase(),
            style: {},
            attrs: {},
            listeners: {},
            className: '',
            setAttribute(k: string, v: string) {
                el.attrs[k] = v;
            },
            getAttribute(k: string) {
                return el.attrs[k];
            },
            addEventListener(type: string, fn: (e: unknown) => void) {
                (el.listeners[type] ||= []).push(fn);
            },
            appendChild() {},
            click() {
                calls.push(`click:${el.className}`);
            },
            focus() {
                calls.push('focus:overlay');
                doc.activeElement = el;
            },
            blur() {
                calls.push('blur:overlay');
                doc.activeElement = null;
            },
        };
        created.push(el);
        return el;
    };

    const overlay = makeEl('textarea');
    overlay.className = 'overlay';
    const controlIcon = opts.controlIconClass === null ? null : makeEl('i');
    if (controlIcon) controlIcon.className = opts.controlIconClass ?? 'faded fas fa-computer-mouse';

    const doc: StubEl = {
        activeElement: null,
        documentElement: makeEl('html'),
        head: makeEl('head'),
        body: makeEl('body'),
        createElement: (t: string) => makeEl(t),
        getElementById: () => null,
        addEventListener: () => {},
        querySelector(sel: string) {
            if (sel === 'textarea.overlay') return overlay;
            if (sel === '.video-menu .fa-computer-mouse') return controlIcon;
            return null;
        },
    };

    const win: StubEl = {
        navigator: { maxTouchPoints: opts.touch ? 5 : 0 },
        matchMedia: (q: string) => ({ matches: q.includes('pointer: coarse') ? opts.coarsePointer : false }),
        getComputedStyle: () => ({ pointerEvents: opts.overlayPointerEvents ?? 'auto' }),
        MutationObserver: class {
            observe() {}
            disconnect() {}
        },
        setInterval: () => 0,
        clearInterval: () => {},
        console: { warn: (m: string) => calls.push(`warn:${m}`) },
        visualViewport: null,
    };
    if (opts.touch) win.ontouchstart = null;
    win.window = win;
    win.document = doc;
    win.parent = win;

    // `new Function` rather than `eval` so the script cannot see this file's
    // scope and has to get everything through the stub.
    const run = new Function(
        'window',
        'document',
        'navigator',
        'console',
        'MutationObserver',
        'setInterval',
        'clearInterval',
        'getComputedStyle',
        EZIL_MOBILE_JS,
    );
    run(win, doc, win.navigator, win.console, win.MutationObserver, win.setInterval, win.clearInterval, win.getComputedStyle);

    const state = win.__ezilMobileKeyboard as { armed: boolean; reason: string | null };
    const button = created.find((el) => el.tagName === 'BUTTON');
    const clickBtn = () => {
        for (const fn of button?.listeners.click ?? []) fn({ preventDefault() {}, stopPropagation() {} });
    };
    return { state, calls, button, clickBtn, doc };
}

describe('ezil-mobile.js gates on touch capability, not on viewport size', () => {
    it('is a hard no-op on a mouse-driven device', () => {
        const r = runMobileScript({ touch: false, coarsePointer: false });
        expect(r.state.armed).toBe(false);
        expect(r.state.reason).toBe('not-a-touch-device');
        expect(r.button).toBeUndefined();
    });

    it('is a hard no-op on a touchscreen laptop whose primary pointer is a mouse', () => {
        // Touch hardware present, but the user is driving with a trackpad.
        const r = runMobileScript({ touch: true, coarsePointer: false });
        expect(r.state.armed).toBe(false);
        expect(r.state.reason).toBe('not-a-touch-device');
    });

    it('never consults viewport width', () => {
        // A narrow desktop window must not sprout a keyboard button. Written in
        // the negative on purpose: it goes RED if someone "fixes" the gate by
        // adding a width media query or an innerWidth check.
        expect(EZIL_MOBILE_JS).not.toMatch(/innerWidth/);
        expect(EZIL_MOBILE_JS).not.toMatch(/max-width\s*:/);
    });

    it('arms on a real touch device and injects a button', () => {
        const r = runMobileScript({ touch: true, coarsePointer: true });
        expect(r.state.armed).toBe(true);
        expect(r.button).toBeDefined();
        expect(r.button!.attrs['aria-label']).toBe('Show keyboard');
    });
});

describe('ezil-mobile.js drives the client bundle rather than reimplementing it', () => {
    it('focuses the client’s own overlay textarea, which is what the OS keyboard attaches to', () => {
        const r = runMobileScript({ touch: true, coarsePointer: true, overlayPointerEvents: 'auto' });
        r.clickBtn();
        expect(r.calls).toContain('focus:overlay');
        // Already hosting, so it must NOT poke the take-control affordance.
        expect(r.calls.some((c) => c.startsWith('click:'))).toBe(false);
    });

    it('takes control first when the session is not hosting, or every keystroke is dropped', () => {
        // Control mode 'manual' (enableImplicitHosting degraded). The client
        // renders `pointer-events: none` on the overlay from its own `hosting`
        // binding, and drops keydown/keyup behind the same flag.
        const r = runMobileScript({
            touch: true,
            coarsePointer: true,
            overlayPointerEvents: 'none',
            controlIconClass: 'faded fas fa-computer-mouse',
        });
        r.clickBtn();
        expect(r.calls).toEqual(['click:faded fas fa-computer-mouse', 'focus:overlay']);
    });

    it('does not steal control from another member who already holds it', () => {
        const r = runMobileScript({
            touch: true,
            coarsePointer: true,
            overlayPointerEvents: 'none',
            controlIconClass: 'disabled fas fa-computer-mouse',
        });
        r.clickBtn();
        expect(r.calls.some((c) => c.startsWith('click:'))).toBe(false);
        expect(r.calls).toContain('focus:overlay');
    });

    it('a second tap lowers the keyboard again', () => {
        const r = runMobileScript({ touch: true, coarsePointer: true });
        r.clickBtn();
        r.clickBtn();
        expect(r.calls).toContain('blur:overlay');
    });
});
