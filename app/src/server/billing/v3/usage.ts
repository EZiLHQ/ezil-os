import { storageCapBytes } from '../catalog';
import type { StoredComputeEpoch } from '../ports';
import { buildSummaryV2 } from '../v2/summary';
import { epochSeconds, isoSeconds } from '../v2/time';
import { planFromSubscriptions } from './catalog';
import { fairUseAllowance, usedSecondsInWindow } from './summary';

type Input = Parameters<typeof buildSummaryV2>[0] & { computerId?: string };

/** Read-only meter observations, not provider readiness or a live storage inventory. */
export function buildUsageV3(input: Input) {
    const plan = planFromSubscriptions(input);
    const legacy = plan.sku === 'legacy' ? buildSummaryV2(input) : null;
    const allowance = legacy?.compute.allowanceStdSeconds ?? fairUseAllowance(plan, input.grants);
    const used = legacy?.compute.usedStdSeconds ?? usedSecondsInWindow(input.epochs, plan.window, input.now,
        { sessionMaxSeconds: plan.sessionMaxSeconds, allowanceStdSeconds: allowance });
    const now = epochSeconds(input.now);
    const epoch = input.epochs.filter(e => (!input.computerId || e.computerId === input.computerId)
        && epochSeconds(e.readyAt) <= now)
        .sort((a, b) => Date.parse(b.readyAt) - Date.parse(a.readyAt))[0] as
            (Input['epochs'][number] & Partial<StoredComputeEpoch>) | undefined;
    const ready = epoch ? epochSeconds(epoch.readyAt, 'ceil') : null;
    const heartbeat = epoch?.lastHeartbeatAt ? epochSeconds(epoch.lastHeartbeatAt) : null;
    // Missing/future/stale heartbeats cannot establish that a computer is running.
    const fresh = heartbeat !== null && ready !== null && heartbeat >= ready && heartbeat <= now && now - heartbeat <= 90;
    const ended = epoch?.endedAt ? epochSeconds(epoch.endedAt) : null;
    const observed = ready === null ? null : ended !== null ? Math.max(ready, Math.min(now, ended))
        : heartbeat !== null && heartbeat >= ready && heartbeat <= now ? heartbeat : ready;
    const state = !epoch ? 'unavailable' as const : ended !== null ? 'ended' as const
        : fresh ? 'recording' as const : 'stale' as const;
    const samples = new Map<string, Input['storage'][number]>();
    for (const sample of input.storage) {
        if (!samples.has(sample.computerId) || samples.get(sample.computerId)!.measuredAt < sample.measuredAt)
            samples.set(sample.computerId, sample);
    }
    return {
        enabled: true as const, version: 1 as const, asOf: isoSeconds(now),
        session: { computerId: epoch?.computerId ?? input.computerId ?? null, state,
            startedAt: epoch?.readyAt ?? null, endedAt: epoch?.endedAt ?? null,
            observedAt: observed === null ? null : isoSeconds(observed),
            elapsedSeconds: ready === null || observed === null ? null : Math.max(0, (fresh && ended === null ? now : observed) - ready) },
        period: { startsAt: plan.window.start, resetsAt: plan.window.end,
            usedStandardSeconds: used, allowanceStandardSeconds: allowance,
            remainingStandardSeconds: Math.max(0, allowance - used), unit: 'standard_seconds' as const },
        storage: { state: samples.size ? 'sampled' as const : 'unavailable' as const,
            capBytes: storageCapBytes(plan.family === 'free' ? 'free' : 'pro', input.config.largeStorageEnabled).toString(),
            samples: [...samples.values()].map(sample => ({ computerId: sample.computerId,
                bytes: sample.bytes.toString(), measuredAt: sample.measuredAt.toISOString() })) },
        egress: { state: 'unavailable' as const, usedBytes: null },
    };
}
