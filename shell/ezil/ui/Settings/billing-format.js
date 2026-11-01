// Shared billing v2 presentation. No provider or application dependencies.
export function dollars (value, { compact = false } = {}) {
    const cents = BigInt(value);
    const amount = cents < 0n ? -cents : cents;
    return `${cents < 0n ? '-' : ''}$${amount / 100n}${compact && amount % 100n === 0n ? '' : `.${String(amount % 100n).padStart(2, '0')}`}`;
}

export function dateLabel (iso, year = false) {
    const time = Date.parse(iso ?? '');
    return Number.isFinite(time)
        ? new Date(time).toLocaleDateString('en-US', { ...(year ? { year: 'numeric' } : {}), month: 'short', day: 'numeric', timeZone: 'UTC' })
        : '—';
}

export function dateTimeLabel (iso) {
    const time = Date.parse(iso ?? '');
    if ( ! Number.isFinite(time) ) return '—';
    return `${dateLabel(iso, true)} at ${new Date(time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })} UTC`;
}

export function durationLabel (seconds) {
    const minutes = Math.floor(Math.max(0, seconds) / 60);
    const hours = Math.floor(minutes / 60);
    return hours ? `${hours} h${minutes % 60 ? ` ${minutes % 60} m` : ''}` : `${minutes} m`;
}

export function stdHoursLabel (seconds, { round = 'down' } = {}) {
    const tenths = (round === 'up' ? Math.ceil : Math.floor)(Math.max(0, seconds) / 360);
    return String(tenths / 10);
}

export function sizeLabel (size) {
    return `${size.vcpu} vCPU · ${size.memoryGiB} GiB`;
}

export function planName (family) {
    return { free: 'EZiL Free', standard: 'EZiL Standard', compute: 'EZiL Compute', pro_legacy: 'EZiL Pro' }[family];
}

const ERRORS = {
    billing_not_configured: "Billing isn't available right now. Try again later.",
    unknown_sku: "That plan isn't available. Refresh and try again.",
    already_subscribed: 'You already have a plan. Refresh to see it.',
    not_subscribed: "You don't have a paid plan to change.",
    upgrade_not_allowed: "This plan can't be upgraded right now.",
    upgrade_pending: 'An upgrade is already waiting for payment.',
    downgrade_not_allowed: "This plan can't switch to Standard right now.",
    cap_out_of_range: 'Choose a cap between $0 and $100.',
    terms_version_mismatch: 'The overage terms changed. Review them and try again.',
    size_not_allowed: "That size isn't included in your plan.",
    customer_conflict: "We couldn't match your billing account. Contact support.",
    stripe_unavailable: 'Payments are unavailable right now. Try again in a few minutes.',
};

// Optional DTO ceiling lets the consent sheet keep cap errors catalog-driven.
export function errorCopy (message, maxCapCents) {
    if ( message === 'cap_out_of_range' && maxCapCents != null ) return `Choose a cap between $0 and ${dollars(maxCapCents, { compact: true })}.`;
    return Object.hasOwn(ERRORS, message) ? ERRORS[message] : 'Could not reach billing. Try again.';
}

export function webUrl (value) {
    const url = new URL(value);
    if ( ! ['https:', 'http:'].includes(url.protocol) ) throw new Error('invalid URL');
    return url.href;
}

export const BANNED_COPY = ['faster', 'instant', 'unlimited', 'priority', 'gpu', 'heavy use', 'gpt', 'claude', 'gemini', 'llama', 'memory is kept', 'memory survives', 'processes keep running', 'ai included', 'includes ai', 'compute hours', 'standard-hour'];

/**
 * Credits are whole numbers on every user surface (founder 2026-10-29): the
 * canonical microcredit string is floored without passing it through Number,
 * and a plain balance is floored too. Never a fraction, never dollars.
 */
export function creditsLabel (micro, balance = null) {
    if ( typeof micro === 'string' && /^\d{1,100}$/.test(micro) ) return (BigInt(micro) / 1000000n).toLocaleString('en-US');
    return typeof balance === 'number' && Number.isFinite(balance) && balance >= 0 && balance <= Number.MAX_SAFE_INTEGER
        ? Math.floor(balance).toLocaleString('en-US') : 'Not reported';
}

// ── Round 3 (plan §6.3/§6.4, contract v3 D1/D3/D4) ───────────────────────────

