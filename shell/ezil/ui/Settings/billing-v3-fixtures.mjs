// Wire-data fakes: intentionally contain no v2 meters, sizes or plan-family fields.
const offers = [
    { sku: 'free_v3', name: 'Free', tagline: 'Try EZiL OS and build small projects.', priceCents: 0, vcpu: 2, memoryGiB: 6, sessionMaxSeconds: 3600, opening: 'standard', fairUseHours: 5, highlighted: false, badge: null, bullets: ['A real desktop in your browser', 'VS Code and a browser built in', 'Sessions up to 1 hour'] },
    { sku: 'standard_monthly_v3', name: 'Standard', tagline: 'For regular work, every day.', priceCents: 2000, vcpu: 2, memoryGiB: 8, sessionMaxSeconds: 7200, opening: 'fast', fairUseHours: 40, highlighted: false, badge: null, bullets: ['Opens from a ready computer', 'Sessions up to 2 hours', '2 vCPU · 8 GB computer'] },
    { sku: 'premium_monthly_v3', name: 'Premium', tagline: 'For heavy builds and long sessions.', priceCents: 4000, vcpu: 4, memoryGiB: 16, sessionMaxSeconds: 21600, opening: 'fastest', fairUseHours: 80, highlighted: true, badge: 'Most popular', bullets: ['Opens first from a ready computer', 'Sessions up to 6 hours', '4 vCPU · 16 GB computer'] },
];
export function summaryV3(tier = 'standard') {
    const offer = offers.find(offer => offer.sku.startsWith(`${tier}_`));
    const free = tier === 'free';
    return structuredClone({
        enabled: true, version: 3,
        plan: { sku: offer.sku, name: offer.name, status: free ? 'free' : 'active', renewal: free ? null : { at: '2026-11-01T00:00:00Z', amountCents: offer.priceCents }, cancelsAt: null, scheduledChange: null, pendingUpgrade: null, paymentIssue: null },
        computer: { vcpu: offer.vcpu, memoryGiB: offer.memoryGiB, sessionMaxSeconds: offer.sessionMaxSeconds, opening: offer.opening, activeDeadline: null },
        fairUse: { status: 'ok', resetsAt: '2026-11-01T00:00:00Z' },
        storage: { usedBytes: '100', capBytes: '2000000000', state: 'ok' },
        actions: { checkout: free, upgrade: tier === 'standard', downgrade: tier === 'premium', cancel: !free, portal: !free },
        catalog: { version: 3, offers },
    });
}
