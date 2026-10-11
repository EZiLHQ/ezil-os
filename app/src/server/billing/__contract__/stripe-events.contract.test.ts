import { describe, expect, it } from 'vitest';
import { planStripeEvent } from '../stripe/events';

type Event = Parameters<typeof planStripeEvent>[0];
type Action = ReturnType<typeof planStripeEvent>[number];

function event(type: string, object: Record<string, unknown>): Event {
    return { id: 'evt_contract', type, created: 1_791_720_000, livemode: false, data: { object } } as Event;
}

/** §5.1 freezes action meanings, not a discriminator spelling; accept either public convention. */
function actionName(action: Action): unknown {
    const fields = action as unknown as Record<string, unknown>;
    return fields.type ?? fields.kind;
}

function names(input: Event): unknown[] {
    return planStripeEvent(input).map(actionName);
}

/** Payload field casing is not frozen; check the semantic field without prescribing it. */
function field(action: Action, name: string): unknown {
    const fields = action as unknown as Record<string, unknown>;
    const entry = Object.entries(fields).find(([key]) => key.replaceAll('_', '').toLowerCase() === name.toLowerCase());
    return entry?.[1];
}

const checkout = {
    id: 'cs_contract', client_reference_id: 'user_reference', customer: 'cus_contract',
    mode: 'payment', payment_status: 'paid', payment_intent: 'pi_contract',
    metadata: { user_id: 'user_metadata_attacker', sku: 'ai_pack_10_v1' },
};
const invoice = {
    id: 'in_contract', customer: 'cus_contract', subscription: 'sub_contract',
    lines: { data: [
        { id: 'il_oneoff', type: 'invoiceitem', period: { start: 10, end: 20 } },
        { id: 'il_subscription', type: 'subscription', subscription: 'sub_contract',
            period: { start: 1_791_158_400, end: 1_793_836_800 } },
    ] },
    // Deliberately different from the subscription line: grants follow the line period.
    period_start: 1, period_end: 2,
};

