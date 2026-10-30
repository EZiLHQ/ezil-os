import type { StoredComputeEpoch } from '../ports';
import { buildSummaryV2 } from '../v2/summary';
import { epochSeconds, isoSeconds } from '../v2/time';
import { SIZES, type SizeCode } from '../v2/contract';
import { HOLD_SIZE } from './admission';
import { planFromSubscriptions } from './catalog';
import { hoursLeftAtWeight } from './contract';
import { deriveStanding } from './standing';
import { computePlanV3, fairUseAllowance, storageDisk, usedGiBOf, usedSecondsInWindow } from './summary';

type Input = Parameters<typeof buildSummaryV2>[0] & {
    computerId?: string;
    /** Round 5 D3: the computer's real data-volume size in GiB; null/omitted = unreadable (fallback 50). */
    volumeGiB?: number | null;
    /** Round 6: any aws-ec2 placement among the user's live computers (as billing.summary); null/omitted = none or unreadable. */
    placementProvider?: 'aws-ec2' | 'cloudflare' | null;
    /** Round 6: the Free effective date (tests); omitted = FREE_V2_EFFECTIVE_AT. */
    freeEffectiveAt?: string | null;
};

/** Read-only meter observations, not provider readiness or a live storage inventory. */
export function buildUsageV3(input: Input) {
    const plan = planFromSubscriptions(input);
    const legacy = plan.sku === 'legacy' ? buildSummaryV2(input) : null;
    // The summary's standing (round 6): the D16 hold, and (review) a dunning cancel rated as Free, with Free's
    // month, session cap and allowance as the start gate rates it; in grace the plan's fair use, as the summary.
    const { standing } = deriveStanding({ subscriptions: input.subs, paymentIssues: input.paymentIssues,
        placementProvider: input.placementProvider ?? null, now: input.now });
    const rated = computePlanV3(plan, standing, input);
    const allowance = legacy?.compute.allowanceStdSeconds ?? fairUseAllowance(rated, input.grants, { grace: standing === 'grace' });
    const used = legacy?.compute.usedStdSeconds ?? usedSecondsInWindow(input.epochs, rated.window, input.now,
        { sessionMaxSeconds: rated.sessionMaxSeconds, allowanceStdSeconds: allowance });
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
    // Round 3 D3/D8: hours left at the CURRENT configuration (the open session's size, else the
    // validated next-open choice, else the plan default), plus the same time at every allowed size.
    // Round 6 (R1-07/R1-09): under the D16 hold the computer that opens is the held AWS computer at
    // HOLD_SIZE (as billing.summary), so its disk is the AWS volume and there is no Cloudflare equivalent.
    const held = standing === 'files_on_aws';
    const choices: readonly SizeCode[] = held ? [HOLD_SIZE] : rated.sku === 'legacy' ? [rated.offer.defaultSize] : rated.offer.machineChoice;
    const preferred = input.sizePreference !== null && choices.includes(input.sizePreference) ? input.sizePreference : choices[0]!;
    const running = epoch && epoch.endedAt === null ? epoch : undefined;
    const currentSize = running?.size ?? preferred;
    const currentWeight = running?.weight ?? SIZES[currentSize].weight;
    const remaining = Math.max(0, allowance - used);
    const samples = new Map<string, Input['storage'][number]>();
    for (const sample of input.storage) {
        if (!samples.has(sample.computerId) || samples.get(sample.computerId)!.measuredAt < sample.measuredAt)
            samples.set(sample.computerId, sample);
    }
    // The computer's real volume (round 5 D3); the preferred size only decides AWS vs Free, not the figure.
    // Usage for one computer meters that computer's used space against that computer's volume (the router
    // scopes the volume the same way); without a computer, every computer's latest sample, as before.
    const scopedId = input.computerId?.toLowerCase();
    const scopedStorage = scopedId ? input.storage.filter(sample => sample.computerId.toLowerCase() === scopedId) : input.storage;
    const disk = storageDisk(rated, preferred, scopedStorage, input.config.largeStorageEnabled, input.volumeGiB);
    return {
        enabled: true as const, version: 1 as const, asOf: isoSeconds(now),
        session: { computerId: epoch?.computerId ?? input.computerId ?? null, state,
            startedAt: epoch?.readyAt ?? null, endedAt: epoch?.endedAt ?? null,
            observedAt: observed === null ? null : isoSeconds(observed),
            elapsedSeconds: ready === null || observed === null ? null : Math.max(0, (fresh && ended === null ? now : observed) - ready) },
        period: { startsAt: rated.window.start, resetsAt: rated.window.end,
            usedStandardSeconds: used, allowanceStandardSeconds: allowance,
            remainingStandardSeconds: remaining, unit: 'standard_seconds' as const,
            currentSize, currentWeight, remainingHoursAtCurrent: hoursLeftAtWeight(remaining, currentWeight),
            equivalents: choices.map(size => ({ size, weight: SIZES[size].weight, hours: hoursLeftAtWeight(remaining, SIZES[size].weight) })) },
        storage: { state: samples.size ? 'sampled' as const : 'unavailable' as const,
            // Round 3 D10 / round 5 D3: the computer's real AWS data volume; null on Free (no invented cap).
            capBytes: disk.capBytes?.toString() ?? null,
            // usedGiB: the used bytes in the cap's unit (GiB); a switch keeps the disk until a grow path exists.
            disk: { provisionedGiB: disk.provisionedGiB, usedBytes: disk.usedBytes?.toString() ?? null,
                usedGiB: usedGiBOf(disk.usedBytes), growsOnSwitch: false },
            samples: [...samples.values()].map(sample => ({ computerId: sample.computerId,
                bytes: sample.bytes.toString(), measuredAt: sample.measuredAt.toISOString() })) },
        egress: { state: 'unavailable' as const, usedBytes: null },
    };
}
