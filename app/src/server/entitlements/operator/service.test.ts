import { describe, expect, it } from 'vitest';
import type { OperatorEntitlementRow } from '@/server/billing/v3/operator-access';
import { sourceCatalog } from './contract';
import { handleCommand, readAssignments, type CommandStore, type IdentityCheck, type OperatorEntitlementDeps, type StripeView } from './service';

const USER = '00000000-0000-4000-8000-0000000000a1';
const ACCOUNT = '10000000-0000-4000-8000-0000000000a1';
const T0 = new Date('2026-11-04T12:00:00.000Z');
const later = (ms: number) => new Date(T0.getTime() + ms);
const DAY = 86_400_000;
const REVISION = sourceCatalog().catalog_revision;
const NO_STRIPE: StripeView = { paidAccess: false, productRef: null, state: null, checkoutOpen: false };
let ids = 0;
const id = (n = ++ids) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** In-memory source: the same CommandStore contract store.ts implements on PostgreSQL. */
function harness(options: { identity?: IdentityCheck; stripe?: StripeView } = {}) {
    const rows: OperatorEntitlementRow[] = [];
    const events = new Map<string, { payloadSha256: string; result: unknown; senderKid: string; reason: string; operatorActor: string }>();
    const state = { now: T0, identity: options.identity ?? 'ok' as IdentityCheck, stripe: options.stripe ?? NO_STRIPE, writes: 0 };
    const store: CommandStore = {
        async findEvent(commandId) {
            const e = events.get(commandId);
            return e ? { payloadSha256: e.payloadSha256, result: structuredClone(e.result) as never } : null;
        },
        async assignments(userId) { return rows.filter(r => r.userId === userId).map(r => ({ ...r })).sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime()); },
        async insertAssignment(row) {
            if (rows.some(r => r.userId === row.userId && r.endedAt === null)) throw new Error('one live assignment');
            rows.push({ ...row }); state.writes++;
        },
        async updateAssignment(ref, expected, next) {
            const row = rows.find(r => r.ref === ref && r.revision === expected && r.endedAt === null);
            if (!row) return false;
            Object.assign(row, next); state.writes++;
            return true;
        },
        async closeLapsed(ref, endedAt) { const row = rows.find(r => r.ref === ref && r.endedAt === null); if (row) { row.endedAt = endedAt; state.writes++; } },
        async insertEvent(event) {
            if (events.has(event.commandId)) throw new Error('duplicate command_id');
            events.set(event.commandId, { payloadSha256: event.payloadSha256, result: structuredClone(event.result), senderKid: event.senderKid,
                reason: event.reason, operatorActor: event.operatorActor });
            state.writes++;
        },
    };
    const deps: OperatorEntitlementDeps = {
        now: () => state.now, newId: () => id(),
        identity: async () => state.identity, stripe: async () => state.stripe,
        readAssignments: userId => store.assignments(userId),
        withCommand: (_command, _user, run) => run(store),
    };
    return { deps, rows, events, state };
}

const command = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    format: 'ezil.admin-entitlement-command.v1', command_id: id(), action: 'assign', producer: 'ezil-os', scope: 'individual',
    operator: { via: 'auth0_operator', actor: '00000000-0000-4000-8000-000000000001', email: 'operator@example.test' },
    product: { ref: 'standard_monthly_v3', catalog_revision: REVISION },
    target: { kind: 'individual', os_user_id: USER, account_public_id: ACCOUNT },
    quantity: null, starts_at: null, validity: { ends_at: later(30 * DAY).toISOString() }, reason: 'Synthetic: staging access', assignment: null,
    billing_effect: 'none', credit_option: 'none', ...over,
});
const run = (h: ReturnType<typeof harness>, body: Record<string, unknown>) => handleCommand(h.deps, body, String(body.command_id), 'test-ae-1');
const resultKeys = ['format', 'command_id', 'outcome', 'refusal', 'assignment', 'effective_access', 'provisioning', 'credit_status', 'audit_receipt'];

