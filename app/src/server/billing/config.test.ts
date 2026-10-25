import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { checkoutAvailable, readBillingConfig, stripeMode } from './config';

const factories = vi.hoisted(() => ({ store: vi.fn(), stripe: vi.fn(), usage: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('./store', () => ({ createBillingStore: factories.store }));
vi.mock('./stripe/client', () => ({ createStripeClient: factories.stripe }));
vi.mock('./stripe/usage-billing', () => ({ createStripeUsageBilling: factories.usage }));

const secretPrefixes = ['sk_test_', 'rk_test_', 'sk_live_', 'rk_live_'] as const;
const fixtureKey = (prefix: string) => `${prefix}fixture`;

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('Stripe mode', () => {
    it.each(secretPrefixes.flatMap(prefix => [undefined, 'pk_test_', 'pk_live_', 'invalid_'].map(publishable => ({ prefix, publishable }))))(
        'checks $prefix with $publishable', ({ prefix, publishable }) => {
            const mode = prefix.includes('_test_') ? 'test' : 'live';
            const config = readBillingConfig({
                CHECKOUT_ENABLED: '1', STRIPE_SECRET: fixtureKey(prefix),
                STRIPE_PUBLISHABLE_KEY: publishable === undefined ? undefined : fixtureKey(publishable),
            });
            const matches = publishable === undefined || publishable === `pk_${mode}_`;
            expect(stripeMode(config)).toEqual(matches ? { mode } : { mode: null, reason: 'mixed' });
            expect(checkoutAvailable(config)).toBe(matches);
            expect(checkoutAvailable({ ...config, checkoutEnabled: false })).toBe(false);
        },
    );

    it.each([undefined, '', '   '])('requires a secret even when a publishable key is set (%#)', secret => {
        const config = readBillingConfig({ CHECKOUT_ENABLED: '1', STRIPE_SECRET: secret, STRIPE_PUBLISHABLE_KEY: fixtureKey('pk_live_') });
        expect(stripeMode(config)).toEqual({ mode: null, reason: 'absent' });
        expect(checkoutAvailable(config)).toBe(false);
    });

    it.each(['sk_unknown_', 'rk_unknown_', 'pk_test_', 'prefix_sk_test_', 'SK_TEST_', 'fixture-only'])(
        'refuses unrecognized secret prefix %s', prefix => {
            const config = readBillingConfig({ CHECKOUT_ENABLED: '1', STRIPE_SECRET: fixtureKey(prefix) });
            expect(stripeMode(config)).toEqual({ mode: null, reason: 'unrecognized' });
            expect(checkoutAvailable(config)).toBe(false);
        },
    );

    it.each(['STRIPE_PUBLISHABLE_KEY', 'STRIPE_KEY'])('keeps invalid %s private while refusing checkout', name => {
        const config = readBillingConfig({ CHECKOUT_ENABLED: '1', STRIPE_SECRET: fixtureKey('sk_test_'), [name]: fixtureKey('sk_test_') });
        expect(config.stripePublishableKey).toBeUndefined();
        expect(stripeMode(config)).toEqual({ mode: null, reason: 'mixed' });
        expect(checkoutAvailable(config)).toBe(false);
    });

    it.each(['pk_live_', 'invalid_', ''])('also validates directly injected publishable keys (%#)', prefix => {
        const config = readBillingConfig({ CHECKOUT_ENABLED: '1', STRIPE_SECRET: fixtureKey('sk_test_') });
        config.stripePublishableKey = prefix === '' ? '' : fixtureKey(prefix);
        expect(stripeMode(config)).toEqual({ mode: null, reason: 'mixed' });
        expect(checkoutAvailable(config)).toBe(false);
    });

    it('never exposes key text in mode results or console output', () => {
        const output = [vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'log')];
        output.forEach(spy => spy.mockImplementation(() => {}));
        for (const prefix of [...secretPrefixes, 'invalid_']) {
            for (const publicPrefix of ['pk_test_', 'pk_live_', 'invalid_']) {
                const secret = fixtureKey(prefix);
                const publishable = fixtureKey(publicPrefix);
                const result = stripeMode(readBillingConfig({ STRIPE_SECRET: secret, STRIPE_PUBLISHABLE_KEY: publishable }));
                const captured = JSON.stringify({ result, output: output.map(spy => spy.mock.calls) });
                expect(captured).not.toContain(secret);
                expect(captured).not.toContain(publishable);
            }
        }
    });
});

describe('billing dependency mode guard', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        factories.store.mockReturnValue({});
        factories.stripe.mockReturnValue({});
        factories.usage.mockReturnValue({});
        vi.stubEnv('STRIPE_SECRET', undefined);
        vi.stubEnv('STRIPE_PUBLISHABLE_KEY', undefined);
        vi.stubEnv('STRIPE_KEY', undefined);
    });

    it.each([
        { secret: undefined, publishable: undefined, reason: 'absent' },
        { secret: 'invalid_', publishable: undefined, reason: 'unrecognized' },
        { secret: 'sk_test_', publishable: 'pk_live_', reason: 'mixed' },
        { secret: 'sk_live_', publishable: 'pk_test_', reason: 'mixed' },
        { secret: 'rk_test_', publishable: 'invalid_', reason: 'mixed' },
    ])('disables both providers and warns once for $reason ($secret)', async ({ secret, publishable, reason }) => {
        vi.stubEnv('STRIPE_SECRET', secret === undefined ? undefined : fixtureKey(secret));
        vi.stubEnv('STRIPE_PUBLISHABLE_KEY', publishable === undefined ? undefined : fixtureKey(publishable));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { getBillingDeps } = await import('./deps');
        for (let call = 0; call < 2; call++) {
            const deps = getBillingDeps();
            expect(deps.stripe).toBeNull();
            expect(deps.usage).toBeNull();
        }
        expect(factories.stripe).not.toHaveBeenCalled();
        expect(factories.usage).not.toHaveBeenCalled();
        expect(warn.mock.calls).toEqual([['[billing.config] stripe disabled', { reason }]]);
        const captured = JSON.stringify(warn.mock.calls);
        if (secret) expect(captured).not.toContain(fixtureKey(secret));
        if (publishable) expect(captured).not.toContain(fixtureKey(publishable));
    });

    it.each(secretPrefixes)('builds both providers for %s', async prefix => {
        vi.stubEnv('STRIPE_SECRET', fixtureKey(prefix));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { getBillingDeps } = await import('./deps');
        const deps = getBillingDeps();
        expect(deps.stripe).toBe(factories.stripe.mock.results[0]?.value);
        expect(deps.usage).toBe(factories.usage.mock.results[0]?.value);
        expect(factories.stripe).toHaveBeenCalledTimes(1);
        expect(factories.usage).toHaveBeenCalledTimes(1);
        expect(warn).not.toHaveBeenCalled();
    });

    it('rechecks swaps on every call without repeating the warning', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { getBillingDeps } = await import('./deps');
        expect(getBillingDeps().stripe).toBeNull();
        vi.stubEnv('STRIPE_SECRET', fixtureKey('sk_test_'));
        expect(getBillingDeps().stripe).not.toBeNull();
        vi.stubEnv('STRIPE_PUBLISHABLE_KEY', fixtureKey('pk_live_'));
        expect(getBillingDeps().stripe).toBeNull();
        expect(getBillingDeps().usage).toBeNull();
        expect(warn.mock.calls).toEqual([['[billing.config] stripe disabled', { reason: 'absent' }]]);
    });
});
