import { confirmAwsStop, routeComputer } from '@/server/api/routers/compute-dispatch';
import { newCorrelationId } from '@/server/lib/cloudflare-guacamole-provider';
import type { ComputerRef, ProviderKind, StopResult } from './provider';

export type PolicyStopReason = 'user_stop' | 'session_max' | 'allowance_exhausted' | 'overage_cap';
export interface StopOutcome {
    kind: ProviderKind;
    result: StopResult;
}

/** Stop a session while preserving its workspace. The caller records the billing reason. */
export async function stopComputerForPolicy(
    db: unknown,
    computer: ComputerRef,
    reason: PolicyStopReason,
    opts: { confirm?: boolean; correlationId?: string; route?: typeof routeComputer } = {},
): Promise<StopOutcome> {
    const routed = await (opts.route ?? routeComputer)(db, computer);
    const ctx = { correlationId: opts.correlationId ?? `${reason}:${newCorrelationId()}` };
    // AWS terminate retires the computer; session stops must retain both disks.
    const result = routed.kind === 'aws-ec2'
        ? opts.confirm
            ? await confirmAwsStop(routed.provider, ctx, computer)
            : await routed.provider.stop(ctx, computer, 'user')
        : await routed.provider.terminate(ctx, computer);
    return { kind: routed.kind, result };
}
