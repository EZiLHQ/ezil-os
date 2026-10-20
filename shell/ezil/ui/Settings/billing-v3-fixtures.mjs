// Wire-data fakes: intentionally contain no v2 meters, sizes or plan-family fields.
const machines = [
    { size: 'std-2', vcpu: 2, memoryGiB: 8, weight: 1, arch: 'x86_64' },
    { size: 'cmp-4', vcpu: 4, memoryGiB: 16, weight: 2, arch: 'x86_64' },
    { size: 'cmp-8', vcpu: 8, memoryGiB: 32, weight: 4, arch: 'x86_64' },
];
const offers = [
    { sku: 'free_v3', name: 'Free', tagline: 'Try EZiL OS and build small projects.', priceCents: 0, vcpu: 2, memoryGiB: 6, sessionMaxSeconds: 3600, opening: 'standard', fairUseHours: 5, highlighted: false, badge: null, machineChoice: ['free-cf'], bullets: ['A real desktop in your browser', 'VS Code and a browser built in', '2 vCPU · 6 GB computer', 'Sessions up to 1 hour'] },
    { sku: 'standard_monthly_v3', name: 'Standard', tagline: 'For regular work, every day.', priceCents: 2000, vcpu: 2, memoryGiB: 8, sessionMaxSeconds: 7200, opening: 'standard', fairUseHours: 40, highlighted: false, badge: null, machineChoice: ['std-2'], bullets: ['Your own 2 vCPU · 8 GB computer in Mumbai', 'Sessions up to 2 hours'] },
    { sku: 'premium_monthly_v3', name: 'Premium', tagline: 'For heavy builds and long sessions.', priceCents: 10000, vcpu: 2, memoryGiB: 8, sessionMaxSeconds: 21600, opening: 'standard', fairUseHours: 500, highlighted: true, badge: null, machineChoice: ['std-2', 'cmp-4', 'cmp-8'], bullets: ['Choose 2, 4 or 8 vCPU (8, 16 or 32 GB) in Mumbai', 'Sessions up to 6 hours', 'Bigger computers use your monthly time faster'] },
];
export function summaryV3(tier = 'standard') {
    const offer = offers.find(offer => offer.sku.startsWith(`${tier}_`));
    const free = tier === 'free';
    return structuredClone({
        enabled: true, version: 3,
        plan: { sku: offer.sku, name: offer.name, status: free ? 'free' : 'active', renewal: free ? null : { at: '2026-11-01T00:00:00Z', amountCents: offer.priceCents }, cancelsAt: null, scheduledChange: null, pendingUpgrade: null, paymentIssue: null },
        computer: { size: offer.machineChoice[0], machineChoice: free ? [{ size: 'free-cf', vcpu: 2, memoryGiB: 6, weight: 1, arch: 'x86_64' }] : machines.filter(machine => offer.machineChoice.includes(machine.size)), vcpu: offer.vcpu, memoryGiB: offer.memoryGiB, sessionMaxSeconds: offer.sessionMaxSeconds, opening: offer.opening, activeDeadline: null },
        fairUse: { status: 'ok', resetsAt: '2026-11-01T00:00:00Z' },
        storage: { usedBytes: '100', capBytes: '2000000000', state: 'ok' },
        actions: { checkout: free, upgrade: tier === 'standard', downgrade: tier === 'premium', cancel: !free, portal: !free },
        catalog: { version: 3, offers },
    });
}
