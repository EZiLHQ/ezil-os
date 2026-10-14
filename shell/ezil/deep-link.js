// deep-link.js — `/app/<name>`: open EZiL OS with one app in front.
//
// ADDED BY EZIL 2026-10-14. Puter's own app-launch deep-link router did not
// cross into this fork (see boot.js's header), and "login opens nothing" (W3)
// still holds for `/os`. This is the one exception, and only when the URL
// itself names an app: a link such as Works' "Open in EZiL OS"
// (`/app/code?task=…#c=<one-use code>`) or a pasted `/app/settings`. The
// server serves the same document for `/app/<name>` as for `/os`
// (`app/src/app/app/[name]/page.tsx`); this file decides what that arrival
// opens.
//
// 🔴 READ ONCE, THEN CLEAN THE URL. The address bar is replaced with `/os`
// before anything else runs, so the launch code in the fragment never stays
// in history, in the address bar, or in a bookmark, and a rebuild
// (`ensure_intact` -> `build`) cannot reopen the app: the second call finds
// nothing to take. The shell never rewrites the URL on the desktop, so `/os`
// is the honest address for what is on screen.

/** Registry ids: lowercase words joined by single hyphens (`apps/registry.js` `APPS`). */
const APP_PATH = /^\/app\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/;
const MAX_ID = 40;

let taken = false;

/**
 * The deep link this page was opened with, or null. Returns it at most once
 * per page load, and replaces the URL with `/os` the first time it is asked,
 * whether or not the path named an app.
 *
 * `launchCode` is the fragment's `c` (a one-use, ≤60-second Works launch
 * code). Pass it only to the app it was minted for; it is not kept anywhere
 * else.
 */
export function takeDeepLink (loc = window.location, hist = window.history) {
    if ( taken ) return null;
    taken = true;
    const m = APP_PATH.exec(loc.pathname);
    const link = m && m[1].length <= MAX_ID ? {
        app: m[1],
        query: Object.fromEntries(new URLSearchParams(loc.search)),
        launchCode: new URLSearchParams(String(loc.hash || '').replace(/^#/, '')).get('c'),
    } : null;
    if ( m ) {
        try {
            hist.replaceState(hist.state, '', '/os');
        } catch ( e ) {
            // A sandboxed or detached document: nothing to clean, nothing to fail.
        }
    }
    return link;
}

/** Tests only: forget that the link was taken. */
export function resetDeepLinkForTest () {
    taken = false;
}
