export const usage = {
    enabled: true, version: 1, asOf: '2026-10-26T05:00:00Z',
    session: { computerId: 'computer-a', state: 'recording', startedAt: '2026-10-26T03:30:00Z', observedAt: '2026-10-26T05:00:00Z', elapsedSeconds: 5400, endedAt: null },
    period: { unit: 'standard_seconds', startsAt: '2026-10-01T00:00:00Z', resetsAt: '2026-11-01T00:00:00Z', usedStandardSeconds: 86400, allowanceStandardSeconds: 144000, remainingStandardSeconds: 57600 },
    storage: { state: 'sampled', capBytes: '2000000000', samples: [{ computerId: 'computer-a', bytes: '1200000000', measuredAt: '2026-10-25T00:00:00Z' }] },
    egress: { state: 'unavailable', usedBytes: null },
};
export const summary = {
    enabled: true, version: 3,
    plan: { sku: 'standard_monthly_v3', name: 'Standard', status: 'active', renewal: { at: '2026-11-01T00:00:00Z', amountCents: 2000 }, cancelsAt: null, scheduledChange: null, pendingUpgrade: null, paymentIssue: null },
    computer: { size: 'std-2', vcpu: 2, memoryGiB: 8, sessionMaxSeconds: null, opening: 'standard', activeDeadline: '2026-10-26T06:40:00Z', machineChoice: [{ size: 'std-2', vcpu: 2, memoryGiB: 8, weight: 1, arch: 'x86_64' }] },
    ai: { grant: { amount: 200, per: 'period' }, balance: 120, state: 'ok' },
    fairUse: { status: 'ok', resetsAt: '2026-11-01T00:00:00Z' },
    storage: { usedBytes: '1200000000', capBytes: '2000000000', state: 'ok' },
    actions: { checkout: false, topup: true, upgrade: true, downgrade: false, cancel: true, portal: true },
    catalog: { version: 3, offers: [], packs: [{ sku: 'ai_pack_100_v2', aiCredits: 1000, creditCents: 10000, discountPercent: 20, totalCents: 8000, currency: 'usd' }], customTopup: { minCents: 1000, maxCents: 1000000, centsPerCredit: 10 } },
};