describe('ezil-os commands: assign, change, end', () => {
    it('assign writes one operator grant and one audit event, and reports operator Standard access', async () => {
        const h = harness();
        const body = command();
        const result = await run(h, body);
        expect(Object.keys(result).sort()).toEqual([...resultKeys].sort());
        expect(result).toMatchObject({ outcome: 'applied', refusal: null, provisioning: { state: 'not_applicable' }, credit_status: { state: 'not_requested' },
            effective_access: { state: 'active', product_ref: 'standard_monthly_v3', via: 'operator' },
            assignment: { revision: 1, producer: 'ezil-os', scope: 'individual', product_ref: 'standard_monthly_v3', quantity: null,
                target: { kind: 'individual', os_user_id: USER, account_public_id: ACCOUNT }, starts_at: T0.toISOString(),
                ends_at: later(30 * DAY).toISOString(), until_revoked: false, state: 'active' } });
        expect(result.assignment!.ref).toMatch(/^osg-[0-9a-f-]{36}$/);
        expect(result.audit_receipt).toEqual({ ref: expect.stringMatching(/^os-audit-[0-9a-f-]{36}$/), at: T0.toISOString() });
        expect(h.rows).toHaveLength(1);
        expect(h.events.get(String(body.command_id))).toMatchObject({ senderKid: 'test-ae-1', reason: 'Synthetic: staging access',
            operatorActor: '00000000-0000-4000-8000-000000000001' });
        // The operator email is not stored (minimisation).
        expect(JSON.stringify([...h.events.values()].map(e => ({ ...e, result: undefined })))).not.toContain('operator@example.test');
    });

    it('the same command again replays the stored result; the same id with another payload is payload_mismatch', async () => {
        const h = harness();
        const body = command();
        const first = await run(h, body);
        h.state.now = later(60_000);
        expect(await run(h, body)).toEqual({ ...first, outcome: 'replayed' });
        expect(await run(h, { ...body, reason: 'Another reason' })).toMatchObject({ outcome: 'refused', refusal: { code: 'payload_mismatch' }, assignment: null });
        expect(h.rows).toHaveLength(1);
        expect(h.events.size).toBe(1);
    });

    it('a lost reply resent after a later change still replays the original result, never re-applies it', async () => {
        const h = harness();
        const assign = command();
        const applied = await run(h, assign);
        await run(h, command({ action: 'change', product: { ref: 'premium_monthly_v3', catalog_revision: REVISION }, validity: null,
            assignment: { ref: applied.assignment!.ref, expected_revision: 1 } }));
        expect(await run(h, assign)).toEqual({ ...applied, outcome: 'replayed' });
        expect(h.rows).toHaveLength(1);
        expect(h.rows[0]).toMatchObject({ sku: 'premium_monthly_v3', revision: 2 });
    });

    it('until_revoked, change to Premium with a later end, then end: revisions 1 → 2 → 3, access follows', async () => {
        const h = harness();
        const a = await run(h, command({ validity: { until_revoked: true } }));
        expect(a.assignment).toMatchObject({ ends_at: null, until_revoked: true, state: 'active' });
        const c = await run(h, command({ action: 'change', product: { ref: 'premium_monthly_v3', catalog_revision: REVISION },
            validity: { ends_at: later(10 * DAY).toISOString() }, assignment: { ref: a.assignment!.ref, expected_revision: 1 } }));
        expect(c).toMatchObject({ outcome: 'applied', assignment: { revision: 2, product_ref: 'premium_monthly_v3', ends_at: later(10 * DAY).toISOString() },
            effective_access: { state: 'active', product_ref: 'premium_monthly_v3', via: 'operator' } });
        h.state.now = later(DAY);
        const e = await run(h, command({ action: 'end', product: null, validity: null, assignment: { ref: a.assignment!.ref, expected_revision: 2 } }));
        expect(e).toMatchObject({ outcome: 'applied', assignment: { revision: 3, state: 'ended', ends_at: later(DAY).toISOString() },
            effective_access: { state: 'none', product_ref: null, via: null } });
        expect(h.rows[0]!.endedAt).toEqual(later(DAY));
    });

    it('a stale revision, an unknown or foreign assignment, and an ended one are refused with nothing written', async () => {
        const h = harness();
        const a = await run(h, command());
        const writes = h.state.writes;
        const end = (over: Record<string, unknown>) => run(h, command({ action: 'end', product: null, validity: null, ...over }));
        expect(await end({ assignment: { ref: a.assignment!.ref, expected_revision: 2 } })).toMatchObject({ refusal: { code: 'stale_revision' } });
        expect(await end({ assignment: { ref: 'osg-00000000-0000-4000-8000-00000000dead', expected_revision: 1 } })).toMatchObject({ refusal: { code: 'assignment_not_found' } });
        expect(await end({ assignment: { ref: a.assignment!.ref, expected_revision: 1 },
            target: { kind: 'individual', os_user_id: USER, account_public_id: '10000000-0000-4000-8000-0000000000b2' } })).toMatchObject({ refusal: { code: 'assignment_not_found' } });
        expect(h.state.writes).toBe(writes);
        await end({ assignment: { ref: a.assignment!.ref, expected_revision: 1 } });
        expect(await end({ assignment: { ref: a.assignment!.ref, expected_revision: 2 } })).toMatchObject({ refusal: { code: 'invalid_command' } });
    });

    it('one live assignment per account; a lapsed one is closed at its end before a new assign', async () => {
        const h = harness();
        const first = await run(h, command({ validity: { ends_at: later(DAY).toISOString() } }));
        expect(await run(h, command())).toMatchObject({ refusal: { code: 'invalid_command' } });
        h.state.now = later(2 * DAY);
        const second = await run(h, command({ validity: { ends_at: later(40 * DAY).toISOString() } }));
        expect(second).toMatchObject({ outcome: 'applied', effective_access: { via: 'operator', product_ref: 'standard_monthly_v3' } });
        expect(h.rows.find(r => r.ref === first.assignment!.ref)!.endedAt).toEqual(later(DAY));
        expect(h.rows.filter(r => r.endedAt === null)).toHaveLength(1);
    });

    it.each([
        ['Free', { product: { ref: 'free_v3', catalog_revision: REVISION } }, 'product_not_assignable'],
        ['an unknown product', { product: { ref: 'team_standard', catalog_revision: REVISION } }, 'product_not_assignable'],
        ['a stale catalog revision', { product: { ref: 'standard_monthly_v3', catalog_revision: 'v3.2026-11-04' } }, 'catalog_revision_mismatch'],
        ['a scheduled start', { starts_at: later(301_000).toISOString() }, 'invalid_command'],
        ['a back-dated start', { starts_at: later(-301_000).toISOString() }, 'invalid_command'],
        ['an end in the past', { validity: { ends_at: later(-1000).toISOString() } }, 'invalid_command'],
        ['a malformed command', { quantity: 2 }, 'invalid_command'],
    ])('assign refuses %s with nothing written', async (_name, over, code) => {
        const h = harness();
        expect(await run(h, command(over))).toMatchObject({ outcome: 'refused', refusal: { code }, assignment: null, audit_receipt: null });
        expect(h.state.writes).toBe(0);
    });

    it('a start within ±300 s is kept as sent', async () => {
        const h = harness();
        expect(await run(h, command({ starts_at: later(-299_000).toISOString() }))).toMatchObject({ assignment: { starts_at: later(-299_000).toISOString() } });
    });

    it.each([['identity_not_found'], ['ambiguous_identity']] as const)('%s refuses before anything is read or written', async identity => {
        const h = harness({ identity, stripe: { paidAccess: true, productRef: 'premium_monthly_v3', state: 'active', checkoutOpen: false } });
        const result = await run(h, command());
        expect(result).toMatchObject({ outcome: 'refused', refusal: { code: identity }, effective_access: { state: 'none' } });
        expect(h.state.writes).toBe(0);
        expect(await readAssignments(h.deps, { kind: 'individual', os_user_id: USER, account_public_id: ACCOUNT })).toBeNull();
    });
});

