// Wire-data fakes: intentionally contain no v2 meters, sizes or plan-family fields.
const machines = [
    { size: 'std-2', vcpu: 2, memoryGiB: 8, weight: 1, arch: 'x86_64', diskGiB: null },
    { size: 'cmp-4', vcpu: 4, memoryGiB: 16, weight: 2, arch: 'x86_64', diskGiB: null },
    { size: 'cmp-8', vcpu: 8, memoryGiB: 32, weight: 4, arch: 'x86_64', diskGiB: null },
];
const offers = [
    { sku: 'free_v3', name: 'Free', tagline: 'Try EZiL OS and build small projects.', priceCents: 0, vcpu: 2, memoryGiB: 6, sessionMaxSeconds: 3600, opening: 'standard', fairUseHours: 5, highlighted: false, badge: null, machineChoice: ['free-cf'], aiCredits: { amount: 100, per: 'once' }, bullets: ['A real desktop in your browser', 'VS Code and a browser built in', '2 vCPU · 6 GB computer'], storageGiB: null },
    { sku: 'standard_monthly_v3', name: 'Standard', tagline: 'For regular work, every day.', priceCents: 2000, vcpu: 2, memoryGiB: 8, sessionMaxSeconds: 21600, opening: 'standard', fairUseHours: 40, highlighted: false, badge: null, machineChoice: ['std-2'], aiCredits: { amount: 200, per: 'period' }, bullets: ['Your own 2 vCPU · 8 GB computer on AWS (India)', '50 GB disk for your projects', 'Your files are kept'], storageGiB: 50 },
    { sku: 'premium_monthly_v3', name: 'Premium', tagline: 'For bigger projects.', priceCents: 10000, vcpu: 2, memoryGiB: 8, sessionMaxSeconds: 21600, opening: 'standard', fairUseHours: 500, highlighted: true, badge: null, machineChoice: ['std-2', 'cmp-4', 'cmp-8'], aiCredits: { amount: 1000, per: 'period' }, bullets: ['Choose 2, 4 or 8 vCPU (8, 16 or 32 GB) on AWS (India)', '100 GB disk for your projects', 'Your files are kept'], storageGiB: 100 },
];
export function summaryV3(tier = 'standard') {
    const offer = offers.find(offer => offer.sku.startsWith(`${tier}_`));
    const free = tier === 'free';
    return structuredClone({
        enabled: true, version: 3,
        plan: { sku: offer.sku, name: offer.name, status: free ? 'free' : 'active', renewal: free ? null : { at: '2026-11-01T00:00:00Z', amountCents: offer.priceCents }, cancelsAt: null, scheduledChange: null, pendingUpgrade: null, paymentIssue: null },
        computer: { size: offer.machineChoice[0], machineChoice: free ? [{ size: 'free-cf', vcpu: 2, memoryGiB: 6, weight: 1, arch: 'x86_64', diskGiB: null }] : machines.filter(machine => offer.machineChoice.includes(machine.size)), vcpu: offer.vcpu, memoryGiB: offer.memoryGiB, sessionMaxSeconds: offer.sessionMaxSeconds, opening: offer.opening, activeDeadline: null },
        ai: { grant: offer.aiCredits, enrollment: 'enrolled', waiting: null, balance: 1.000001, balanceMicro: '1000001', heldMicro: '1', state: 'low', balanceState: 'low',
            spendingState: 'available', usageState: 'available', limitsState: 'available',
            recentUsage: { limit: 20, before: null, rows: [{ at: '2026-10-18T12:00:00Z', status: 'pending', heldMicro: '1', chargedMicro: null }] },
            limits: { policy: { rpm: 20, concurrency: 2, dailyBudgetMicro: '100000000', monthlyBudgetMicro: null },
                ceilings: { rpm: 30, concurrency: 4 }, counters: { inflight: 1, pending: 1, dayMicro: '2000001', monthMicro: '3000001' }, pauses: [] } },
        fairUse: { status: 'ok', resetsAt: '2026-11-01T00:00:00Z' },
        storage: { usedBytes: '100', capBytes: '2000000000', state: 'ok' },
        actions: { checkout: free, upgrade: tier === 'standard', downgrade: tier === 'premium', cancel: !free, portal: !free, ezilId: null },
        catalog: { version: 3, offers },
    });
}
/**
 * Standard trial (request standard-trial-01b28d18-20261105-v1), in the combinations the server sends
 * (app/src/server/billing/v3/summary.ts `trialBlock`, standing.ts):
 *   'offer'          Free, `trialOffer.eligible` with the server's preview of the end;
 *   'ineligible'     Free, `trialOffer.eligible: false` with `reason`;
 *   'trialing'       status active, standing paid, no upgrade; the renewal preview (`plan.renewal.at`) is about one
 *                    hour AFTER the end (Stripe collects the first charge then), never a second charge;
 *   'ending'         cancelled in the trial: status cancels, cancelsAt/planEndsAt = the end, standing plan_ending;
 *   'payment_pending' the free month ended and Stripe has not collected the first charge yet: status still active,
 *                    no payment issue, standing free (or `standing`), fairUse without the paid 'unmetered' policy;
 *   'payment_failed' the first charge failed: past_due + payment_failed, NO grace (graceEndsAt null), standing
 *                    files_on_aws (or `standing`), no cancel, no checkout.
 * After the free month (payment_pending, payment_failed) the server rates the computer as Free (summary.ts
 * computePlanV3 with the standing): Free's session cap and machine choice; standing free is the Cloudflare computer
 * with no disk figure, files_on_aws the held AWS computer at HOLD_SIZE (std-2) with its own disk.
 */
