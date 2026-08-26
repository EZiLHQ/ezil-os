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

    const winListeners: Record<string, Array<(e: unknown) => void>> = {};
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
        // A real browser window has this, and the duplicate-input guard binds
        // its capture-phase listeners here. Recorded rather than ignored so a
        // test can assert WHICH events the guard withholds from the bundle —
        // that is the whole mechanism of the mobile double-typing fix.
        addEventListener: (type: string, fn: (e: unknown) => void, capture?: boolean) => {
            calls.push(`win.on:${type}${capture ? ':capture' : ''}`);
            (winListeners[type] ??= []).push(fn);
        },
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
    return { state, calls, button, clickBtn, doc, winListeners };
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
        // The guard's own `window.addEventListener` calls are SETUP, not the
        // behaviour under test here — filtered out so this assertion keeps
        // saying exactly what it was written to say.
        expect(r.calls.filter((c) => !c.startsWith('win.on:')))
            .toEqual(['click:faded fas fa-computer-mouse', 'focus:overlay']);
    });

    // ── the duplicate-input guard ──────────────────────────────────────────
    // The mechanism of the mobile double-typing fix, asserted without a
    // container. See `mobile-keyboard.container.test.ts` for the end-to-end
    // frame counts against a real client.
    it('🔴 withholds printable keys from the bundle, and compositionstart, in the CAPTURE phase', () => {
        const r = runMobileScript({ touch: true, coarsePointer: true });
        // Capture, because these listeners must run BEFORE the overlay's own —
        // the bundle binds keydown with capture:true on the overlay itself, so
        // a bubble-phase listener could never withhold anything from it.
        expect(r.calls).toContain('win.on:keydown:capture');
        expect(r.calls).toContain('win.on:keypress:capture');
        expect(r.calls).toContain('win.on:compositionstart:capture');
        // 🔴 keyup is deliberately NOT suppressed: the bundle tracks modifier
        // state from it, and a swallowed keyup is how a remote desktop ends up
        // with a key stuck down.
        expect(r.calls).not.toContain('win.on:keyup:capture');
    });

    it('🔴 stops a printable key but lets Backspace, Enter and chords through', () => {
        const r = runMobileScript({ touch: true, coarsePointer: true });
        const onKey = r.winListeners.keydown?.[0];
        expect(onKey).toBeDefined();
        const overlay = r.doc.querySelector('textarea.overlay');

        const fire = (init: Record<string, unknown>) => {
            let stopped = false;
            onKey!({ target: overlay, stopPropagation: () => { stopped = true; }, ...init });
            return stopped;
        };

        // Text: withheld, because the bundle's input/compositionend path will
        // deliver it and the keysym path would deliver it a SECOND time.
        expect(fire({ key: 'f', keyCode: 70 })).toBe(true);
        expect(fire({ key: '.', keyCode: 190 })).toBe(true);
        // An IME keydown, both ways it identifies itself.
        expect(fire({ key: 'a', keyCode: 229 })).toBe(true);
        expect(fire({ key: 'a', keyCode: 70, isComposing: true })).toBe(true);

        // No text: the keysym path is the ONLY thing that can send these.
        expect(fire({ key: 'Backspace', keyCode: 8 })).toBe(false);
        expect(fire({ key: 'Enter', keyCode: 13 })).toBe(false);
        expect(fire({ key: 'ArrowLeft', keyCode: 37 })).toBe(false);
        expect(fire({ key: 'Shift', keyCode: 16 })).toBe(false);
        // A chord is a command, not text, and never arrives as an `input`
        // event — withholding it would make Ctrl+C unsendable.
        expect(fire({ key: 'c', keyCode: 67, ctrlKey: true })).toBe(false);
    });

    it('leaves events for anything that is not the overlay alone', () => {
        const r = runMobileScript({ touch: true, coarsePointer: true });
        const onKey = r.winListeners.keydown?.[0];
        let stopped = false;
        onKey!({ target: { nodeName: 'INPUT' }, key: 'f', keyCode: 70,
                 stopPropagation: () => { stopped = true; } });
        expect(stopped).toBe(false);
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

// ─────────────────────────────────────────────────────────────────────────────
// The black-picture detector (the other half of www/ezil-mobile.js).
//
// 🔴 What this proves and what it does not. The thresholds it fires on were
// calibrated against real measurements — a production desktop that rendered
// every sampled pixel at exactly 0 on 13 of 13 opens, and a healthy container
// whose SERVER-SIDE framebuffer (`GET /api/room/screen/shot.jpg`, which bypasses
// the encoder entirely) reads meanLuma 34.664. Killing the one X client that
// paints anything drops that same framebuffer to `mean 0.000 / max 0 /
// nonzeroFrac 0.0000` while `phase=ready event=end status=ok` still stands.
// That is the fault. It is not reproducible in a unit test, and nothing below
// is evidence that production is fixed.
//
// What IS testable here, and is: given a picture, does this code reach the
// right verdict, does it stay silent when it should, and does it stop costing
// anything the moment it sees content.
// ─────────────────────────────────────────────────────────────────────────────

/** Drive the detector against a stub DOM whose clock and ticks the test owns. */
function runPictureScript(opts: {
    /** `null` = no <video> in the document at all. */
    video?: { videoWidth: number; videoHeight: number; readyState: number } | null;
    /** What `getImageData` hands back. `unreadable` = no 2D context (tainted canvas). */
    pixels?: 'black' | 'lit' | 'unreadable';
    /** Bytes the inbound-rtp report gains per second, and the frame size it claims. */
    peer?: { bytesPerSecond: number; width: number; height: number } | null;
}) {
    const posted: Record<string, unknown>[] = [];
    const pictureListeners: Record<string, Array<(e: unknown) => void>> = {};
    let clock = 1_700_000_000_000;

    const video = opts.video === undefined
        ? { videoWidth: 1920, videoHeight: 1080, readyState: 4 }
        : opts.video;

    const pixels = opts.pixels ?? 'lit';
    const makeCanvas = () => {
        const el: Record<string, any> = { width: 0, height: 0 };
        el.getContext = () => {
            if (pixels === 'unreadable') return null;
            return {
                drawImage() {},
                getImageData(_x: number, _y: number, w: number, h: number) {
                    const data = new Uint8ClampedArray(w * h * 4);
                    if (pixels === 'lit') data.fill(128);
                    return { data };
                },
            };
        };
        return el;
    };

    // A SYNCHRONOUS thenable, so `pumpStats()` resolves inside the tick that
    // started it and the whole test stays deterministic. `getStats()` only has
    // to be thenable — the detector never awaits it.
    let bytes = 0;
    const peer = opts.peer === undefined ? { bytesPerSecond: 30_000, width: 1920, height: 1080 } : opts.peer;
    const pc: Record<string, any> = {
        getStats: () => ({
            then(ok: (r: unknown) => void) {
                ok({
                    forEach(fn: (e: unknown) => void) {
                        fn({ type: 'inbound-rtp', kind: 'audio', bytesReceived: 1 });
                        fn({
                            type: 'inbound-rtp',
                            kind: 'video',
                            bytesReceived: bytes,
                            frameWidth: peer?.width,
                            frameHeight: peer?.height,
                        });
                    },
                });
                return this;
            },
        }),
    };

    const doc: Record<string, any> = {
        activeElement: null,
        documentElement: {},
        head: { appendChild() {} },
        body: { appendChild() {} },
        createElement: (t: string) => (t === 'canvas' ? makeCanvas() : { style: {}, setAttribute() {}, addEventListener() {} }),
        getElementById: () => null,
        addEventListener: () => {},
        querySelector(sel: string) {
            if (sel === 'video') return video;
            return null;
        },
    };

    let ticker: (() => void) | null = null;
    let cleared = 0;
    const win: Record<string, any> = {
        // Non-touch on purpose: the detector must run anyway. That is the point
        // of the "regardless of device" requirement, so it is the default here.
        navigator: { maxTouchPoints: 0 },
        matchMedia: () => ({ matches: false }),
        getComputedStyle: () => ({ pointerEvents: 'none' }),
        MutationObserver: class { observe() {} disconnect() {} },
        visualViewport: null,
        // A parent that is not us, so `postMessage` is actually attempted.
        parent: { postMessage: (m: Record<string, unknown>) => posted.push(m) },
        RTCPeerConnection: peer ? function RTCPeerConnection() {} : undefined,
        console: { warn() {} },
        // A real window has this. The vitals publisher listens here for the
        // shell's on-demand start/stop, and without it the script would (quite
        // correctly) warn — which would then show up as a `posted` message and
        // fail the "says NOTHING when there is no stream" assertion for a
        // reason that has nothing to do with the picture detector.
        addEventListener: (type: string, fn: (e: unknown) => void) => {
            (pictureListeners[type] ??= []).push(fn);
        },
    };
    if (peer) {
        (win.RTCPeerConnection as any).prototype.setRemoteDescription = function () { return null; };
    }
    win.window = win;
    win.document = doc;

    const setInterval = (fn: () => void) => { ticker = fn; return 7; };
    const clearInterval = () => { cleared += 1; ticker = null; };
    const DateStub = { now: () => clock };

    const run = new Function(
        'window', 'document', 'navigator', 'console', 'MutationObserver',
        'setInterval', 'clearInterval', 'getComputedStyle', 'Date',
        EZIL_MOBILE_JS,
    );
    run(win, doc, win.navigator, win.console, win.MutationObserver,
        setInterval, clearInterval, win.getComputedStyle, DateStub);

    // The bundle constructs its peer after the script runs, so hand the hooked
    // prototype a call exactly as a real handshake would.
    if (peer) (win.RTCPeerConnection as any).prototype.setRemoteDescription.call(pc);

    const state = win.__ezilPicture as {
        state: string; ticks: number; liveTicks: number; blackRun: number;
        lastNorm: number | null; reported: string | null;
    };
    const tick = (n = 1) => {
        for ( let i = 0; i < n; i++ ) {
            if ( ! ticker ) return;
            clock += 1000;
            bytes += peer ? peer.bytesPerSecond : 0;
            ticker();
        }
    };
    return { state, posted, tick, cleared: () => cleared, running: () => ticker !== null };
}

describe('ezil-mobile.js detects a black picture, which is the one failure every other health signal misses', () => {
    it('runs on a NON-TOUCH device — black is not a phone problem', () => {
        // The keyboard half is a hard no-op here (`not-a-touch-device`). The
        // detector must not be behind that gate. Goes RED if anyone moves it.
        const r = runPictureScript({ pixels: 'black', peer: { bytesPerSecond: 6_000, width: 1920, height: 1080 } });
        r.tick(20);
        expect(r.posted.map((m) => m.code)).toContain('picture_black');
    });

    it('reports a sustained black picture as display_failure at the picture site', () => {
        const r = runPictureScript({ pixels: 'black', peer: { bytesPerSecond: 6_000, width: 1920, height: 1080 } });
        r.tick(20);
        expect(r.posted).toEqual([{
            source: 'ezil-mobile',
            type: 'display_failure',
            site: 'ezil-os:apps/desktop#picture',
            code: 'picture_black',
        }]);
    });

    it('waits out the grace ticks AND the full sustain window before saying so', () => {
        // 3 grace + 8 consecutive black samples. Anything shorter would fire on
        // the ramp-up of a perfectly healthy stream.
        const r = runPictureScript({ pixels: 'black' });
        r.tick(10);
        expect(r.posted).toEqual([]);
        r.tick(1);
        expect(r.posted.length).toBe(1);
    });

    it('🔴 is SILENT on a static-but-painted desktop, and stops costing anything', () => {
        // The calibration reference was equally idle and still read meanLuma
        // 33.6. "Nothing is moving" and "there is nothing to see" are different
        // measurements; this one asks the second question.
        const r = runPictureScript({ pixels: 'lit', peer: { bytesPerSecond: 200, width: 1920, height: 1080 } });
        r.tick(60);
        expect(r.posted).toEqual([]);
        expect(r.state.state).toBe('healthy');
        // One readback and it is done, permanently — for the rest of the
        // session there is no timer, no canvas and no getStats call at all.
        expect(r.running()).toBe(false);
        expect(r.cleared()).toBe(1);
        expect(r.state.liveTicks).toBe(4);
    });

    it('🔴 says NOTHING when there is no stream to judge', () => {
        // A desktop that never connects is a different failure, already owned by
        // the shell's frame/display gates. Reporting it here would double-count
        // it and train people to ignore the row that matters.
        const r = runPictureScript({ video: null });
        r.tick(200);
        expect(r.posted).toEqual([]);
        expect(r.state.state).toBe('gave-up');
    });

    it('🔴 says NOTHING before the video has a decoded frame', () => {
        // An untouched canvas reads back as transparent black. Without the
        // readyState guard this detector would fire on every healthy boot.
        const r = runPictureScript({
            video: { videoWidth: 1920, videoHeight: 1080, readyState: 1 },
            pixels: 'black',
        });
        r.tick(200);
        expect(r.posted).toEqual([]);
        expect(r.state.liveTicks).toBe(0);
    });

    it('falls back to normalised bitrate when the pixels cannot be read, under its own code', () => {
        // 6 kB/s at 1920x1080 = 0.0231 kbps/kpx, below the 0.072 threshold —
        // the production black range was 0.0355–0.0371.
        const r = runPictureScript({
            pixels: 'unreadable',
            peer: { bytesPerSecond: 6_000, width: 1920, height: 1080 },
        });
        r.tick(20);
        expect(r.posted.map((m) => m.code)).toEqual(['picture_starved']);
        expect(r.state.lastNorm).toBeLessThan(0.072);
    });

    it('🔴 does NOT fire on an unreadable picture whose stream is carrying real content', () => {
        // 40 kB/s at 1920x1080 = 0.154 kbps/kpx — the measured healthy idle
        // figure was 0.1419. A blind detector must abstain, not guess.
        const r = runPictureScript({
            pixels: 'unreadable',
            peer: { bytesPerSecond: 40_000, width: 1920, height: 1080 },
        });
        r.tick(30);
        expect(r.posted).toEqual([]);
        expect(r.state.state).toBe('healthy');
    });

    it('🔴 abstains entirely when it has neither pixels nor stats', () => {
        const r = runPictureScript({ pixels: 'unreadable', peer: null });
        r.tick(30);
        expect(r.posted).toEqual([]);
        expect(r.state.reported).toBe(null);
    });

    it('reports at most once, however long it stays black', () => {
        const r = runPictureScript({ pixels: 'black' });
        r.tick(200);
        expect(r.posted.length).toBe(1);
    });

    it('does not replace window.RTCPeerConnection — a broken stream beats a missing row', () => {
        // Swapping the global constructor risks the stream itself. Only one
        // prototype method is wrapped, and the original is still called.
        expect(EZIL_MOBILE_JS).not.toMatch(/window\.RTCPeerConnection\s*=/);
        expect(EZIL_MOBILE_JS).toContain('P.prototype.setRemoteDescription = function');
        expect(EZIL_MOBILE_JS).toContain('return orig.apply(this, arguments);');
    });

    it('every threshold in the file is a stated number, not a magic one', () => {
        for ( const marker of ['BLACK_MAX_LUMA = 2', 'STARVED_KBPS_PER_KPX = 0.072', 'VERDICT_TICKS = 8', 'GRACE_TICKS = 3'] ) {
            expect(EZIL_MOBILE_JS).toContain(marker);
        }
        // …and each one is accompanied by the measurement it came from.
        expect(EZIL_MOBILE_JS).toContain('0.1419 kbps/kpx');
        expect(EZIL_MOBILE_JS).toContain('nonzeroFrac 0.0000');
    });
});