describe('ezil-os commands never replace Stripe', () => {
    const paid: StripeView = { paidAccess: true, productRef: 'standard_monthly_v3', state: 'active', checkoutOpen: false };
    it('paid access refuses an assign with paid_subscription_conflict and reports via stripe; nothing written', async () => {
        const h = harness({ stripe: paid });
        expect(await run(h, command())).toMatchObject({ outcome: 'refused', refusal: { code: 'paid_subscription_conflict' },
            effective_access: { state: 'active', product_ref: 'standard_monthly_v3', via: 'stripe' } });
        expect(h.state.writes).toBe(0);
    });
    it('an incomplete Stripe checkout refuses too', async () => {
        const h = harness({ stripe: { ...NO_STRIPE, state: 'incomplete', checkoutOpen: true } });
        expect(await run(h, command())).toMatchObject({ refusal: { code: 'paid_subscription_conflict' }, effective_access: { state: 'none' } });
    });
    it('once Stripe pays, a change that gives more is refused, but shortening and ending still work', async () => {
        const h = harness();
        const a = await run(h, command({ validity: { ends_at: later(20 * DAY).toISOString() } }));
        h.state.stripe = paid;
        const change = (over: Record<string, unknown>, revision: number) => run(h, command({ action: 'change', product: null, validity: null,
            assignment: { ref: a.assignment!.ref, expected_revision: revision }, ...over }));
        expect(await change({ product: { ref: 'premium_monthly_v3', catalog_revision: REVISION } }, 1)).toMatchObject({ refusal: { code: 'paid_subscription_conflict' } });
        expect(await change({ validity: { until_revoked: true } }, 1)).toMatchObject({ refusal: { code: 'paid_subscription_conflict' } });
        expect(await change({ validity: { ends_at: later(30 * DAY).toISOString() } }, 1)).toMatchObject({ refusal: { code: 'paid_subscription_conflict' } });
        // Paid wins in the answer while both exist.
        const shorter = await change({ validity: { ends_at: later(5 * DAY).toISOString() } }, 1);
        expect(shorter).toMatchObject({ outcome: 'applied', assignment: { revision: 2 }, effective_access: { via: 'stripe' } });
        expect(await change({ validity: { ends_at: later(5 * DAY).toISOString() } }, 2)).toMatchObject({ refusal: { code: 'invalid_command' } });
        expect(await run(h, command({ action: 'end', product: null, validity: null, assignment: { ref: a.assignment!.ref, expected_revision: 2 } })))
            .toMatchObject({ outcome: 'applied', assignment: { state: 'ended' } });
    });
    it('assignments shows the operator grant and the Stripe state side by side, paid winning', async () => {
        const h = harness();
        await run(h, command());
        h.state.stripe = paid;
        const view = await readAssignments(h.deps, { kind: 'individual', os_user_id: USER, account_public_id: ACCOUNT });
        expect(view).toMatchObject({ format: 'ezil.product-source-assignments.v1', effective_access: { via: 'stripe', product_ref: 'standard_monthly_v3' },
            stripe: { state: 'active', product_ref: 'standard_monthly_v3' }, assignments: [{ state: 'active', product_ref: 'standard_monthly_v3' }] });
        h.state.stripe = NO_STRIPE;
        expect(await readAssignments(h.deps, { kind: 'individual', os_user_id: USER, account_public_id: ACCOUNT }))
            .toMatchObject({ effective_access: { via: 'operator' }, stripe: null });
    });
});
