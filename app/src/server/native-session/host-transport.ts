/**
 * The trusted, typed boundary between the native session BFF and a computer's private host adapter.
 *
 * This build has NO private host delivery channel, so the production default is `UNAVAILABLE_HOST_TRANSPORT`.
 * Owned task artifacts exist only through consented native auth intents (`server/native-auth/`); the plain
 * cookie create route still has no task resolver. The BFF checks both before claiming an
 * operation and reports a typed blocked answer: nothing is claimed, exchanged, minted or launched, and no
 * acknowledgement is ever invented. Tests inject explicit fixtures.
 *
 * What a real transport receives (`NativeHostDelivery`) is fixed by the server: the sealed profile id, the
 * owner-resolved sealed task, the pinned placement tuple and binding, and the short Gateway grant. There is
 * no caller URL, command, model or root. The host adapter must:
 * - independently recheck the bound computer, session, generation, lease epoch, instance, fence and lease
 *   before executing, and refuse (`placement_mismatch`) if any differs;
 * - keep the grant inside its private relay, enforcing that binding and the policy on every relayed call
 *   (the grant itself is service and subject scoped, not computer or session scoped);
 * - give the native CLI only a short local relay capability, never the grant, a service credential or a proof.
 */

/** The one native execution profile. Fixed in code; never caller-supplied. */
export const NATIVE_PROFILE_ID = 'ezil-native-claude-v1';

/**
 * A task artifact the owner's private resolver admitted. Its digest and revision must match the request, and
 * `instruction` is the exact admitted text (its UTF-8 bytes hash to `instructionDigest`). The instruction is
 * private to the owner and the host: never a receipt, URL, error or log.
 */
export interface SealedNativeTask {
    readonly taskRef: string;
    readonly instructionRevision: 1;
    readonly instructionDigest: string;
    readonly instruction: string;
}

/** Resolves a taskRef ONLY through the owner's admitted private artifacts. Null when it does not resolve. */
export interface NativeTaskResolver {
    resolve(taskRef: string, owner: { userId: string }): Promise<SealedNativeTask | null>;
}

/**
 * The finite consent a delivery runs under (the owner's approval for a create, copied unchanged into a derived
 * renewal). Strings only; times are canonical UTC with milliseconds; `epoch` and `budgetMicro` are positive
 * canonical decimals (microcredits).
 */
export interface NativeSourceAuthorization {
    readonly authorizationId: string;
    readonly epoch: string;
    readonly authorizationDeadline: string;
    readonly clientId: string;
    readonly profileId: 'ezil-native-claude-v1';
    readonly policyId: string;
    readonly budgetMicro: string;
    readonly initialApprovalAt: string;
}

export interface NativeHostDelivery {
    readonly profileId: typeof NATIVE_PROFILE_ID;
    readonly kind: 'create' | 'renew';
    readonly operationId: string;
    readonly sessionId: string;
    readonly computerId: string;
    readonly ownerUserId: string;
    /** Decimal strings: bigint counters are never narrowed. */
    readonly placement: { generation: string; leaseEpoch: string; instanceId: string; fenceToken: string };
    readonly leaseUntil: string;
    /** Present for create only; a renewal re-arms the session already running. Its digest keeps the `sha256:` prefix. */
    readonly task: SealedNativeTask | null;
    /** The consent this delivery runs under, from the trusted consent reader. Always present: no consent, no mint. */
    readonly sourceAuthorization: NativeSourceAuthorization;
    /** `tokenSha256` is SHA-256 of the full `ezg_` token, raw 64 lowercase hex (no prefix). */
    readonly grant: { readonly accessToken: string; readonly tokenSha256: string; readonly grantId: string; readonly expiresAt: string };
}

export type NativeDeliveryOutcome =
    | { kind: 'acknowledged' }
    | { kind: 'refused'; reason: 'host_unavailable' | 'host_refused' | 'placement_mismatch' }
    | { kind: 'unknown'; reason: 'host_timeout' | 'host_no_ack' };

/** Exactly what a readiness probe is asked about: the kind, the fixed profile, the owner and the full approved tuple. */
export interface NativeHostReadinessTarget {
    readonly kind: 'create' | 'renew';
    readonly profileId: typeof NATIVE_PROFILE_ID;
    readonly ownerUserId: string;
    readonly computerId: string;
    /** Decimal strings: bigint counters are never narrowed. */
    readonly placement: { readonly generation: string; readonly leaseEpoch: string; readonly instanceId: string; readonly fenceToken: string };
}

export type NativeHostReadiness = { kind: 'ready' } | { kind: 'refused' } | { kind: 'unknown' };

export interface NativeHostTransport {
    /** Whether a private delivery channel exists in this build. Checked before any claim or exchange. */
    readonly available: boolean;
    /**
     * Whether the qualified host bundle implements this kind. Checked with `available` before any proof,
     * claim, exchange or delivery: an unsupported kind is blocked with zero effects.
     */
    supportsKind(kind: 'create' | 'renew'): boolean;
    /**
     * A pure readiness probe for exactly this target (no claim, launch or side effect), asked after the structural
     * checks and before any proof, claim, outbox or exchange, under a hard deadline. Anything but `ready` (refused,
     * unknown, a rejection or the deadline) blocks the run with zero effects. Never called on a status read.
     */
    checkReadiness(target: Readonly<NativeHostReadinessTarget>, signal?: AbortSignal): Promise<NativeHostReadiness>;
    deliver(delivery: NativeHostDelivery, signal: AbortSignal): Promise<NativeDeliveryOutcome>;
}

/** The production default: truthfully unavailable for every kind. It never delivers and never acknowledges. */
export const UNAVAILABLE_HOST_TRANSPORT: NativeHostTransport = Object.freeze({
    available: false,
    supportsKind: () => false,
    checkReadiness: async (): Promise<NativeHostReadiness> => ({ kind: 'refused' }),
    deliver: async (): Promise<NativeDeliveryOutcome> => ({ kind: 'refused', reason: 'host_unavailable' }),
});
