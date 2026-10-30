/**
 * ComputeProvider — the lifecycle seam between the app and whatever runs a
 * computer (docs/AWS-COMPUTERS.md, contract C-1).
 *
 * Lifecycle members ONLY. Desktop-control calls (focus, screen, relay refresh)
 * are not here: they stay Worker endpoints, and the Worker routes them per
 * placement.
 *
 * 🔴 NO HOSTNAMES, TOKENS, ZONES OR BUCKETS IN THIS FILE, and no import of any
 * provider module. Same non-goals as `SandboxHost` in
 * `local/src/host/sandbox-host.ts`: this is the shape a caller programs
 * against, and the configuration that makes one provider work belongs to that
 * provider's adapter (`./cloudflare.ts`).
 *
 * The result types are deliberately the NARROWEST shape every provider can
 * honestly answer with. An adapter may return a richer subtype — the
 * Cloudflare adapter returns the Worker's own result objects unchanged, which
 * is what keeps P1 a no-behaviour-change refactor — and `select.ts` returns
 * the concrete adapter type so existing callers keep reading the fields they
 * read today.
 */

export type ProviderKind = 'cloudflare' | 'aws-ec2';

/** Per-call context. Carries no secrets and no provider configuration. */
export interface ComputeCtx {
    /** Propagated to the provider as its correlation id (`x-correlation-id`). */
    correlationId: string;
}

/** Which computer. Always an ownership-checked pair, never a client-supplied name. */
export interface ComputerRef {
    userId: string;
    computerId: string;
}

/**
 * Inputs to `ensure` that are about the SESSION, not the computer.
 *
 * Not in C-1's signature as written; C-1 needs this third parameter (or the
 * equivalent on `ComputeCtx`) because the Cloudflare preview call carries the
 * shell session id and the requested boot screen.
 */
export interface EnsureOptions {
    sessionId: string;
    desktopMode: 'neko';
    /** Omitted, never defaulted, when nothing usable was requested. */
    screen?: { width: number; height: number };
}

/**
 * `ensure` answers ready, or not-ready with a reason. "Starting" is a
 * not-ready answer whose `retryable` is true (Cloudflare: `sandbox_starting`).
 */
export type EnsureResult =
    | { ok: true }
    | { ok: false; error: string; errorCode: string; retryable: boolean; computeLaunching?: boolean;
        /** `capacity_attempt_expired` only: the expired attempt an explicit user Retry may reset (RETRY-118). */
        capacityAttemptId?: string };

export interface ComputeStatus {
    ok: boolean;
    /** A fresh replacement instance is still starting, independently of migration. */
    computeLaunching?: boolean;
    error?: string;
}

/** Evidence that a human is present. */
export interface ActivitySignal {
    lastInputAgoMs: number;
}

export interface ActivityResult {
    ok: boolean;
    error?: string;
}

export interface RestartResult {
    ok: boolean;
    outcome?: string;
    error?: string;
}

/** Why a computer is being stopped. Only the reaper path exists today. */
export type StopReason = 'idle_reap' | 'user' | 'cap' | 'lease_expired';

/**
 * `ok` is true ONLY when the provider confirmed the computer is no longer
 * running. A resolved promise is not a confirmation.
 */
export interface StopResult {
    ok: boolean;
    /** True only when something running was actually stopped by this call. */
    terminated: boolean;
    outcome?: string;
    error?: string;
}

/** Same confirmation rule as `StopResult`. aws-ec2: retire, keep the volume. */
export type TerminateResult = StopResult;

export interface ComputeProvider {
    readonly kind: ProviderKind;
    ensure(ctx: ComputeCtx, c: ComputerRef, opts: EnsureOptions): Promise<EnsureResult>;
    /** Authenticated on every provider except Cloudflare today (see the adapter). */
    status(ctx: ComputeCtx, c: ComputerRef): Promise<ComputeStatus>;
    activity(ctx: ComputeCtx, c: ComputerRef, s: ActivitySignal): Promise<ActivityResult>;
    restart(ctx: ComputeCtx, c: ComputerRef): Promise<RestartResult>;
    stop(ctx: ComputeCtx, c: ComputerRef, reason: StopReason): Promise<StopResult>;
    terminate(ctx: ComputeCtx, c: ComputerRef): Promise<TerminateResult>;
    // persistenceStatus(ctx, c): lands when PR #195 (`requestPersistenceStatus`)
    // is on main — see docs/AWS-COMPUTERS.md C-1.
}