/** The AWS data volume every paid configuration gets today (one 50 GiB EBS volume, round 3 D4). */
export const PAID_DISK_GB = 50;

const whole = value => Number.isFinite(value) ? Math.floor(value).toLocaleString('en-US') : '—';

/**
 * Upgrade AI credits (contract v3 D1): floor(ΔAI × remaining / period). The
 * preview carries the compute grant floor(ΔT × remaining / period) instead of
 * the period start, and ⌊⌊x⌋ / n⌋ = ⌊x / n⌋ for whole n, so
 * floor(grant × ΔAI / ΔT) is the SAME integer whenever ΔT / ΔAI is whole
 * (Premium − Standard: 1,656,000 s / 800 = 2,070). Pinned against
 * `upgradeAiCredits` in billing-sheets-test.mjs. 0 on any invalid input.
 */
export function upgradeAiCreditsFromGrant (grantStdSeconds, fromOffer, toOffer) {
    const deltaAi = (toOffer?.aiCredits?.amount ?? 0) - (fromOffer?.aiCredits?.amount ?? 0);
    const deltaTime = ((toOffer?.fairUseHours ?? 0) - (fromOffer?.fairUseHours ?? 0)) * 3600;
    if ( ! Number.isSafeInteger(grantStdSeconds) || grantStdSeconds <= 0 || ! Number.isSafeInteger(deltaAi) || deltaAi <= 0
        || ! Number.isSafeInteger(deltaTime) || deltaTime <= 0 || deltaTime % deltaAi !== 0 ) return 0;
    return Number(BigInt(Math.min(grantStdSeconds, deltaTime)) * BigInt(deltaAi) / BigInt(deltaTime));
}

/**
 * Plan-sheet bullets in the plan's order: configurations → storage → AI
 * credits → computer time. Built from the offer's numbers, never from
 * `offer.bullets` (catalog copy that predates round 3).
 */
export function planBullets (offer, { existingDisk } = {}) {
    // A field the offer lacks drops its bullet rather than printing "undefined".
    const known = value => Number.isSafeInteger(value) && value > 0;
    const credits = known(offer.aiCredits?.amount) ? whole(offer.aiCredits.amount) : null;
    const hours = known(offer.fairUseHours) ? whole(offer.fairUseHours) : null;
    const size = known(offer.vcpu) && known(offer.memoryGiB) ? ` · ${offer.vcpu} vCPU · ${offer.memoryGiB} GB` : '';
    const keep = list => list.filter(Boolean);
    if ( offer.sku === 'free_v3' ) return { lead: null, bullets: keep([
        `Cloudflare computer${size}${size ? ' memory' : ''}`,
        'Your files saved with your computer',
        credits && `${credits} AI credits to start`,
        hours && `${hours} hours of computer time each month`,
    ]) };
    // Round 5 D3: the plan's disk for a NEW computer (`offer.storageGiB`); 50 GB when an older server omits it.
    // An existing AWS computer (an upgrade or a change to a lower plan) keeps its own disk until the
    // server can grow it (`computer.disk.growsOnSwitch`), so its bullet names that disk, never the plan's.
    const disk = known(offer.storageGiB) ? offer.storageGiB : PAID_DISK_GB;
    const keeps = existingDisk && existingDisk.growsOnSwitch !== true;
    const diskBullet = ! keeps ? `${disk} GB disk for your projects`
        : known(existingDisk.provisionedGiB) ? `Your computer keeps its ${existingDisk.provisionedGiB} GB disk` : 'Your computer keeps its disk';
    if ( offer.sku === 'standard_monthly_v3' ) return { lead: 'Everything in Free, plus:', bullets: keep([
        `Your own AWS computer${size}`,
        diskBullet,
        credits && `${credits} AI credits every month`,
        hours && `${hours} hours of computer time each month`,
    ]) };
    const choices = offer.machineChoice ?? [];
    const vcpus = { 'std-2': 2, 'cmp-4': 4, 'cmp-8': 8 };
    const listed = choices.map(code => vcpus[code]).filter(Boolean);
    const memory = { 'std-2': 8, 'cmp-4': 16, 'cmp-8': 32 };
    const most = Math.max(offer.memoryGiB ?? 0, ...choices.map(code => memory[code] ?? 0));
    return { lead: 'Everything in Standard, plus:', bullets: keep([
        listed.length > 1 ? `Choose ${listed.slice(0, -1).join(', ')} or ${listed.at(-1)} vCPU — up to ${most} GB` : `Your own AWS computer${size}`,
        diskBullet,
        credits && `${credits} AI credits every month`,
        hours && `${hours} hours of computer time at 2 vCPU (fewer at 4 or 8 vCPU)`,
    ]) };
}

