/**
 * `Authorization: EZiL-Delegation <jws>`: the EZiL MCP connector reading one signed-in person's computers.
 *
 * Read-only receiver for exactly two procedures, `computer.list` and `computer.get`, under exactly the scope
 * `ezil:computers:read`, each as one plain GET. The MCP never forwards a user token: per call it signs a
 * short ES256 assertion naming the person (`idp_iss` + `sub`), the OAuth client, the scope, the procedure and
 * a digest of the exact input. Verification is the shared engine in `delegation-core.ts`; this wrapper owns
 * only what is specific to computer reads: the gate value, the GET binding and its fixed two-entry policy,
 * and the call shape it returns.
 *
 * Off unless `EZIL_DELEGATED_COMPUTER_READS=enabled`. Off, misconfigured or failing in any way, a presented
 * delegation is REJECTED, never ignored: the caller must not fall back to the session cookie.
 *
 * Free of `@/server/db` and `@/env`, like `bearer-auth.ts`: the replay ledger and the account lookup are
 * injected, so every refusal is unit-testable.
 */
import {
    verifyDelegation, type DelegatedAccount, type DelegationConfig, type DelegatedIdentity, type DelegationPolicy,
    type DelegationRejection,
} from './delegation-core';

export {
    DELEGATION_CLOCK_SKEW_SECONDS, DELEGATION_MAX_TTL_SECONDS, DELEGATION_SCHEME, DELEGATION_TYPE, bareHttpsOrigin,
    delegationConfig, identityIssuerOf, inputDigest, isDelegationHeader, parseDelegationConfig,
    type DelegatedAccount, type DelegatedIdentity, type DelegationConfig, type DelegationEnv, type DelegationRejection,
} from './delegation-core';

export const DELEGATED_READ_SCOPE = 'ezil:computers:read';

/** The only procedures a delegated call may reach, each a query. OS owns this list; the MCP's is not trusted. */
export const DELEGATED_READ_PROCEDURES: ReadonlySet<string> = new Set(['computer.list', 'computer.get']);

/** The fixed policy passed to the shared engine: each computer read and its one exact scope. */
const COMPUTER_READ_POLICY: DelegationPolicy = Object.freeze({
    scopeByProcedure: new Map([...DELEGATED_READ_PROCEDURES].map(procedure => [procedure, DELEGATED_READ_SCOPE] as const)),
});

/** `EZIL_DELEGATED_COMPUTER_READS=enabled` exactly; anything else is off. */
export const delegatedReadsEnabled = (value: string | undefined): boolean => value === 'enabled';

/** The request line a delegation is checked against, taken by the one route that accepts delegation. */
export interface DelegationRequest {
    method: string;
    url: string;
    /** Whether the request carries a body (stream, Content-Length > 0 or Transfer-Encoding). */
    hasBody: boolean;
}

/** What the request actually asks for. The assertion's `proc` and `inp` must name exactly this. */
export interface DelegationBinding {
    procedure: string;
    /** The single `input` query parameter, percent-decoded (`URLSearchParams.get`), or '' when absent. */
    input: string;
}

/**
 * The binding of a delegated request, or undefined unless it is exactly one plain read: GET, no body, the
 * literal path `/api/trpc/computer.list` or `/api/trpc/computer.get` (no batch, comma, trailing slash or
 * encoded character), and a query of at most one `input` parameter.
 */
export function delegationBinding(request: DelegationRequest): DelegationBinding | undefined {
    if (request.method !== 'GET' || request.hasBody) return undefined;
    let parsed: URL;
    try {
        parsed = new URL(request.url);
    } catch {
        return undefined;
    }
    const prefix = '/api/trpc/';
    if (!parsed.pathname.startsWith(prefix)) return undefined;
    const procedure = parsed.pathname.slice(prefix.length);
    if (!DELEGATED_READ_PROCEDURES.has(procedure)) return undefined;
    const keys = [...parsed.searchParams.keys()];
    if (keys.length > 1 || keys.some(key => key !== 'input')) return undefined;
    return { procedure, input: parsed.searchParams.get('input') ?? '' };
}

/** A verified, mapped delegated caller. Never contains the assertion itself. */
export interface DelegatedCall {
    jti: string;
    clientId: string;
    /** The OS account the subject mapped to. */
    userId: string;
    /** The one procedure this assertion authorizes (its `proc`, bound to the request). */
    procedure: string;
}

export type DelegationOutcome =
    | { kind: 'none' }
    | { kind: 'rejected'; reason: DelegationRejection }
    | { kind: 'accepted'; call: DelegatedCall; account: DelegatedAccount };

export interface DelegationDeps {
    enabled: boolean;
    config: DelegationConfig | undefined;
    /** The request's own procedure and input; undefined (not one plain GET read) rejects before any I/O. */
    binding: DelegationBinding | undefined;
    /** Seconds since the epoch. */
    now: () => number;
    /** Record `jti` until `expiresAt` (epoch seconds): true only for the first use. Throwing rejects. */
    consumeJti: (jti: string, expiresAt: number) => Promise<boolean>;
    /** The ONE existing, verified, not deleted/banned account for this identity, else null. */
    findAccount: (identity: DelegatedIdentity) => Promise<DelegatedAccount | null>;
}

/** Resolve a delegated computer read from the `Authorization` header. */
export async function authenticateDelegation(headers: Headers, deps: DelegationDeps): Promise<DelegationOutcome> {
    const outcome = await verifyDelegation(headers, {
        enabled: deps.enabled,
        config: deps.config,
        // The computer digest is unchanged: it covers only the exact decoded `input` string.
        binding: deps.binding && { procedure: deps.binding.procedure, serializedInput: deps.binding.input },
        policy: COMPUTER_READ_POLICY,
        now: deps.now,
        consumeJti: deps.consumeJti,
        findAccount: deps.findAccount,
    });
    if (outcome.kind !== 'accepted') return outcome;
    const { jti, clientId, userId, procedure } = outcome.caller;
    return { kind: 'accepted', call: { jti, clientId, userId, procedure }, account: outcome.account };
}
