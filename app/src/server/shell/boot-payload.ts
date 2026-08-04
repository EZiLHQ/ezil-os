/**
 * The EZiL OS shell's boot payload — `window.__EZIL_BOOT__`.
 *
 * ONE definition, TWO transports:
 *   - `/os` (src/app/os/page.tsx) inlines it in the HTML, so the shell has
 *     everything it needs in its first paint and makes zero requests to find
 *     out who it is or which computer it owns;
 *   - `/api/shell/session` returns the identical object as JSON, for the
 *     rehydrate path (a shell that started without the inline copy, or one
 *     re-checking after a long idle).
 *
 * Both go through this module, so the two can never disagree about the shape.
 *
 * ── Why it is plain JSON, not superjson ─────────────────────────────────────
 * The shell is jQuery. Bundling `@trpc/client` + `superjson` into it to talk
 * to our own server would be a second authorization implementation and a
 * second serialization format, for no gain. So every date crosses as an ISO
 * 8601 string and every field is JSON-native. The AUTHORIZATION stays single:
 * both transports call the same tRPC procedures through
 * `appRouter.createCaller`, so `protectedProcedure` and the ownership-scoped
 * row filters are the only gate in either direction.
 *
 * ── What is deliberately NOT in here ────────────────────────────────────────
 * Per-user desktop preferences — window positions, icon layout, wallpaper
 * choice. Upstream Puter reads those from its cloud key-value store
 * (`puter.kv`); this fork has no such backend, and preferences are
 * browser-local through `shell/ezil/session.js` (localStorage). The server
 * genuinely does not know them, so the payload does not pretend to.
 *
 * No secret is representable here: no Worker URL, no HMAC secret, no preview
 * URL. `desktopState` carries booleans the browser can already obtain from
 * `cloudflareGuacamole.isConfigured`, and nothing else. `SHELL_API_ROUTES`
 * below is a ROUTE PATH, same-origin and relative — never a preview URL
 * itself. `previewUrl` in particular is deliberately absent from every
 * payload this module builds: an app-preview bootstrap token has a
 * 5-minute TTL (`APP_PREVIEW_BOOTSTRAP_TOKEN_MAX_AGE_MS`,
 * `cloudflare-guacamole-provider.ts`), so baking one in here — built once,
 * possibly minutes before a window is actually opened — would hand the
 * shell a token that is dead on arrival. The shell calls the route fresh,
 * per window-open, instead.
 */

import type { Computer } from '@/server/db/schema';