describe('Stripe event planning contract', () => {
    it('links a completed checkout to client_reference_id rather than metadata.user_id', () => {
        const actions = planStripeEvent(event('checkout.session.completed', checkout));
        expect(actions.map(actionName)).toEqual(['link_customer', 'topup_paid']);
        const linked = actions.find((action: Action) => actionName(action) === 'link_customer');
        expect(linked).toBeDefined();
        expect(field(linked!, 'userId')).toBe('user_reference');
        expect(field(linked!, 'customerId') ?? field(linked!, 'stripeCustomerId')).toBe('cus_contract');
        expect(JSON.stringify(actions)).toContain('user_reference');
        expect(JSON.stringify(actions)).not.toContain('user_metadata_attacker');
    });

    it('adds a topup only for a completed, paid payment-mode checkout', () => {
        expect(names(event('checkout.session.completed', checkout))).toEqual(['link_customer', 'topup_paid']);
        for (const object of [
            { ...checkout, mode: 'subscription' },
            { ...checkout, payment_status: 'unpaid' },
            { ...checkout, payment_status: 'no_payment_required' },
        ]) {
            expect(names(event('checkout.session.completed', object))).toEqual(['link_customer']);
        }
    });

    it('plans a topup after asynchronous checkout payment succeeds', () => {
        expect(names(event('checkout.session.async_payment_succeeded', checkout))).toEqual(['topup_paid']);
    });

    it('keys the period grant by invoice id and uses the subscription line period', () => {
        const actions = planStripeEvent(event('invoice.paid', invoice));
        expect(actions.map(actionName)).toEqual(['grant_period']);
        const action = actions[0]!;
        expect(field(action, 'invoiceId') ?? field(action, 'sourceId')).toBe('in_contract');
        const asSeconds = (value: unknown): number => value instanceof Date ? value.getTime() / 1000
            : typeof value === 'string' ? Date.parse(value) / 1000 : Number(value);
        expect(asSeconds(field(action, 'periodStart'))).toBe(1_791_158_400);
        expect(asSeconds(field(action, 'periodEnd'))).toBe(1_793_836_800);
    });

    it('syncs a subscription after invoice payment fails', () => {
        const actions = planStripeEvent(event('invoice.payment_failed', invoice));
        expect(actions.map(actionName)).toEqual(['sync_subscription']);
        expect(field(actions[0]!, 'subscriptionId') ?? field(actions[0]!, 'stripeSubscriptionId')).toBe('sub_contract');
    });

    it.each(['created', 'updated', 'deleted'])('syncs customer.subscription.%s', suffix => {
        const actions = planStripeEvent(event(`customer.subscription.${suffix}`, {
            id: 'sub_contract', customer: 'cus_contract', status: suffix === 'deleted' ? 'canceled' : 'active',
        }));
        expect(actions.map(actionName)).toEqual(['sync_subscription']);
        expect(field(actions[0]!, 'subscriptionId') ?? field(actions[0]!, 'stripeSubscriptionId')).toBe('sub_contract');
    });

    it('keys each revocation by its refund id rather than the charge id', () => {
        const actions = planStripeEvent(event('charge.refunded', {
            id: 'ch_contract', customer: 'cus_contract', payment_intent: 'pi_contract',
            refunds: { data: [
                { id: 're_first', amount: 500, payment_intent: 'pi_contract' },
                { id: 're_second', amount: 584, payment_intent: 'pi_contract' },
            ] },
        }));
        expect(actions.map(actionName)).toEqual(['revoke', 'revoke']);
        expect(actions.map((action: Action) => field(action, 'refundId') ?? field(action, 'sourceId'))).toEqual(['re_first', 're_second']);
    });

    it('suspends a grant when a dispute is created', () => {
        expect(names(event('charge.dispute.created', {
            id: 'dp_contract', charge: 'ch_contract', payment_intent: 'pi_contract', status: 'needs_response',
        }))).toEqual(['suspend']);
    });

    it('restores a won dispute and ignores closed disputes that were not won', () => {
        const dispute = { id: 'dp_contract', charge: 'ch_contract', payment_intent: 'pi_contract', status: 'won' };
        expect(names(event('charge.dispute.closed', dispute))).toEqual(['restore']);
        for (const status of ['lost', 'warning_closed']) {
            expect(planStripeEvent(event('charge.dispute.closed', { ...dispute, status }))).toEqual([]);
        }
    });

    it.each(['unknown.contract.event', 'checkout.session.expired', 'checkout.session.async_payment_failed', 'invoice.created'])(
        'acknowledges and ignores %s even with persuasive metadata', type => {
            expect(names(event('checkout.session.completed', checkout))).toEqual(['link_customer', 'topup_paid']);
            expect(planStripeEvent(event(type, checkout))).toEqual([]);
        },
    );

    it('cannot link a checkout from metadata when client_reference_id is absent', () => {
        expect(names(event('checkout.session.completed', checkout))).toContain('link_customer');
        const actions = planStripeEvent(event('checkout.session.completed', { ...checkout, client_reference_id: null }));
        expect(actions.map(actionName)).not.toContain('link_customer');
        expect(JSON.stringify(actions)).not.toContain('user_metadata_attacker');
    });

    it.each([
        ['checkout.session.completed', checkout],
        ['checkout.session.async_payment_succeeded', checkout],
        ['invoice.paid', invoice],
        ['invoice.payment_failed', invoice],
        ['customer.subscription.created', { id: 'sub_contract', customer: 'cus_contract' }],
        ['customer.subscription.updated', { id: 'sub_contract', customer: 'cus_contract' }],
        ['customer.subscription.deleted', { id: 'sub_contract', customer: 'cus_contract' }],
        ['charge.refunded', { id: 'ch_contract', payment_intent: 'pi_contract', refunds: { data: [{ id: 're_contract', amount: 1084 }] } }],
        ['charge.dispute.created', { id: 'dp_contract', charge: 'ch_contract' }],
        ['charge.dispute.closed', { id: 'dp_contract', charge: 'ch_contract', status: 'won' }],
    ] as const)('never lets metadata.user_id redirect %s', (type, object) => {
        const base: Record<string, unknown> = { ...object };
        const metadata = base.metadata as Record<string, unknown> | undefined;
        const control = planStripeEvent(event(type, { ...base, metadata: { ...metadata, user_id: 'user_reference' } }));
        expect(control.length).toBeGreaterThan(0);
        const poisoned = planStripeEvent(event(type, { ...base, metadata: { ...metadata, user_id: 'user_metadata_attacker' } }));
        expect(poisoned).toEqual(control);
        expect(JSON.stringify(poisoned)).not.toContain('user_metadata_attacker');
    });
});
