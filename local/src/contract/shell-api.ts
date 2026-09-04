/**
 * The shell's HTTP contract, as local mode must serve it.
 *
 * `/os` is the same jQuery shell in both modes. It boots from
 * `window.__EZIL_BOOT__`, feature-detects every optional control by looking for
 * a key in `desktopState.endpoints`, and talks to nothing else. So a local host
 * that serves `/os` has to answer at exactly the paths
 * `app/src/server/shell/boot-payload.ts` declares, and has to inline the boot
 * payload with byte-identical escaping — the shell has no idea which server it
 * is talking to and must not need one.
 *
 * ── Why this is a MIRROR and not an import ──────────────────────────────────
 * Local mode is a native Bun host with no Cloudflare in it and no dependency on
 * the Next.js app package. Importing the app's module at runtime would make
 * `local/` depend on `app/`'s build to start a desktop on a laptop.
 *
 * A mirror without a guard is just a second contract, so `./shell-api.test.ts`
 * imports the app's real `SHELL_API_ROUTES` and `serializeBootPayload` BY
 * RELATIVE PATH and fails when either side has a key the other lacks, or when
 * the two escapers disagree on a single byte over the whole BMP. Measured:
 * that import is safe — `boot-payload.ts`'s only import is
 * `import type { Computer }`, which Bun erases, so nothing of Next.js, `@/env`
 * or the database is loaded at runtime, and `tsc --listFiles` shows it pulling
 * in exactly four app files, all of which typecheck clean under this package's
 * `noUncheckedIndexedAccess`.
 *
 * ── Why a drifted escaper is the serious half ───────────────────────────────
 * `serializeBootPayload` below is inlined into a `<script>` element in a
 * document. The user-controlled strings in the payload are the computer name
 * and the email address. Escaping `<` is what stops either of them from closing
 * the script element (`</script>`) or opening an HTML comment (`<!--`) and
 * taking over the page. A local host that re-implemented this "the same way"
 * and got it subtly wrong would ship an XSS to every user running EZiL OS on
 * their own machine, in a code path nobody diffs because it looks like a
 * one-liner.
 */

/**
 * Payload shapes, imported as TYPES ONLY.
 *
 * `import type` is erased at compile time (`verbatimModuleSyntax` guarantees
 * nothing is emitted for it), so this costs the local host no runtime coupling
 * to the app at all — while still meaning there is exactly one definition of
 * what a boot payload is.
 */
export type {
    DesktopProviderInfo,
    ShellBootApp,
    ShellBootComputer,
    ShellBootPayload,
    ShellBootUser,
    ShellDesktopState,
    ShellSessionPayload,
} from '../../../app/src/server/shell/boot-payload.ts';

/**
 * The nine routes the shell talks to. Same keys, same paths, same order as
 * `SHELL_API_ROUTES` in `app/src/server/shell/boot-payload.ts`.
 *
 * 🔴 A KEY HERE IS A SWITCH, NOT DOCUMENTATION. Five of these
 * (`focus`, `telemetry`, `restart`, `activity`, `screen`) are feature-detected
 * by the shell: `shell/ezil/apps/desktop-window.js`,
 * `shell/ezil/telemetry.js`, `shell/ezil/session.js` and
 * `shell/ezil/apps/desktop-screen.js` each read their key out of
 * `desktopState.endpoints` and stay COMPLETELY dark when it is absent — no
 * control drawn, no timer, no beacon, no request — rather than POSTing to a URL
 * they invented. So the local host must publish a key only while it actually
 * serves that path. Publishing one it does not serve is a control that 404s;
 * omitting one it does serve is a feature the user silently never gets.
 */
export const SHELL_API_ROUTES = {
    /** GET = read the current session (never writes). POST = get-or-create the default computer. */
    session: '/api/shell/session',
    /** GET = cheap status poll. POST = start/attach the desktop (a COLD BOOT). */
    desktop: '/api/shell/desktop',
    /** POST = mint a fresh app-preview window URL. Locally this is `http://127.0.0.1:3002`; there is no token and no TTL because there is no public hostname to protect. */
    previewUrl: '/api/shell/preview-url',
    /** POST = mint a fresh code-server window URL. Locally `http://127.0.0.1:8443`. */
    codePreviewUrl: '/api/shell/code-preview-url',
    /** POST = foreground an app inside the container's X session (`{ computerId, app }`). Feature-detected. */
    focus: '/api/shell/focus',
    /** POST = a batch of crash/error telemetry events. Feature-detected. Always answers 202. */
    telemetry: '/api/shell/telemetry',
    /** POST = restart the desktop stack inside a LIVE container, without destroying it or the workspace. Feature-detected. */
    restart: '/api/shell/restart',
    /** POST = record that a human is present at the desktop, so the idle reaper does not cool it down. Feature-detected. */
    activity: '/api/shell/activity',
    /** POST = change the X screen mode of a LIVE desktop (`{ computerId, width, height }`). Feature-detected. */
    screen: '/api/shell/screen',
} as const;

/** The nine route keys, as a type. */
export type ShellApiRoute = keyof typeof SHELL_API_ROUTES;

/** The nine route keys, as a value — useful for iterating without `Object.keys`'s `string[]`. */
export const SHELL_API_ROUTE_KEYS = Object.keys(SHELL_API_ROUTES) as readonly ShellApiRoute[];

/**
 * Serialize a boot payload for inlining inside a `<script>` element.
 *
 * 🔴 BYTE-IDENTICAL TO `serializeBootPayload` IN
 * `app/src/server/shell/boot-payload.ts`, AND THAT IS A TESTED PROPERTY, NOT A
 * COMMENT. `./shell-api.test.ts` runs both implementations over the literal
 * strings `</script>`, `<!--`, U+2028 and U+2029, and then over every code unit
 * from U+0000 to U+FFFF, and asserts the two outputs are equal byte for byte.
 *
 * Escaping `<` is the whole job. `<` is legal inside a JSON string and parses
 * back to `<`, so the shell sees the original text unchanged; leaving it raw
 * lets any user-controlled string in the payload close the script element or
 * open an HTML comment. U+2028/U+2029 are legal in JS string literals since
 * ES2019 and legal JSON either way, but this string is also embedded in HTML —
 * cheap belt-and-braces beats a subtle parse failure on an old engine.
 *
 * Typed `unknown` rather than a payload union so it can be used for the
 * `/api/shell/session` answer, the `/os` inline copy and anything a later row
 * adds — the escaping is a property of the OUTPUT, not of the shape. The
 * behaviour for a value `JSON.stringify` cannot represent (a bare `undefined`,
 * a function) is a `TypeError`, exactly as upstream: an input that produces no
 * JSON must not quietly produce a `<script>` body either.
 */
export function serializeBootPayload(payload: unknown): string {
    return JSON.stringify(payload)
        .replace(/</g, '\\u003c')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

/** The exact inline script body `/os` emits. Kept here so the escaping above cannot be bypassed. */
export function bootPayloadScript(payload: unknown): string {
    return `window.__EZIL_BOOT__=${serializeBootPayload(payload)};`;
}
