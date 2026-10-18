import { describe, expect, it } from 'vitest';

import { planStripeEvent, type BillingAction, type StripeEventLike } from './events';

const eventId = 'evt_fixture';
const created = 1_800_000_000;
const start = 1_799_000_000;
const end = 1_801_000_000;

function event(type: string, object: Record<string, unknown>): StripeEventLike {
    return { id: eventId, type, created, livemode: false, data: { object } };
}

const checkout = {
    id: 'cs_fixture', customer: 'cus_fixture', client_reference_id: 'user_fixture',
    mode: 'payment', payment_status: 'paid', payment_intent: 'pi_fixture',
};
const invoice2024 = {
    id: 'in_fixture', customer: 'cus_fixture', subscription: 'sub_fixture',
    lines: { data: [{ subscription: 'sub_fixture', period: { start, end } }] },
};
const invoiceEndive = {
    id: 'in_fixture', customer: 'cus_fixture', billing_reason: 'subscription_cycle', status: 'paid', metadata: {},
    hosted_invoice_url: 'https://invoice.stripe.com/fixture',
    parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_fixture' } },
    lines: { data: [{
        id: 'il_base', amount: 2000, pricing: { price_details: { price: 'price_standard' } },
        parent: {
            type: 'subscription_item_details',
            subscription_item_details: { subscription: 'sub_fixture', proration: false },
        },
        period: { start, end },
    }] },
};
const link: BillingAction = {
    type: 'link_customer', customerId: 'cus_fixture', clientReferenceId: 'user_fixture', eventId,
};
const paid: BillingAction = {
    type: 'topup_paid', paymentIntentId: 'pi_fixture', customerId: 'cus_fixture', sessionId: 'cs_fixture', eventId,
};
const grant: BillingAction = {
    type: 'grant_period', invoiceId: 'in_fixture', subscriptionId: 'sub_fixture',
    customerId: 'cus_fixture', periodStart: new Date(start * 1000), periodEnd: new Date(end * 1000), eventId,
};
const sync: BillingAction = {
    type: 'sync_subscription', subscriptionId: 'sub_fixture', eventId, eventCreated: new Date(created * 1000),
};
const failedSync: BillingAction = { ...sync, invoiceIssue: { invoiceId: 'in_fixture', issue: 'payment_failed' } };
const charge = { id: 'ch_fixture', refunds: { data: [{ id: 're_first' }, { id: 're_second' }] } };
const dispute = { id: 'dp_fixture', charge: 'ch_fixture', status: 'won' };
const restore: BillingAction = { type: 'restore', chargeId: 'ch_fixture', disputeId: 'dp_fixture', eventId };

const fixtures: { name: string; input: StripeEventLike; expected: BillingAction[] }[] = [
    { name: 'checkout.session.completed', input: event('checkout.session.completed', checkout), expected: [link, paid] },
    {
        name: 'checkout.session.async_payment_succeeded',
        input: event('checkout.session.async_payment_succeeded', {
            id: 'cs_fixture', customer: 'cus_fixture', payment_intent: 'pi_fixture',
        }),
        expected: [paid],
    },
    { name: 'invoice.paid (2024)', input: event('invoice.paid', invoice2024), expected: [grant] },
    { name: 'invoice.paid (2026-09-30.endive)', input: event('invoice.paid', invoiceEndive), expected: [grant] },
    {
        name: 'invoice.payment_failed',
        input: event('invoice.payment_failed', invoiceEndive), expected: [failedSync],
    },
    { name: 'customer.subscription.created', input: event('customer.subscription.created', { id: 'sub_fixture' }), expected: [sync] },
    { name: 'customer.subscription.updated', input: event('customer.subscription.updated', { id: 'sub_fixture' }), expected: [sync] },
    { name: 'customer.subscription.deleted', input: event('customer.subscription.deleted', { id: 'sub_fixture' }), expected: [sync] },
    {
        name: 'charge.refunded', input: event('charge.refunded', charge),
        expected: [
            { type: 'revoke', chargeId: 'ch_fixture', refundId: 're_first', eventId },
            { type: 'revoke', chargeId: 'ch_fixture', refundId: 're_second', eventId },
        ],
    },
    {
        name: 'charge.dispute.created', input: event('charge.dispute.created', { id: 'dp_fixture', charge: 'ch_fixture' }),
        expected: [{ type: 'suspend', chargeId: 'ch_fixture', disputeId: 'dp_fixture', eventId }],
    },
    { name: 'charge.dispute.closed', input: event('charge.dispute.closed', dispute), expected: [restore] },
];

