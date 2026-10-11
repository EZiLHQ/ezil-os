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
const invoice2025 = {
    id: 'in_fixture', customer: 'cus_fixture',
    parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_fixture' } },
    lines: { data: [{
        parent: {
            type: 'subscription_item_details',
            subscription_item_details: { subscription: 'sub_fixture' },
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
    { name: 'invoice.paid (2025+)', input: event('invoice.paid', invoice2025), expected: [grant] },
    {
        name: 'invoice.payment_failed',
        input: event('invoice.payment_failed', { id: 'in_fixture', subscription: 'sub_fixture' }), expected: [sync],
    },
    { name: 'customer.subscription.created', input: event('customer.subscription.created', { id: 'sub_fixture' }), expected: [sync] },
    { name: 'customer.subscription.updated', input: event('customer.subscription.updated', { id: 'sub_fixture' }), expected: [sync] },
    { name: 'customer.subscription.deleted', input: event('customer.subscription.deleted', { id: 'sub_fixture' }), expected: [sync] },
    {
        name: 'charge.refunded', input: event('charge.refunded', charge),
        expected: [{ type: 'revoke', chargeId: 'ch_fixture', refundIds: ['re_first', 're_second'], eventId }],
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
    ])('ignores a one-off invoice %#', shape => {
        expect(planStripeEvent(event('invoice.paid', invoice2024))).toEqual([grant]);
        expect(planStripeEvent(event('invoice.paid', { id: 'in_oneoff', customer: 'cus_fixture', ...shape }))).toEqual([]);
        expect(planStripeEvent(event('invoice.payment_failed', invoice2024))).toEqual([sync]);
        expect(planStripeEvent(event('invoice.payment_failed', { id: 'in_oneoff', ...shape }))).toEqual([]);
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

    it.each([invoice2024, invoice2025])('chooses the matching subscription line before the first line %#', invoice => {
        expect(planStripeEvent(event('invoice.paid', {
            ...invoice,
            lines: { data: [
                { subscription: 'sub_other', period: { start: 10, end: 20 } },
                ...invoice.lines.data,
            ] },
            period_start: 30, period_end: 40,
        }))).toEqual([grant]);
    });

    it.each([invoice2024, invoice2025])('falls back to the first line period without a matching subscription %#', invoice => {
        expect(planStripeEvent(event('invoice.paid', {
            ...invoice, lines: { data: [{ period: { start, end } }, { period: { start: 10, end: 20 } }] },
        }))).toEqual([grant]);
    });

    it('uses the modern parent when the legacy subscription is null', () => {
        expect(planStripeEvent(event('invoice.paid', { ...invoice2025, subscription: null }))).toEqual([grant]);
        expect(planStripeEvent(event('invoice.payment_failed', invoice2025))).toEqual([sync]);
    });

    it('reduces expanded references to Stripe ids', () => {
        expect(planStripeEvent(event('checkout.session.completed', {
            ...checkout, customer: { id: 'cus_fixture' }, payment_intent: { id: 'pi_fixture' },
        }))).toEqual([link, paid]);
        expect(planStripeEvent(event('invoice.paid', {
            ...invoice2025, customer: { id: 'cus_fixture' },
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
        expect(() => planStripeEvent(event('checkout.session.completed', {
            ...checkout, client_reference_id: null, metadata: { user_id: 'user_from_metadata' },
        }))).toThrow(new TypeError('checkout.session.client_reference_id must be a non-empty string'));
    });

    it('preserves event identity and created time without filtering live mode', () => {
        const input = { ...event('customer.subscription.updated', { id: 'sub_fixture' }), id: 'evt_other', created: created + 1, livemode: true };
        expect(planStripeEvent(input)).toEqual([{ ...sync, eventId: 'evt_other', eventCreated: new Date((created + 1) * 1000) }]);
    });

    it('leaves the event unchanged', () => {
        const input = event('invoice.paid', invoice2025);
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
        { name: 'malformed parent', type: 'invoice.paid', valid: invoice2025, invalid: { ...invoice2025, parent: [] }, message: 'invoice.parent must be an object' },
        { name: 'missing lines', type: 'invoice.paid', valid: invoice2024, invalid: { ...invoice2024, lines: null }, message: 'invoice.lines must be an object' },
        { name: 'non-array lines', type: 'invoice.paid', valid: invoice2024, invalid: { ...invoice2024, lines: { data: {} } }, message: 'invoice.lines.data must be an array' },
        { name: 'empty lines', type: 'invoice.paid', valid: invoice2024, invalid: { ...invoice2024, lines: { data: [] } }, message: 'invoice.lines.data must contain a billing period' },
        { name: 'null line', type: 'invoice.paid', valid: invoice2024, invalid: { ...invoice2024, lines: { data: [null] } }, message: 'invoice.lines.data[0] must be an object' },
        { name: 'missing period', type: 'invoice.paid', valid: invoice2024, invalid: { ...invoice2024, lines: { data: [{}] } }, message: 'invoice.lines.data[0].period must be an object' },
        { name: 'string period', type: 'invoice.paid', valid: invoice2024, invalid: { ...invoice2024, lines: { data: [{ period: { start: String(start), end } }] } }, message: 'invoice.lines.data[0].period.start must be a non-negative Unix timestamp in seconds' },
        { name: 'reversed period', type: 'invoice.paid', valid: invoice2024, invalid: { ...invoice2024, lines: { data: [{ period: { start: end, end: start } }] } }, message: 'invoice.lines.data[0].period.end must be after its start' },
        { name: 'empty subscription id', type: 'customer.subscription.updated', valid: { id: 'sub_fixture' }, invalid: { id: '' }, message: 'subscription.id must be a non-empty string' },
        { name: 'missing refunds', type: 'charge.refunded', valid: charge, invalid: { ...charge, refunds: null }, message: 'charge.refunds must be an object' },
        { name: 'empty refunds', type: 'charge.refunded', valid: charge, invalid: { ...charge, refunds: { data: [] } }, message: 'charge.refunds.data must contain a refund' },
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
