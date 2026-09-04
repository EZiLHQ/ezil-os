/**
 * The local boot payload — `window.__EZIL_BOOT__`, as this host serves it.
 *
 * Same object the hosted `/os` inlines and the same object
 * `GET|POST /api/shell/session` returns, built from a local identity instead of
 * a Supabase session. The shell has no idea which server it is talking to and
 * must not need one, so every field here is the shape
 * `app/src/server/shell/boot-payload.ts` declares — the types are IMPORTED from
 * it (through `../contract/shell-api.ts`, type-only), so a field that changed
 * there is a compile error here rather than a shell that quietly reads
 * `undefined`.
 */

import { SHELL_API_ROUTES } from '../contract/shell-api.ts';
import type {
    ShellBootApp,
    ShellBootComputer,
    ShellBootPayload,
    ShellBootUser,
    ShellDesktopState,
    ShellSessionPayload,
} from '../contract/shell-api.ts';
import { LOCAL_USER } from './identity.ts';

/**
 * The apps this host can actually launch.
 *
 * A MIRROR of `SHELL_APPS` in `app/src/server/shell/boot-payload.ts`, not an
 * import, for the reason `../contract/shell-api.ts` gives for mirroring
 * `SHELL_API_ROUTES`: the local host must not need the Next.js app's build to
 * start a desktop on a laptop. `./payload.test.ts` imports the app's real
 * `SHELL_APPS` by relative path and fails on any difference, so the two cannot
 * drift silently.
 *
 * One entry, deliberately. `boot-payload.ts` states the rule: "an entry exists
 * only if the host can actually launch it today", and listing anything else
 * would be an icon that does nothing.
 */
export const LOCAL_SHELL_APPS: readonly ShellBootApp[] = [
    { id: 'desktop', name: 'Browser', icon: 'desktop', kind: 'desktop' },
];

/**
 * 🔴 THE ONE FACTUALLY WRONG VALUE IN THIS FILE, AND IT IS FORCED.
 *
 * `ShellDesktopState.provider` is the LITERAL type `'cloudflare-guacamole'`.
 * Local mode's desktop provider is Docker on the user's own machine and is
 * emphatically not that. The value is emitted anyway because:
 *   - the field is not optional and the type admits no other value, and this
 *     package does not own `app/src/server/shell/boot-payload.ts`;
 *   - NOTHING in `shell/` reads `desktopState.provider` — grepped across every
 *     `shell/**\/*.js`, zero readers — so no behaviour depends on it.
 * It is a contract smell for a later row (widen the literal to a union, or drop
 * the field), recorded here rather than papered over. It is also the ONE
 * non-comment hit the vendor-name grep in `../server/no-hostname.test.ts`
 * allows, and that allowance is pinned to this line.
 */
export const LOCAL_DESKTOP_PROVIDER_TAG: ShellDesktopState['provider'] = 'cloudflare-guacamole';

/**
 * `desktopState`, as local mode reports it.
 *
 * ── `configured: true` is LOAD-BEARING ──────────────────────────────────────
 * `shell/ezil/apps/desktop-window.js:1106` renders the "no desktop provider is
 * configured" panel and stops when it is not exactly `true`, and
 * `shell/ezil/boot.js:654` refuses to warm the container without it. A local
 * host that has a Docker adapter IS configured, so this is a true statement,
 * not a switch flipped to make a panel go away.
 *
 * ── `hasHmacSecret: false` is INERT, and that was checked ───────────────────
 * Local mode signs nothing: there is no Worker to authenticate to and no shared
 * secret to hold. Grepped across `shell/**`: `hasHmacSecret` has ZERO readers
 * in the shell — the only occurrences anywhere are in the app's own tests
 * (`app/src/server/shell/boot-payload.test.ts`). So `false` changes no shell
 * behaviour, and in particular it does NOT disable any control: every optional
 * control is feature-detected from `endpoints`, never from this flag.
 *
 * ── `status: 'idle'` is the honest one ──────────────────────────────────────
 * Same reason as hosted, and it is stronger here: building this payload asks
 * the container nothing (`SandboxHost.status` is never called on this path), so
 * at this instant the host has no observation of whether the desktop is up and
 * must not imply one. The shell moves it along only from real answers to
 * `SHELL_API_ROUTES.desktop`.
 *
 * ── `endpoints` is a SWITCH ─────────────────────────────────────────────────
 * All nine keys are published because this host serves all nine paths
 * (`../server/routes.ts`). Publishing a key it did not serve would be a control
 * that 404s; omitting one it does serve would be a feature the user silently
 * never gets.
 */
export function localDesktopState(): ShellDesktopState {
    return {
        provider: LOCAL_DESKTOP_PROVIDER_TAG,
        configured: true,
        hasHmacSecret: false,
        status: 'idle',
        endpoints: SHELL_API_ROUTES,
    };
}

/** The full boot payload: what `/os` inlines and what `POST /api/shell/session` answers. */
export function buildLocalBootPayload(computer: ShellBootComputer, user: ShellBootUser = LOCAL_USER): ShellBootPayload {
    return {
        user,
        computer,
        apps: LOCAL_SHELL_APPS,
        desktopState: localDesktopState(),
    };
}

/**
 * The read-only `GET /api/shell/session` answer.
 *
 * Typed with a nullable computer to mirror the hosted route exactly, even
 * though local mode always has one: a user with no computer is a state the
 * SHAPE has to admit, and narrowing it here would make the local answer a
 * different type from the hosted one for no gain.
 */
export function buildLocalSessionPayload(
    computer: ShellBootComputer | null,
    user: ShellBootUser = LOCAL_USER,
): ShellSessionPayload {
    return {
        user,
        computer,
        apps: LOCAL_SHELL_APPS,
        desktopState: localDesktopState(),
    };
}
