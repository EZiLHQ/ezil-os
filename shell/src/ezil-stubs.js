// ezil-stubs.js — EZiL-authored. Not Puter code.
//
// 🔴 GOVERNING PRINCIPLE: LOCAL CODE ONLY. Upstream Puter's GUI is written
// against a cloud backend that does not exist in EZiL-OS. `UI/UIWindow.js` was
// deliberately ported WHOLE (all 5,265 lines) rather than pruned, because its
// 25 `is_dir` branches and 72 `i18n()` calls interleave through drag, resize,
// snap and z-order and the cut lines are not contiguous. Pruning it blind
// yields windows that drag but never snap, or minimise but never restore, and
// upstream has no test that would catch it.
//
// The cost of taking it whole is that the file still *references* the cloud.
// This module is what those references resolve to. Every stub here REJECTS or
// THROWS. Nothing returns a plausible-looking empty value, because a stub that
// quietly returns `{}` or `[]` produces a window manager that half-works and
// looks fine — the single worst outcome for this port. If a cloud-backed code
// path ever executes, it must be loud and it must be attributable.
//
// Pruning the now-unreachable branches happens in a later, isolated commit,
// once the shell demonstrably works. Until then this file is also the
// inventory of what would have to be cut.

const PHASE = 'ezil-os:shell';

/**
 * The error every stub raises. A distinct class so a later prune pass can
 * find real reach-through at runtime, and so a console filter can separate
 * "the fork is incomplete" from "the fork is broken".
 */
export class PuterBackendRemovedError extends Error {
    constructor (what) {
        super(
            `[${PHASE}] ${what} is not available: EZiL-OS is a fork of Puter with `
            + 'the cloud backend removed. See shell/PUTER-PROVENANCE.md.',
        );
        this.name = 'PuterBackendRemovedError';
        this.ezil_removed = what;
    }
}

/** Loud, attributable, and non-fatal to the caller's synchronous frame. */
function reject (what) {
    console.error(`[${PHASE}] blocked call to removed backend: ${what}`);
    return Promise.reject(new PuterBackendRemovedError(what));
}

// ---------------------------------------------------------------------------
// `puter.*`
// ---------------------------------------------------------------------------
// Upstream reaches the backend through a global `puter` SDK object: ~40
// `puter.kv.*` calls, ~71 `puter.fs.*`, plus `puter.apps` and `puter.auth`.
// Seven of those survive inside the whole-file UIWindow.js port (four
// `puter.fs.sign`, one `puter.fs.stat`, two `puter.kv.set`) and every one of
// them sits on a filesystem/preferences path EZiL does not have.
//
// Rather than enumerate the SDK surface — which would mean guessing at a shape
// we are deleting — this is a recursive Proxy: ANY property path is legal, and
// calling ANY of them returns a rejected promise naming the exact path that was
// reached. `puter.kv.set(...)` rejects; so does `puter.whatever.new.thing()`.
// Preference reads/writes that used to go through `puter.kv` are served by
// `ezil/session.js` (localStorage) at the call sites that were ported.

function stub_namespace (path) {
    const fn = (...args) => reject(`${path}(${args.length} arg(s))`);
    return new Proxy(fn, {
        get (_target, prop) {
            // Let the object behave itself under inspection/await/logging
            // rather than manufacturing an infinite proxy chain.
            if ( prop === 'then' || prop === 'catch' || prop === 'finally' ) return undefined;
            if ( prop === Symbol.toPrimitive ) return () => `[puter stub ${path}]`;
            if ( prop === Symbol.toStringTag ) return 'PuterStub';
            if ( prop === 'toString' ) return () => `[puter stub ${path}]`;
            if ( prop === 'ezil_removed' ) return path;
            if ( typeof prop !== 'string' ) return undefined;
            return stub_namespace(`${path}.${prop}`);
        },
        apply (_target, _this, args) {
            return reject(`${path}(${args.length} arg(s))`);
        },
    });
}

export const puter = stub_namespace('puter');

// ---------------------------------------------------------------------------
// Modules `UIWindow.js` / `UITaskbar.js` / `UITaskbarItem.js` import but which
// are NOT ported.
// ---------------------------------------------------------------------------
// These are the *only* edits made to UIWindow.js's 5,265 lines: its import
// block now points here instead of at Puter's login dialogs, file-manager
// helpers and app launcher. The body is untouched, so every call site below is
// still reachable exactly where upstream put it — it just fails loudly.
//
// Upstream module -> why it is gone:
//   UIWindowLogin, UIWindowSaveAccount,
//   UIWindowEmailConfirmationRequired      puter.auth — no EZiL identity here
//   UIWindowPublishWebsite                 puter.fs + Puter hosting
//   UIWindowItemProperties                 puter.fs
//   new_context_menu_item, item_icon,
//   refresh_item_container                 puter.fs / UIItem (not ported)
//   launch_app (805 lines)                 puter.apps + IPC.js (not ported)

/** @see DO NOT TAKE list — `helpers/launch_app.js`, 805 lines. */
export function launch_app (options) {
    return reject(`launch_app(${JSON.stringify(options?.name ?? null)})`);
}

/** @see DO NOT TAKE list — `UIItem.js`, 1,911 lines. */
export function item_icon (fsentry) {
    console.error(`[${PHASE}] blocked call to removed backend: item_icon`);
    throw new PuterBackendRemovedError('item_icon');
}

export function new_context_menu_item () {
    console.error(`[${PHASE}] blocked call to removed backend: new_context_menu_item`);
    throw new PuterBackendRemovedError('new_context_menu_item');
}

export function refresh_item_container () {
    console.error(`[${PHASE}] blocked call to removed backend: refresh_item_container`);
    throw new PuterBackendRemovedError('refresh_item_container');
}

export function UIWindowLogin () {
    return reject('UIWindowLogin');
}

export function UIWindowSaveAccount () {
    return reject('UIWindowSaveAccount');
}

export function UIWindowEmailConfirmationRequired () {
    return reject('UIWindowEmailConfirmationRequired');
}

export function UIWindowPublishWebsite () {
    return reject('UIWindowPublishWebsite');
}

export function UIWindowItemProperties () {
    return reject('UIWindowItemProperties');
}

export default {
    puter,
    launch_app,
    item_icon,
    new_context_menu_item,
    refresh_item_container,
    UIWindowLogin,
    UIWindowSaveAccount,
    UIWindowEmailConfirmationRequired,
    UIWindowPublishWebsite,
    UIWindowItemProperties,
    PuterBackendRemovedError,
};
