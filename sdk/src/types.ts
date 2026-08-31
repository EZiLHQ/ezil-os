/**
 * The wire types of the EZiL-OS computer API.
 *
 * Hand-written rather than imported from `app/`, so this package stands alone
 * and can be published without dragging the Next.js app's source with it. The
 * cost of that choice is drift, and drift is not left to vigilance:
 * `src/surface.test.ts` reads the real routers in `app/src/server/api/routers/`
 * and fails if this file describes a procedure the server does not have, or
 * misses one the server gained.
 */

/** A user's computer. Mirrors `ezil_computers` (`app/src/server/db/schema/computers.ts`). */
export interface Computer {
    id: string;
    userId: string;
    name: string;
    /** `1` or `2`. A user may hold at most two live computers; the cap is a CHECK constraint, not just application code. */
    slot: 1 | 2;
    createdAt: Date;
    /** `null` when the computer has been created but never opened. */
    lastOpenedAt: Date | null;
    /** Soft-delete marker. A deleted computer is never returned by `list`/`get`. */
    deletedAt: Date | null;
    metadata: unknown;
}

/** Result of `desktop.status` — a cheap poll that never boots anything. */
export interface DesktopStatus {
    ok: boolean;
    running?: boolean;
    sandboxId?: string | null;
    mode?: string | null;
    [key: string]: unknown;
}

/**
 * A minted desktop URL.
 *
 * 🔴 SHORT-LIVED, AND SINGLE-PURPOSE. The embedded token is a bootstrap token
 * with roughly a five-minute life, and navigating to the URL exchanges it for a
 * session cookie. Mint one per window-open and navigate promptly. Stashing one
 * and opening it on a later click gets a 401 and a blank window with no visible
 * cause — see `cloudflareGuacamole.appPreviewUrl` in
 * `app/src/server/api/routers/cloudflare-guacamole.ts`.
 */
export interface DesktopUrl {
    ok: boolean;
    url?: string | null;
    expiresAt?: string | null;
    mode?: string | null;
    sandboxId?: string | null;
    [key: string]: unknown;
}

/** Options for {@link createEzilClient}. */
export interface EzilClientOptions {
    /**
     * Origin of the EZiL-OS app, e.g. `https://ezil-os.vercel.app`. A path is
     * allowed and preserved, so a reverse-proxied deployment works.
     */
    baseUrl: string;
    /**
     * A Supabase access token for the acting user. Sent as
     * `Authorization: Bearer <token>`.
     *
     * This is the user's own credential and carries the user's own permissions
     * — there is no separate API-key or service credential in EZiL-OS, and the
     * Worker's HMAC secret is emphatically not this. A function is accepted so
     * a long-lived process can refresh an expiring token without rebuilding the
     * client.
     */
    token: string | (() => string | Promise<string>);
    /** Defaults to global `fetch`. Supply one to add retries, proxying or tests. */
    fetch?: typeof globalThis.fetch;
    /** Per-request timeout in ms. Default 300000 — a cold container boot is slow by nature. */
    timeoutMs?: number;
}