/** The HTTP surface the shell talks to. Declared once; the Route Handlers live at these paths. */
export const SHELL_API_ROUTES = {
    /** GET = read the current session (never writes). POST = get-or-create the default computer. */
    session: '/api/shell/session',
    /** GET = cheap status poll. POST = start/attach the desktop (a COLD BOOT, ~22s). */
    desktop: '/api/shell/desktop',
    /**
     * POST = mint a fresh app-preview window URL (a 5-minute-TTL bootstrap
     * token). Call PER WINDOW-OPEN, and refetch roughly every 50s while the
     * window stays open — see `cloudflareGuacamole.appPreviewUrl`'s doc
     * comment for why this must never be cached across a long idle.
     */
    previewUrl: '/api/shell/preview-url',
    /**
     * POST = mint a fresh code-server window URL (a 5-minute-TTL bootstrap
     * token). Same call-per-window-open, refetch-while-open rules as
     * `previewUrl` above — see `cloudflareGuacamole.codePreviewUrl`'s doc
     * comment. MODIFIED BY EZIL 2026-08-01 (T7).
     */
    codePreviewUrl: '/api/shell/code-preview-url',
    /**
     * POST = foreground an app inside the container's X session
     * (`{ computerId, app }`). The shell's in-stream switcher FEATURE-DETECTS
     * this key: `shell/ezil/apps/desktop-window.js` reads
     * `desktopState.endpoints.focus` and draws no switcher at all when it is
     * absent, rather than POST to a URL it invented. So this entry is not
     * documentation — it is the switch that turns the control on, and it must
     * only be present while `src/app/api/shell/focus/route.ts` exists.
     */
    focus: '/api/shell/focus',
    /**
     * POST = a batch of crash/error telemetry events (see
     * `scratchpad/telemetry-design.md`). Same feature-detection contract as
     * `focus`: `shell/ezil/telemetry.js` reads `desktopState.endpoints.telemetry`
     * and stays permanently dark — no buffering, no beacon, no timer — if the
     * key is absent, rather than POSTing to a URL an older/newer bundle
     * invented. This is what makes the route and the shell module independently
     * mergeable (`scratchpad/telemetry-design.md` §9's suggested landing order).
     * Always responds 202 regardless of outcome — see the route's own doc
     * comment for why the response is never meaningfully read.
     */
    telemetry: '/api/shell/telemetry',
    /**
     * POST = restart the desktop stack inside a computer's LIVE container
     * (`{ computerId }`), without destroying the container, the computer row
     * or the workspace. Third instance of the same feature-detection contract
     * as `focus` and `telemetry`: `shell/ezil/session.js`'s `restartEndpoint()`
     * reads `desktopState.endpoints.restart` fresh on every call and
     * `ui/Settings/tabs/troubleshoot.js` renders a DISABLED button saying so
     * when it is absent, rather than POSTing to a URL it invented. So this
     * entry is the switch that turns the Troubleshoot restart control on, and
     * it must only be present while `src/app/api/shell/restart/route.ts`
     * exists — which in turn only works while the Worker serves
     * `POST /sandbox/:name/restart`.
     */
    restart: '/api/shell/restart',
    /**
     * POST = record that a human is present at a computer's desktop
     * (`{ computerId, lastInputAgoMs }`), so the Worker's container-idle
     * reaper does not cool it down while someone is actually watching.
     * Fourth instance of the `focus`/`telemetry`/`restart` feature-detection
     * contract: `shell/ezil/session.js`'s `activityEndpoint()` reads
     * `desktopState.endpoints.activity` fresh on every call and
     * `shell/ezil/apps/desktop-window.js`'s heartbeat simply never fires a
     * request when it is absent, rather than POSTing to a URL it invented —
     * an older server build degrades to no heartbeat, not a console full of
     * 404s. This entry is the switch that turns the heartbeat's NETWORK CALL
     * on; the client-side timer and input tracking run either way.
     */
    activity: '/api/shell/activity',
} as const;

export interface ShellBootUser {
    id: string;
    /** Supabase can return a user with no email (other identity providers). Never faked. */
    email: string | null;
}

export interface ShellBootComputer {
    id: string;
    name: string;
    slot: number;
    /** ISO 8601. */
    createdAt: string;
    /** ISO 8601, or null if never opened. */
    lastOpenedAt: string | null;
    /**
     * True only when THIS boot created the row — i.e. the user's very first
     * computer, one second old. The shell can use it to decide whether an
     * empty workspace is expected (a new computer boots empty — see
     * docs/RUNBOOK.md A2) rather than a sign something was lost.
     */
    isNew: boolean;
}

/**
 * An app the shell may show. This is the SERVER's registry: an entry exists
 * only if the host can actually launch it today. Right now that is exactly
 * one thing — the streamed Linux desktop — and listing anything else would be
 * an icon that does nothing.
 */
export interface ShellBootApp {
    id: string;
    name: string;
    /** Icon key the shell resolves against `/os/icons.js`. */
    icon: string;
    kind: 'desktop';
}

export const SHELL_APPS: readonly ShellBootApp[] = [
    // MODIFIED BY EZIL 2026-08-03: renamed from 'Linux Desktop' to match
    // `shell/ezil/apps/registry.js`'s own entry, which is what the Start menu,
    // taskbar tooltip and app drawer actually render. `registry.resolve()`
    // reads only `served[].id` from this list, never `.name`, so this string
    // reaches no user today — it is corrected because it is the SERVER's
    // declaration of what the app is called, and leaving the two names
    // disagreeing in a public repo is how the next person picks the wrong one.
    { id: 'desktop', name: 'Browser', icon: 'desktop', kind: 'desktop' },
];