const HOUR = 3600 * 1000;
function ratedAsFree (s, standing) {
    const free = summaryV3('free').computer;
    s.computer = standing === 'files_on_aws'
        ? { ...s.computer, size: 'std-2', vcpu: 2, memoryGiB: 8, sessionMaxSeconds: free.sessionMaxSeconds, machineChoice: free.machineChoice, standing, filesOn: 'aws' }
        : { ...free, standing, filesOn: 'cloudflare', disk: { provisionedGiB: null, usedBytes: null, growsOnSwitch: false } };
}
export const TRIAL_END = '2026-12-05T14:30:00Z';
export function trialSummaryV3(state, { endsAt = TRIAL_END, reason = 'trial_used', standing } = {}) {
    if ( state === 'offer' || state === 'ineligible' ) {
        const s = summaryV3('free');
        Object.assign(s.computer, { standing: standing ?? 'free', filesOn: 'cloudflare', disk: { provisionedGiB: null, usedBytes: null, growsOnSwitch: false } });
        s.trialOffer = state === 'offer' ? { eligible: true, sku: 'standard_monthly_v3', endsAt, amountCents: 2000, currency: 'usd' } : { eligible: false, reason };
        return s;
    }
    const s = summaryV3('standard');
    s.plan.trial = { state, startedAt: '2026-11-05T14:30:00Z', endsAt, firstChargeAt: state === 'ending' ? null : endsAt, amountCents: 2000, currency: 'usd' };
    const collected = new Date(Date.parse(endsAt) + HOUR).toISOString().replace('.000Z', 'Z');
    Object.assign(s.plan, { renewal: { at: collected, amountCents: 2000 }, graceEndsAt: null, planEndsAt: null });
    Object.assign(s.computer, { standing: 'paid', filesOn: 'aws', disk: { provisionedGiB: 50, usedBytes: null, growsOnSwitch: false } });
    s.actions.upgrade = false;
    if ( state === 'ending' ) {
        Object.assign(s.plan, { status: 'cancels', cancelsAt: endsAt, planEndsAt: endsAt, renewal: null });
        s.computer.standing = 'plan_ending';
    }
    if ( state === 'payment_pending' ) {
        ratedAsFree(s, standing ?? 'free');
        s.fairUse = { status: 'ok', resetsAt: s.fairUse.resetsAt };
        // The server keeps cancelAtPeriodEnd here (status active): it stops later renewals, never the first payment.
        Object.assign(s.actions, { checkout: false, downgrade: false });
    }
    if ( state === 'payment_failed' ) {
        Object.assign(s.plan, { status: 'past_due', paymentIssue: 'payment_failed', renewal: null });
        ratedAsFree(s, standing ?? 'files_on_aws');
        Object.assign(s.actions, { cancel: false, checkout: false, downgrade: false });
    }
    return s;
}
