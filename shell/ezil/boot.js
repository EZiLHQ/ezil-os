// boot.js — EZiL-authored. The single entry point `shell/build-shell.sh` hands
// to esbuild; everything that ends up in `app/public/os/bundle.min.js` is
// reachable from here.
//
// Wave 0 scaffold. It deliberately does nothing yet beyond proving the bundle
// loads and exposing the namespace later waves attach to. No Puter code is
// imported yet — Wave 1 lands `shell/src/` and wires it in here.

import session from './session.js';

const PHASE = 'ezil-os:boot';

export const shell = {
    version: 0,
    session,
    /** Set by Wave 1 once the ported Puter desktop is mounted. */
    desktop: null,
};

export function boot() {
    // Phase-tagged, timestamped logging — the only observability that survives
    // into the browser. See docs/PLATFORM-NOTES.md §11.
    console.info(`[${PHASE}] scaffold loaded (v${shell.version})`);
    return shell;
}

if (typeof globalThis !== 'undefined') {
    globalThis.ezil = shell;
}

export default shell;
