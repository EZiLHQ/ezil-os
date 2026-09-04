/**
 * The two questions a `SandboxHost` cannot answer, and the seam that lets a
 * host answer them anyway.
 *
 * ── Why this is not an eleventh member of `SandboxHost` ─────────────────────
 * `./sandbox-host.ts` is a PINNED contract: `_TenMembers` makes an eleventh
 * member a compile error by construction, and the whole point of that pin is
 * that a member exists only if BOTH a Docker adapter and a Cloudflare adapter
 * could implement it in terms of "what the product needs". These two are not
 * that shape:
 *
 *   - `probeDisplay` needs the container's ADMIN CREDENTIAL. `DesktopUrls` is
 *     three bare strings and deliberately carries none; the hosted side already
 *     answers this question from the app server
 *     (`probeDesktopDisplay`/`enableImplicitHosting` in
 *     `app/src/server/lib/cloudflare-guacamole-provider.ts`), which holds the
 *     HMAC secret. So the capability is real on both sides and lives in a
 *     different layer on each.
 *   - `readControlMode` is the same credential, one path along.
 *
 * So they are OPTIONAL CAPABILITIES, detected at run time by `canIntrospect`
 * below — the same shape `DockerHost.bootPhase` and `DockerHost.logs` already
 * have (real methods, outside the interface, on the concrete class). A host
 * that does not have them makes `GET /api/shell/desktop?confirm=display`
 * answer `unknown`, which is exactly what `docs/PLATFORM-NOTES.md` §16b
 * requires of a non-answer and exactly what this package did before this row.
 * `../server/fake-host.ts` is that host, and the existing contract test over it
 * is the positive control for the fallback.
 */

import type { ComputerId } from './sandbox-host.ts';

/**
 * §16b's three values, and the third is the load-bearing one.
 *
 * `unknown` is a fact about OUR plumbing, never about the user's screen.
 * Collapsing it into `blank` would show a failure panel over a desktop that is
 * streaming perfectly — "the same lie as the one being fixed, sign flipped,
 * and total".
 */
export type LocalDisplayVerdict = 'live' | 'blank' | 'unknown';

export interface LocalDisplayProbe {
    readonly display: LocalDisplayVerdict;
    /** Non-secret. Why we could not answer, when `display` is `unknown`. */
    readonly reason?: string;
    /** How many sessions neko listed. Present only when the list was understood. */
    readonly sessions?: number;
    /** How many of them had `state.is_watching === true`. Present only when the list was understood. */
    readonly watching?: number;
}

/** `implicit` = a plain click controls the desktop. `manual` = neko wants its own handshake first. Mirrors `DesktopControlMode` in the app. */
export type LocalControlMode = 'implicit' | 'manual';

/**
 * A host that holds the container's admin credential and can therefore ask
 * neko about itself.
 *
 * NEITHER MEMBER MAY THROW. Both are on the desktop-open critical path and
 * both have an honest "we could not tell" value (`unknown` / `'manual'`); an
 * exception here would take down a working desktop to report that we failed to
 * check on it.
 */
export interface DesktopIntrospection {
    /**
     * Has a real browser peer connected? §16b: `state.is_watching` has exactly
     * one writer in neko — `PeerConnectionStateConnected` — so `true` means an
     * `RTCPeerConnection` reached `connected` and neko is pushing media into
     * it. That is the far end of the pipe the browser's same-origin policy
     * forbids us to look at from the near end.
     */
    probeDisplay(id: ComputerId): Promise<LocalDisplayProbe>;

    /**
     * Is the desktop in implicit-hosting mode — i.e. does a plain click do
     * anything? A READ of `/api/room/settings`, never an inference from having
     * set the environment variable.
     */
    readControlMode(id: ComputerId): Promise<LocalControlMode>;
}

/**
 * Does this host have the capability?
 *
 * A structural check on the two method names rather than an `instanceof`: the
 * server is handed a `SandboxHost` and must never import the Docker adapter
 * (`../server/fake-host.ts` says why), so the concrete class is not nameable
 * from where the question is asked.
 */
export function canIntrospect(host: unknown): host is DesktopIntrospection {
    if (typeof host !== 'object' || host === null) return false;
    const candidate = host as Partial<Record<keyof DesktopIntrospection, unknown>>;
    return typeof candidate.probeDisplay === 'function' && typeof candidate.readControlMode === 'function';
}

/**
 * Count the watchers in a `GET /api/sessions` body.
 *
 * 🔴 STRICT, AND THE STRICTNESS IS THE FEATURE — a byte-for-byte port of the
 * rule `probeDesktopDisplay` states: "either we understood the answer or we did
 * not have one". ONE entry whose `state.is_watching` is not a boolean makes the
 * WHOLE count untrustworthy, because the unreadable one could be the watcher.
 * A neko release that renames the field then makes every desktop
 * `ready_unverified` — survivable — instead of making every desktop show a
 * failure panel over a working picture.
 *
 * Pure, so it can be fed a body by hand. `null` means "not understood".
 */
export function countWatchers(body: unknown): { readonly sessions: number; readonly watching: number } | null {
    if (!Array.isArray(body)) return null;
    let watching = 0;
    for (const entry of body) {
        const state = (entry as { state?: { is_watching?: unknown } } | null)?.state;
        if (typeof state?.is_watching !== 'boolean') return null;
        if (state.is_watching) watching++;
    }
    return { sessions: body.length, watching };
}

/**
 * Read `implicit_hosting` out of a `GET /api/room/settings` body.
 *
 * Same rule as `countWatchers`: only the literal boolean `true` is `implicit`.
 * A missing field, a string `"true"`, or a body that is not an object all mean
 * we did not learn that clicks work, and the honest report of that is
 * `'manual'` — which is what the shell already renders a visible fallback
 * affordance for.
 */
export function readImplicitHosting(body: unknown): LocalControlMode {
    if (typeof body !== 'object' || body === null) return 'manual';
    return (body as { implicit_hosting?: unknown }).implicit_hosting === true ? 'implicit' : 'manual';
}
