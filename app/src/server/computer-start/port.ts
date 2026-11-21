/**
 * The real collaborators of `computer.start` (`./start.ts`): the same routing, billing gate, providers and meter the
 * open path (`cloudflareGuacamole.previewUrl`) uses, minus everything that is about being opened: no shell session,
 * no `last_opened_at`, no reverse-move trigger, no credential push, no frame probe and no URL of any kind.
 *
 * `running` means the provider answered ready (and the meter was told), not that a browser frame was confirmed.
 * A delegated start carries no browser cookie. The owner's configured editor bridge handles its own authorization.
 */
import { ownsComputer } from '@/server/agent-session/control-store';
import type { SqlExecutor } from '@/server/agent-session/store';
import { getBillingDeps } from '@/server/billing/deps';
import { gateComputerStart } from '@/server/billing/v2/compute-access';
import { billingComputeMeter } from '@/server/billing/v2/compute-meter';
import { recordComputeMeter } from '@/server/billing/v2/compute-meter-observation';
import { cloudflareMigrationAnswer, routeComputer, type RoutedComputer } from '@/server/api/routers/compute-dispatch';
import { newCorrelationId, resolveCloudflareGuacamoleConfig } from '@/server/lib/cloudflare-guacamole-provider';
import { prepareAwsPoolSession } from '@/server/lib/compute/aws-preview';
import { isPlacementReadEnabled } from '@/server/lib/compute/aws-config';
import type { PlacementDb } from '@/server/lib/compute/placement';
import type { ComputerRef, EnsureOptions } from '@/server/lib/compute/provider';
import { stopComputerForPolicy } from '@/server/lib/compute/stop-policy';

import type { BootOutcome, StartPort, StartRoute } from './start';

type Db = Parameters<typeof routeComputer>[0];

export function startPort(db: Db, computer: ComputerRef): StartPort {
    let routed: RoutedComputer | undefined;
    const current = () => {
        if (!routed) throw new Error('computer.start: boot before route');
        return routed;
    };
    const describe = (value: RoutedComputer): StartRoute => ({
        kind: value.kind, instanceType: value.kind === 'aws-ec2' ? value.instanceType : null,
        moving: value.kind === 'aws-ec2' && !!value.reverse,
    });
    return {
        async route(pin) {
            if (!isPlacementReadEnabled()) {
                routed = undefined;
                throw new Error('computer.start requires placement reads');
            }
            routed = await routeComputer(db, computer, { pinCloudflare: pin });
            return describe(routed);
        },
        async gate(route) {
            const deps = getBillingDeps();
            const gate = await gateComputerStart({ deps, ...computer, kind: route.kind, instanceType: route.instanceType, now: deps.now() });
            return gate.allowed ? { allowed: true } : { allowed: false, reason: gate.reason };
        },
        async boot(): Promise<BootOutcome> {
            const target = current();
            const config = resolveCloudflareGuacamoleConfig();
            const hmacSecret = process.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET?.trim() ?? '';
            if (!config.isConfigured) return { state: 'failed', reason: 'not_configured' };
            const correlationId = newCorrelationId();
            // The computer id doubles as the session id, as the reverse-move answer does: this is not a shell session.
            const options: EnsureOptions = { sessionId: computer.computerId, desktopMode: 'neko' };
            if (target.kind === 'aws-ec2') {
                const result = await target.provider.ensure({ correlationId }, computer, options);
                if (result.ok) return { state: 'running' };
                if (result.errorCode === 'computer_starting' && result.retryable) {
                    // The host reaches session-ready only after the relay exchange the open path primes: prime it here too.
                    await prepareAwsPoolSession(db as unknown as PlacementDb, computer, options, config, hmacSecret, correlationId).catch(() => {});
                    return { state: 'starting' };
                }
                return { state: 'failed', reason: result.errorCode };
            }
            const result = await target.provider.ensure({ correlationId }, computer, options, 'complete');
            if (cloudflareMigrationAnswer(result)) return { state: 'failed', reason: 'computer_migrating' };
            if (!result.ok) {
                // The Worker can time out its readiness wait after the DO already accepted the boot.
                if (result.retryable && ['sandbox_starting', 'sandbox_start_failed', 'worker_http_error', 'timeout', 'fetch_failed'].includes(result.errorCode)) {
                    return { state: 'starting' };
                }
                return { state: 'failed', reason: result.errorCode };
            }
            return result.guacamoleUrl || result.appPreviewUrl || result.codePreviewUrl ? { state: 'running' } : { state: 'starting' };
        },
        recordReady: () => recordCloudflareReady(db, computer),
    };
}

async function recordCloudflareReady(db: Db, computer: ComputerRef): Promise<BootOutcome> {
    // The provider could have taken minutes. Check the live owner again before recording readiness.
    if (!await ownsComputer(db as SqlExecutor, computer.userId, computer.computerId)) return { state: 'failed', reason: 'computer_unavailable' };
    const billing = getBillingDeps();
    const metered = await recordComputeMeter(() => billingComputeMeter(() => billing).ready({
        ...computer, size: 'free-cf', readyAt: new Date(), overheadSeconds: 0,
    }));
    if (metered === 'concurrent' && billing.config.enforcementEnabled) {
        await stopComputerForPolicy(db as unknown as PlacementDb, computer, 'user_stop', {
            correlationId: newCorrelationId(),
            route: async (database, candidate) => {
                const target = await routeComputer(database, candidate, { pinCloudflare: false });
                if (target.kind !== 'cloudflare') throw new Error('computer.start: placement changed before policy stop');
                return target;
            },
        });
        return { state: 'failed', reason: 'billing_concurrent_limit' };
    }
    return { state: 'running' };
}

/** Reconcile an admitted start without a second ensure, placement write or allowance decision. */
export async function observeCloudflareStart(db: Db, computer: ComputerRef): Promise<BootOutcome> {
    if (!isPlacementReadEnabled()) return { state: 'starting' };
    const target = await routeComputer(db, computer, { pinCloudflare: false });
    if (target.kind !== 'cloudflare') return { state: 'failed', reason: 'route_changed' };
    const status = await target.provider.status({ correlationId: newCorrelationId() }, computer);
    return status.ok && status.guacamoleRunning === true ? recordCloudflareReady(db, computer) : { state: 'starting' };
}