describe('planStripeEvent', () => {
    it.each(fixtures)('plans $name from a minimal fixture', ({ input, expected }) => {
        expect(planStripeEvent(input)).toEqual(expected);
    });

    it('acknowledges unknown types without planning an action', () => {
        expect(planStripeEvent(event('checkout.session.completed', checkout))).toEqual([link, paid]);
        expect(planStripeEvent(event('payment_intent.succeeded', {}))).toEqual([]);
    });

    it.each([
        { subscription: null },
        { parent: null },
        { parent: { type: 'quote_details', quote_details: { quote: 'qt_fixture' } } },
    ])('reconciles a one-off invoice %#', shape => {
        expect(planStripeEvent(event('invoice.paid', invoice2024))).toEqual([grant]);
        expect(planStripeEvent(event('invoice.paid', { id: 'in_oneoff', customer: 'cus_fixture', ...shape }))).toEqual([
            { ...grant, invoiceId: 'in_oneoff', subscriptionId: null, periodStart: null, periodEnd: null },
        ]);
        expect(planStripeEvent(event('invoice.payment_failed', invoice2024))).toEqual([failedSync]);
        expect(planStripeEvent(event('invoice.payment_failed', { id: 'in_oneoff', ...shape }))).toEqual([
            { type: 'invoice_issue', invoiceId: 'in_oneoff', issue: 'payment_failed', eventCreated: new Date(created * 1000) },
        ]);
    });

    it.each([
        { mode: 'payment', payment_status: 'unpaid' },
        { mode: 'payment', payment_status: 'no_payment_required' },
        { mode: 'subscription', payment_status: 'paid' },
        { mode: 'setup', payment_status: 'paid' },
    ])('links but does not grant a top-up for $mode / $payment_status', fields => {
        expect(planStripeEvent(event('checkout.session.completed', checkout))).toEqual([link, paid]);
        expect(planStripeEvent(event('checkout.session.completed', { ...checkout, ...fields, payment_intent: null }))).toEqual([link]);
    });

    it.each(['lost', 'warning_closed'])('does not restore a dispute closed as %s', status => {
        expect(planStripeEvent(event('charge.dispute.closed', dispute))).toEqual([restore]);
        expect(planStripeEvent(event('charge.dispute.closed', { ...dispute, status }))).toEqual([]);
    });

    it.each([invoice2024, invoiceEndive])('chooses the matching subscription line before the first line %#', invoice => {
        expect(planStripeEvent(event('invoice.paid', {
            ...invoice,
            lines: { data: [
                { subscription: 'sub_other', period: { start: 10, end: 20 } },
                ...invoice.lines.data,
            ] },
            period_start: 30, period_end: 40,
        }))).toEqual([grant]);
    });

    it.each([invoice2024, invoiceEndive])('does not fall back to an untyped first line %#', invoice => {
        expect(planStripeEvent(event('invoice.paid', {
            ...invoice, lines: { data: [{ period: { start, end } }, { period: { start: 10, end: 20 } }] },
        }))).toEqual([{ ...grant, periodStart: null, periodEnd: null }]);
    });

    it('uses the modern parent when the legacy subscription is null', () => {
        expect(planStripeEvent(event('invoice.paid', { ...invoiceEndive, subscription: null }))).toEqual([grant]);
        expect(planStripeEvent(event('invoice.payment_failed', invoiceEndive))).toEqual([failedSync]);
    });

    it('reduces expanded references to Stripe ids', () => {
        expect(planStripeEvent(event('checkout.session.completed', {
            ...checkout, customer: { id: 'cus_fixture' }, payment_intent: { id: 'pi_fixture' },
        }))).toEqual([link, paid]);
        expect(planStripeEvent(event('invoice.paid', {
            ...invoiceEndive, customer: { id: 'cus_fixture' },
            parent: { subscription_details: { subscription: { id: 'sub_fixture' } } },
            lines: { data: [
                { period: { start: 10, end: 20 } },
                { parent: { subscription_item_details: { subscription: { id: 'sub_fixture' } } }, period: { start, end } },
            ] },
        }))).toEqual([grant]);
        expect(planStripeEvent(event('charge.dispute.closed', { ...dispute, charge: { id: 'ch_fixture' } }))).toEqual([restore]);
    });

    it('does not read metadata, and never substitutes it for client_reference_id', () => {
        const payload = { ...checkout };
        Object.defineProperty(payload, 'metadata', { get() { throw new Error('metadata was read'); } });
        expect(planStripeEvent(event('checkout.session.completed', payload))).toEqual([link, paid]);
        // Without client_reference_id nothing is linked — and metadata is still not a fallback.
        expect(planStripeEvent(event('checkout.session.completed', {
            ...checkout, client_reference_id: null, metadata: { user_id: 'user_from_metadata' },
        }))).toEqual([paid]);
    });

    it('preserves event identity and created time without filtering live mode', () => {
        const input = { ...event('customer.subscription.updated', { id: 'sub_fixture' }), id: 'evt_other', created: created + 1, livemode: true };
        expect(planStripeEvent(input)).toEqual([{ ...sync, eventId: 'evt_other', eventCreated: new Date((created + 1) * 1000) }]);
    });

    it('leaves the event unchanged', () => {
        const input = event('invoice.paid', invoiceEndive);
        const before = JSON.stringify(input);
        expect(planStripeEvent(input)).toEqual([grant]);
        expect(JSON.stringify(input)).toBe(before);
    });

    const invalidPayloads: { name: string; type: string; valid: Record<string, unknown>; invalid: Record<string, unknown>; message: string }[] = [
        { name: 'missing customer', type: 'checkout.session.completed', valid: checkout, invalid: { ...checkout, customer: null }, message: 'checkout.session.customer must be an object' },
        { name: 'missing payment intent', type: 'checkout.session.async_payment_succeeded', valid: checkout, invalid: { ...checkout, payment_intent: null }, message: 'checkout.session.payment_intent must be an object' },
        { name: 'missing session id', type: 'checkout.session.async_payment_succeeded', valid: checkout, invalid: { ...checkout, id: '' }, message: 'checkout.session.id must be a non-empty string' },
        { name: 'missing checkout mode', type: 'checkout.session.completed', valid: checkout, invalid: { ...checkout, mode: null }, message: 'checkout.session.mode must be a non-empty string' },
        { name: 'malformed subscription', type: 'invoice.paid', valid: invoice2024, invalid: { ...invoice2024, subscription: {} }, message: 'invoice.subscription.id must be a non-empty string' },
        { name: 'malformed parent', type: 'invoice.paid', valid: invoiceEndive, invalid: { ...invoiceEndive, parent: [] }, message: 'invoice.parent must be an object' },
        { name: 'missing lines', type: 'invoice.paid', valid: invoice2024, invalid: { ...invoice2024, lines: null }, message: 'invoice.lines must be an object' },
        { name: 'non-array lines', type: 'invoice.paid', valid: invoice2024, invalid: { ...invoice2024, lines: { data: {} } }, message: 'invoice.lines.data must be an array' },
        { name: 'null line', type: 'invoice.paid', valid: invoice2024, invalid: { ...invoice2024, lines: { data: [null] } }, message: 'invoice.lines.data[0] must be an object' },
        { name: 'missing period', type: 'invoice.paid', valid: invoice2024, invalid: { ...invoice2024, lines: { data: [{ type: 'subscription' }] } }, message: 'invoice.lines.data[0].period must be an object' },
        { name: 'string period', type: 'invoice.paid', valid: invoice2024, invalid: { ...invoice2024, lines: { data: [{ type: 'subscription', period: { start: String(start), end } }] } }, message: 'invoice.lines.data[0].period.start must be a non-negative Unix timestamp in seconds' },
        { name: 'reversed period', type: 'invoice.paid', valid: invoice2024, invalid: { ...invoice2024, lines: { data: [{ type: 'subscription', period: { start: end, end: start } }] } }, message: 'invoice.lines.data[0].period.end must be after its start' },
        { name: 'empty subscription id', type: 'customer.subscription.updated', valid: { id: 'sub_fixture' }, invalid: { id: '' }, message: 'subscription.id must be a non-empty string' },
        { name: 'refund without charge', type: 'refund.created', valid: { id: 're_fixture', charge: 'ch_fixture' }, invalid: { id: 're_fixture' }, message: 'refund.charge must be an object' },
        { name: 'missing refund id', type: 'charge.refunded', valid: charge, invalid: { ...charge, refunds: { data: [{}] } }, message: 'charge.refunds.data[0].id must be a non-empty string' },
        { name: 'missing dispute charge', type: 'charge.dispute.created', valid: dispute, invalid: { ...dispute, charge: null }, message: 'dispute.charge must be an object' },
        { name: 'missing dispute status', type: 'charge.dispute.closed', valid: dispute, invalid: { ...dispute, status: null }, message: 'dispute.status must be a non-empty string' },
    ];

    it.each(invalidPayloads)('rejects $name with a field-specific TypeError', fixture => {
        expect(planStripeEvent(event(fixture.type, fixture.valid)).length).toBeGreaterThan(0);
        expect(() => planStripeEvent(event(fixture.type, fixture.invalid))).toThrow(new TypeError(fixture.message));
    });

    it.each([
        ['event', null], ['event.id', { id: '' }], ['event.type', { type: null }],
        ['event.created', { created: NaN }], ['event.created', { created: -1 }],
        ['event.created', { created: 1.5 }], ['event.created', { created: 9_000_000_000_000 }],
        ['event.livemode', { livemode: 'false' }], ['event.data', { data: [] }],
        ['event.data.object', { data: { object: null } }],
    ])('rejects a malformed %s envelope', (path, fields) => {
        const valid = event('checkout.session.completed', checkout);
        expect(planStripeEvent(valid)).toEqual([link, paid]);
        const invalid = fields === null ? null : { ...valid, ...fields as object };
        expect(() => planStripeEvent(invalid as StripeEventLike)).toThrow(TypeError);
        expect(() => planStripeEvent(invalid as StripeEventLike)).toThrow(String(path));
    });
});

