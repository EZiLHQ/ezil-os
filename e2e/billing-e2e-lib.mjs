/** Keep diagnostics useful without exposing Stripe keys or checkout secrets. */
export function redact(value) {
    return String(value)
        .replace(/(?:sk|pk|rk)_(?:test|live)_[A-Za-z0-9_-]+/gi, '[REDACTED_STRIPE_KEY]')
        .replace(/cs_(?:test|live)_[A-Za-z0-9_-]*_secret_[A-Za-z0-9_-]+/gi, '[REDACTED_CHECKOUT_SECRET]')
        .replace(/(x-vercel-protection-bypass)["']?\s*[:=]\s*["']?[^\s"',}]+/gi, '$1: [redacted]')
        .replace(process.env.VERCEL_AUTOMATION_BYPASS_SECRET ? new RegExp(process.env.VERCEL_AUTOMATION_BYPASS_SECRET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') : /$^/, '[redacted]');
}

/** Substring matching follows CONTRACT §8, including claims inside longer words. */
export function scanCopy(value) {
    const text = String(value).toLowerCase().replace(/\s+/g, ' ');
    return ['faster', 'instant', 'unlimited', 'priority', 'gpu', 'heavy use', 'fair use', 'gpt', 'claude', 'gemini', 'llama', 'memory is kept', 'memory survives', 'processes keep running', 'ai included', 'includes ai']
        .filter(term => text.includes(term));
}

/** Reject invalid measurements so a missing document cannot masquerade as fitting. */
export function hasHorizontalOverflow({ viewportWidth, documentWidth, bodyWidth }) {
    if (![viewportWidth, documentWidth, bodyWidth].every(Number.isFinite)
        || viewportWidth <= 0 || documentWidth <= 0 || bodyWidth <= 0) {
        throw new TypeError('Expected positive, finite layout widths');
    }
    return Math.max(documentWidth, bodyWidth) > viewportWidth;
}

/** Opt-in is checked before launching Chromium or making any Stripe request. */
export function requireTestKeys(secret, publishable) {
    if (typeof secret !== 'string' || !/^sk_test_[A-Za-z0-9]+$/.test(secret)
        || typeof publishable !== 'string' || !/^pk_test_[A-Za-z0-9]+$/.test(publishable)) {
        throw new Error('Checkout requires STRIPE_E2E_SECRET sk_test_ and STRIPE_E2E_PUBLISHABLE pk_test_; live or missing keys are refused');
    }
    return { secret, publishable };
}

/** Resolve the external browser prerequisite without adding a project dependency. */
export async function launchBrowser() {
    const { createRequire } = await import('node:module');
    const { default: path } = await import('node:path');
    let chromium;
    try { ({ chromium } = await import('playwright')); } catch {
        const require = createRequire(path.join(path.resolve(process.env.PLAYWRIGHT_REQUIRE_DIR || 'node_modules'), 'probe.cjs'));
        ({ chromium } = require('playwright'));
    }
    return chromium.launch({
        headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
        args: ['--no-sandbox'],
    });
}
