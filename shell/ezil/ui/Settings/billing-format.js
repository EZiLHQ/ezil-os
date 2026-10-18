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

export const BANNED_COPY = ['faster', 'instant', 'unlimited', 'priority', 'gpu', 'heavy use', 'fair use', 'gpt', 'claude', 'gemini', 'llama', 'memory is kept', 'memory survives', 'processes keep running', 'ai included', 'includes ai'];