describe('refunds on current Stripe API versions', () => {
    it('plans a revoke from refund.created and refund.updated', () => {
        for (const type of ['refund.created', 'refund.updated']) {
            expect(planStripeEvent(event(type, { id: 're_live', charge: 'ch_live', status: 'succeeded' })))
                .toEqual([{ type: 'revoke', chargeId: 'ch_live', refundId: 're_live', eventId }]);
        }
    });

    it('ignores charge.refunded without an embedded refund list (positive control: with one it revokes)', () => {
        expect(planStripeEvent(event('charge.refunded', { id: 'ch_live', refunded: true }))).toEqual([]);
        expect(planStripeEvent(event('charge.refunded', { id: 'ch_live', refunds: { data: [{ id: 're_old' }] } })))
            .toEqual([{ type: 'revoke', chargeId: 'ch_live', refundId: 're_old', eventId }]);
    });
});


describe('endive invoice issues and pending updates', () => {
    it.each([
        ['invoice.payment_action_required', 'requires_action'],
        ['invoice.voided', 'voided'],
        ['invoice.marked_uncollectible', 'uncollectible'],
    ])('plans %s', (type, issue) => {
        expect(planStripeEvent(event(type, invoiceEndive))).toEqual([
            { type: 'invoice_issue', invoiceId: 'in_fixture', issue, eventCreated: new Date(created * 1000) },
        ]);
    });

    it('plans a standalone overage payment failure', () => {
        expect(planStripeEvent(event('invoice.payment_failed', {
            ...invoiceEndive, parent: null, metadata: { kind: 'overage' }, billing_reason: 'manual',
        }))).toEqual([{ type: 'invoice_issue', invoiceId: 'in_fixture', issue: 'payment_failed', eventCreated: new Date(created * 1000) }]);
    });

    it.each(['applied', 'expired'])('plans pending_update_%s', outcome => {
        expect(planStripeEvent(event(`customer.subscription.pending_update_${outcome}`, {
            id: 'sub_fixture', pending_update: null, items: { data: [{ price: { id: 'price_compute', lookup_key: 'ezil_compute_monthly_v2' } }] },
        }))).toEqual([{ type: 'plan_change', subscriptionId: 'sub_fixture', outcome, eventCreated: new Date(created * 1000) }]);
    });

    it.each([{ type: 'subscription' }, { parent: { type: 'subscription_item_details' } }])('selects a typed subscription line without ownership', typed => {
        expect(planStripeEvent(event('invoice.paid', { ...invoiceEndive, lines: { data: [
            { type: 'invoiceitem', period: { start: 10, end: 20 } },
            { ...typed, period: { start, end } },
        ] } }))).toEqual([grant]);
    });

    it('keeps empty line periods null and ignores invoice.created', () => {
        expect(planStripeEvent(event('invoice.paid', { ...invoiceEndive, lines: { data: [] } })))
            .toEqual([{ ...grant, periodStart: null, periodEnd: null }]);
        expect(planStripeEvent(event('invoice.created', invoiceEndive))).toEqual([]);
    });
});