export interface ShellDesktopState {
    provider: 'cloudflare-guacamole';
    /** Whether the desktop Worker is configured at all. From `cloudflareGuacamole.isConfigured`. */
    configured: boolean;
    /** Whether a signing secret is present. A configured Worker without one will reject every call. */
    hasHmacSecret: boolean;
    /**
     * ALWAYS 'idle' at boot. The page never asks the container anything — see
     * `src/app/os/page.tsx` — so at this instant the server has no observation
     * of whether the desktop is up, and refuses to imply one. The shell moves
     * this along only from real answers to `SHELL_API_ROUTES.desktop`.
     */
    status: 'idle';
    endpoints: typeof SHELL_API_ROUTES;
}

export interface ShellBootPayload {
    user: ShellBootUser;
    computer: ShellBootComputer;
    apps: readonly ShellBootApp[];
    desktopState: ShellDesktopState;
}

/** The same payload with no computer — the read-only `GET /api/shell/session` answer. */
export type ShellSessionPayload = Omit<ShellBootPayload, 'computer'> & {
    computer: ShellBootComputer | null;
};

export interface DesktopProviderInfo {
    isConfigured: boolean;
    hasHmacSecret: boolean;
}

export function toShellBootComputer(computer: Computer, isNew: boolean): ShellBootComputer {
    return {
        id: computer.id,
        name: computer.name,
        slot: computer.slot,
        createdAt: computer.createdAt.toISOString(),
        lastOpenedAt: computer.lastOpenedAt?.toISOString() ?? null,
        isNew,
    };
}

export function toShellDesktopState(provider: DesktopProviderInfo | null): ShellDesktopState {
    return {
        provider: 'cloudflare-guacamole',
        // A provider lookup that FAILED is reported as not configured, never
        // as configured-and-fine. The shell's honest "not configured" panel is
        // a better answer than a desktop that silently never arrives.
        configured: provider?.isConfigured === true,
        hasHmacSecret: provider?.hasHmacSecret === true,
        status: 'idle',
        endpoints: SHELL_API_ROUTES,
    };
}

export function buildShellBootPayload(input: {
    user: { id: string; email?: string | null };
    computer: Computer;
    isNew: boolean;
    provider: DesktopProviderInfo | null;
}): ShellBootPayload {
    return {
        user: { id: input.user.id, email: input.user.email ?? null },
        computer: toShellBootComputer(input.computer, input.isNew),
        apps: SHELL_APPS,
        desktopState: toShellDesktopState(input.provider),
    };
}

/**
 * Serialize the payload for inlining inside a `<script>` element.
 *
 * Escaping `<` is the whole job and it is not optional. An unescaped `<` lets
 * any string that reaches this payload close the script element (`</script>`)
 * or open an HTML comment (`<!--`) and take over the document. The only
 * user-controlled strings here are the computer name and the email address —
 * both of which a user can set — so this is a live injection surface, not a
 * theoretical one. `<` is valid inside a JSON string and parses back to
 * `<`, so the shell sees the original text unchanged.
 *
 * U+2028/U+2029 are legal inside JS string literals since ES2019 and legal
 * JSON either way, but they are escaped too: this string is also embedded in
 * HTML, and cheap belt-and-braces beats a subtle parse failure on an old
 * engine.
 */
export function serializeBootPayload(payload: ShellBootPayload | ShellSessionPayload): string {
    return JSON.stringify(payload)
        .replace(/</g, '\\u003c')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

/** The exact inline script body `/os` emits. Kept here so the escaping above cannot be bypassed. */
export function bootPayloadScript(payload: ShellBootPayload): string {
    return `window.__EZIL_BOOT__=${serializeBootPayload(payload)};`;
}
