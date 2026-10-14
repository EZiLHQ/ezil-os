/**
 * P3 per-computer dispatch: which provider runs THIS computer
 * (docs/AWS-COMPUTERS.md C-1, R13 — chosen per computer, never by a global flip).
 *
 * Every lifecycle call in the routers goes through `routeComputer`. It is the
 * ONLY router-side module that names `selectComputeProvider` /
 * `resolveComputeProvider` (pinned by `no-direct-lifecycle-calls.test.ts`), so
 * no router path can bypass a computer's placement.
 *
 * 🔴 CLOUDFLARE STAYS BYTE-IDENTICAL. With placement reads off
 * (`EZIL_COMPUTE_PLACEMENT_READS` and `EZIL_AWS_COMPUTERS_ENABLED` unset — the
 * production default until the founder registers the placement SQL) this does
 * NOT touch the database and returns exactly what `selectComputeProvider`
 * returned before P3. With reads on, a computer with no placement row, or a
 * `cloudflare` row, gets that same Cloudflare adapter instance.
 *
 * A placement owned by someone else is NOT_FOUND — the same anti-enumeration
 * answer `assertOwnedComputer` gives — and it is raised BEFORE any provider is
 * returned, so no provider call can happen for a foreign computer.
 */

import { TRPCError } from '@trpc/server';

import { isAwsComputersEnabled, isPlacementReadEnabled, type Env } from '@/server/lib/compute/aws-config';
import { sharedAwsSdkCollaborators } from '@/server/lib/compute/aws-clients';
import { workerTunnelClientFromEnv } from '@/server/lib/compute/aws-enroll';
import type { CloudflareComputeProvider } from '@/server/lib/compute/cloudflare';
import { PlacementOwnerError, type PlacementExecutor } from '@/server/lib/compute/placement';
import type { AwsComputeStatus, AwsProviderDeps } from '@/server/lib/compute/aws-ec2';
import type { ComputeProvider, ComputeStatus, ComputerRef, EnsureResult } from '@/server/lib/compute/provider';
import { resolveComputeProvider, selectComputeProvider } from '@/server/lib/compute/select';
import { resolveTier, type EntitlementReader } from '@/server/lib/compute/tier';

export type RoutedComputer =
    | { kind: 'cloudflare'; provider: CloudflareComputeProvider }
    | { kind: 'aws-ec2'; provider: ComputeProvider };

/**
 * The AWS provider's runtime collaborators: the Step Functions starter and
 * execution reader (aws-clients.ts: Vercel OIDC → the region's app-caller
 * role, no stored keys) and the GW-1 tunnel client (the Worker). With the AWS
 * flag off nothing is built. With it on but the caller unconfigured (any
 * region without its role), there is no starter, so an AWS computer's
 * `ensure`/`stop` refuse BEFORE any write (`aws_lifecycle_unconfigured`) —
 * never Cloudflare. This is the ONE place the routers get them from.
 */
export function defaultAwsCollaborators(env: Env = process.env): Pick<AwsProviderDeps, 'starter' | 'executions' | 'tunnels'> {
    if (!isAwsComputersEnabled(env)) return {};
    const { starter, executions } = sharedAwsSdkCollaborators(env);
    const tunnels = workerTunnelClientFromEnv(env) ?? undefined;
    return { ...(starter ? { starter } : {}), ...(executions ? { executions } : {}), ...(tunnels ? { tunnels } : {}) };
}

export interface RouteOptions {
    env?: Env;
    /** Where a user's paid entitlement is read from. None in this app today → every AWS computer is `free`. */
    entitlements?: EntitlementReader;
    /** Overrides `defaultAwsCollaborators(env)` (tests). */
    aws?: Pick<AwsProviderDeps, 'starter' | 'executions' | 'tunnels' | 'randomBytes' | 'now' | 'newId' | 'leaseSeconds'>;
}

/** The AWS provider deps the routers supply: the collaborators plus the tier source. */
export function awsDepsFor(env: Env, entitlements: EntitlementReader | undefined, aws: RouteOptions['aws'] = {}) {
    return {
        ...aws,
        // The size this user's computer gets: `free` unless a paid entitlement proves `plus`.
        tierFor: (userId: string) => resolveTier(userId, entitlements, env),
    };
}

export async function routeComputer(
    db: unknown,
    computer: ComputerRef,
    { env = process.env, entitlements, aws = defaultAwsCollaborators(env) }: RouteOptions = {},
): Promise<RoutedComputer> {
    // Flag off: no database read at all — the pre-P3 call, unchanged.
    if (!isPlacementReadEnabled(env)) return { kind: 'cloudflare', provider: selectComputeProvider(computer) };
    let provider: ComputeProvider;
    try {
        provider = await resolveComputeProvider(db as PlacementExecutor, computer, env, awsDepsFor(env, entitlements, aws));
    } catch (err) {
        if (err instanceof PlacementOwnerError) {
            // NOT_FOUND, never FORBIDDEN — a foreign computer must look absent.
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Computer not found' });
        }
        throw err; // duplicate/unknown placement, missing table: fail closed, never Cloudflare.
    }
    // A cloudflare placement keeps the exact pre-P3 adapter (and its richer result type).
    if (provider.kind === 'cloudflare') return { kind: 'cloudflare', provider: selectComputeProvider(computer) };
    return { kind: 'aws-ec2', provider };
}

/**
 * AWS answers the shell must read as "still waking": a cold boot takes minutes,
 * and the shell's wake loop (`shell/ezil/session.js` `withWakeAndOneRetry`)
 * re-asks on `sandbox_starting` for up to its wake deadline while showing
 * "Waking your machine". Mapping to that EXISTING code is what gives an AWS
 * cold boot a visible state without a shell change.
 */
const AWS_WAKING_CODES: ReadonlySet<string> = new Set(['computer_starting', 'computer_stopping']);

/** The shell-facing error code for a not-ready AWS `ensure`. */
export function shellCodeForAwsEnsure(result: Extract<EnsureResult, { ok: false }>): string {
    return result.retryable && AWS_WAKING_CODES.has(result.errorCode) ? 'sandbox_starting' : result.errorCode;
}

/**
 * The preview answer for an AWS computer. Not-ready → a VALUE (never a throw:
 * a thrown error is what TanStack retries, and the wake loop already re-asks).
 * Ready → still a refusal: the AWS desktop URL is minted through the Worker's
 * AWS routing (GATEWAY-CONTRACT-v1 GW-4), which this lane does not build.
 */
export function awsPreviewAnswer(result: EnsureResult) {
    if (!result.ok) {
        return {
            ok: false as const,
            error: result.errorCode,
            errorCode: shellCodeForAwsEnsure(result),
            provider: 'cloudflare-guacamole' as const,
            computeProvider: 'aws-ec2' as const,
        };
    }
    return {
        ok: false as const,
        error: 'aws_desktop_url_unavailable',
        errorCode: 'aws_desktop_url_unavailable',
        provider: 'cloudflare-guacamole' as const,
        computeProvider: 'aws-ec2' as const,
    };
}

/**
 * The status answer for an AWS computer, in the shape the desktop canvas already
 * polls: `guacamoleRunning` is its "the machine is up" mid-boot signal, which for
 * AWS means the lifecycle reports `running`. The lifecycle `state`
 * (`starting`/`running`/`stopping`/`stopped`/`error`) is passed through as well.
 */
export function awsStatusAnswer(status: ComputeStatus) {
    const state = (status as AwsComputeStatus).state;
    return { ...status, guacamoleRunning: status.ok === true && state === 'running', computeProvider: 'aws-ec2' as const };
}