/**
 * Round 6 (R4-02): the user's AWS computer as placed (summary `computer.awsSize`) when it is a 4 or 8 vCPU
 * one: the D16 hold opens only 2 vCPU and never resizes, so on Free it stays closed. null otherwise (none,
 * 2 vCPU, unknown or an older server), and the plain hold copy stands.
 */
export function heldClosedSize (computer) {
    const aws = computer?.awsSize;
    // The same test as `computers.js` `standingCopy` (billing-test pins the two copies equal).
    return aws && (aws.size === 'cmp-4' || aws.size === 'cmp-8') && Number.isSafeInteger(aws.vcpu) && aws.vcpu > 2 ? aws : null;
}

/** Round 6 (R4-02): the hold copy for a held 4 or 8 vCPU computer, the same words on Computer, Billing and Usage. */
export function heldClosedText (vcpu) {
    return `Your files are still on your ${Number.isSafeInteger(vcpu) && vcpu > 0 ? `${vcpu} vCPU ` : ''}AWS (India) computer. The Free plan can't open it at that size; upgrade to open it again.`;
}

/**
 * Renewal gap (summary `fairUse.status: 'awaiting_payment'`): the period's invoice is not paid yet, at a renewal or a first
 * purchase, the same words on Billing and Usage.
 */
export const AWAITING_PAYMENT_COPY = "This period's time is added once your payment goes through.";

/**
 * "About 113 hours left at 8 vCPU" from the usage DTO (round 3 D3); null when the DTO lacks it.
 * Round 6: an equivalent with the current size's vCPU and weight says nothing new, so it is left out
 * (R1-07: "Same as 5 hours at 2 vCPU" under "About 5 hours left at 2 vCPU"). `monthly` (Free: one size,
 * a calendar-month allowance) says the month's allowance instead of the size: "About 5 of 8 hours left
 * this month" (R1-06).
 */
export function hoursLeftLines (period, machineChoice = [], { monthly = false } = {}) {
    if ( ! period || ! Number.isSafeInteger(period.remainingHoursAtCurrent) || period.remainingHoursAtCurrent < 0 ) return null;
    const vcpuOf = size => machineChoice.find(m => m.size === size)?.vcpu ?? { 'std-2': 2, 'cmp-4': 4, 'cmp-8': 8, 'free-cf': 2 }[size];
    const weightOf = size => machineChoice.find(m => m.size === size)?.weight ?? { 'std-2': 1, 'cmp-4': 2, 'cmp-8': 4, 'free-cf': 1 }[size];
    const current = vcpuOf(period.currentSize);
    const weight = Number.isSafeInteger(period.currentWeight) && period.currentWeight >= 1 ? period.currentWeight : weightOf(period.currentSize) ?? 1;
    const hours = n => `${whole(n)} hour${n === 1 ? '' : 's'}`;
    const others = (period.equivalents ?? []).filter(e => e && e.size !== period.currentSize && Number.isSafeInteger(e.hours)
        && ! (vcpuOf(e.size) === current && e.weight === weight))
        .sort((a, b) => b.weight - a.weight).map(e => `${hours(e.hours)} at ${vcpuOf(e.size)} vCPU`);
    const left = period.remainingHoursAtCurrent;
    const allowance = Number.isSafeInteger(period.allowanceStandardSeconds) && period.allowanceStandardSeconds > 0
        ? Math.floor(period.allowanceStandardSeconds / weight / 3600) : null;
    const underAnHour = left === 0 && Number.isFinite(period.remainingStandardSeconds) && period.remainingStandardSeconds > 0;
    const main = ! monthly ? `About ${hours(left)} left at ${current} vCPU`
        : underAnHour ? 'Less than an hour left this month'
        : allowance !== null && allowance >= left ? `About ${whole(left)} of ${hours(allowance)} left this month` : `About ${hours(left)} left this month`;
    return {
        main,
        equivalents: others.length ? `Same as ${others.slice(0, -1).join(', ')}${others.length > 1 ? ' or ' : ''}${others.at(-1)}.` : null,
    };
}
