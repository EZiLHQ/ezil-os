/**
 * `/os` — the host document, as a plain string.
 *
 * ── Why there is no React here, and why that is the SAFE version ────────────
 * The hosted `/os` (`app/src/app/os/page.tsx`) is a React Server Component
 * inside the app's root layout, so React owns `<body>` and `#ezil-os-root` and
 * will re-check them when its chunks arrive. `docs/PLATFORM-NOTES.md` §14: if
 * the shell mutates a node React owns before that check, React reports
 * mismatch #418 and REGENERATES THE WHOLE TREE — measured, 4 of 5 loads ended
 * as a blank white page — and `suppressHydrationWarning` suppresses the
 * warning, not the regeneration. The whole hydration handshake
 * (`data-awaits-hydration="react"`, `ezil:hydrated`, `HYDRATION_CAP_MS`) exists
 * to survive that.
 *
 * 🔴 SO THIS DOCUMENT MUST NOT CARRY `data-awaits-hydration`. `shell/ezil/
 * boot.js:931`'s `awaits_hydration()` is opt-IN — it returns true only for the
 * exact string `"react"` — and `when_hydrated` mounts IMMEDIATELY on a page
 * without it ("an unmarked page (the headless tests, a bare host) mounts
 * immediately, so nothing ever waits on an event that is never coming").
 * Copying the attribute across from `page.tsx` would make every local boot wait
 * the full `HYDRATION_CAP_MS` (3s) for an event no local page will ever
 * dispatch. `./os-document.test.ts` asserts its ABSENCE, with the shell's
 * immediate-mount path as the positive control.
 *
 * ── What IS copied across, and why each piece ───────────────────────────────
 *   - `<link rel="stylesheet" href="/os/bundle.min.css">` — a plain link, not a
 *     bundler import, exactly as `page.tsx` explains: the CSS is a build output
 *     of `shell/build-shell.sh`, versioned with the shell.
 *   - `<div id="ezil-os-root">` wrapping `<div class="desktop ezil-desktop">` —
 *     `mount_desktop_root()` (`boot.js:628`) REUSES an existing `.desktop`
 *     rather than appending a second, so the wallpaper is painted from the HTML
 *     before a single byte of the 687KB bundle has run. The class pair is
 *     duplicated from `shell/ezil/ui/ezil-shell.css`; change it here, there and
 *     in `page.tsx` together.
 *   - The inline payload, then `icons.js`, then `bundle.min.js`. ORDER IS
 *     LOAD-BEARING and the reason is `page.tsx`'s: the payload must exist
 *     before the bundle runs and the icons before the bundle that draws them.
 *     The inline script executes during parse; `defer` preserves document order
 *     between the two external ones. NEVER `async` — `async` would let the
 *     bundle run before its icons.
 *   - `interactive-widget=overlays-content` on the viewport meta. Reproduced
 *     from `app/src/app/layout.tsx`'s `viewport` export, whose comment records
 *     what its absence did on a phone: the on-screen keyboard pushed the whole
 *     page up instead of floating over it, sliding the desktop the user was
 *     typing into off the screen.
 *
 * ── What is deliberately NOT copied ─────────────────────────────────────────
 * `<BootWatchdog>` and `<HydrationSignal>` are React components that exist to
 * survive the App Router. The watchdog's job is to notice a page entered by a
 * CLIENT-SIDE NAVIGATION with no boot payload (§17) and reload once; this host
 * serves one document over one HTTP request and has no client-side router, so
 * the state it guards against cannot occur. Every local `/os` load carries an
 * inlined payload by construction — there is no branch here that can omit it.
 */

import { bootPayloadScript } from '../contract/shell-api.ts';
import type { ShellBootPayload } from '../contract/shell-api.ts';

/** The three files the document loads, as the paths it loads them by. Same strings the server routes on. */
export const OS_ASSET_PATHS = {
    css: '/os/bundle.min.css',
    icons: '/os/icons.js',
    bundle: '/os/bundle.min.js',
} as const;

/**
 * The chrome the hosted document gets from Tailwind in `app/src/app/layout.tsx`
 * (`<html class="h-full antialiased">`, `<body class="min-h-full flex
 * flex-col">`), restated as the CSS those four utilities compile to.
 *
 * Local mode loads no Tailwind — `bundle.min.css` is the shell's own stylesheet
 * and nothing else — so the classes would be inert here. The shell does not
 * strictly need any of it (`#ezil-os-root` is `position:fixed;inset:0` and
 * `.desktop` sizes off `100vh`), but the reference host serves it and a
 * document that differs from the reference in ways nobody wrote down is how the
 * next layout bug becomes unreproducible.
 */
const ROOT_CHROME_CSS = 'html{height:100%;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}'
    + 'body{min-height:100%;display:flex;flex-direction:column}';

/**
 * Render the `/os` document.
 *
 * 🔴 THE PAYLOAD GOES THROUGH `bootPayloadScript` AND NOTHING ELSE.
 * That is the byte-identical twin of the app's serializer, and escaping `<` is
 * the whole job: `<` is legal inside a JSON string and parses back to `<`, so
 * the shell sees the original text unchanged, while leaving it raw would let
 * any string in the payload close this script element (`</script>`) or open an
 * HTML comment (`<!--`) and take over the page. The user-controlled strings
 * here are the computer name and (hosted) the email address. Interpolating the
 * payload any other way — a second `JSON.stringify`, a template with a manual
 * escape — is the defect `../contract/shell-api.ts`'s header describes: "a code
 * path nobody diffs because it looks like a one-liner".
 */
export function renderOsDocument(payload: ShellBootPayload): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, interactive-widget=overlays-content">
<title>EZiL OS</title>
<meta name="description" content="Your computer, in your browser.">
<style>${ROOT_CHROME_CSS}</style>
<link rel="stylesheet" href="${OS_ASSET_PATHS.css}">
</head>
<body>
<div id="ezil-os-root"><div class="desktop ezil-desktop"></div></div>
<script>${bootPayloadScript(payload)}</script>
<script src="${OS_ASSET_PATHS.icons}" defer></script>
<script src="${OS_ASSET_PATHS.bundle}" defer></script>
</body>
</html>
`;
}
