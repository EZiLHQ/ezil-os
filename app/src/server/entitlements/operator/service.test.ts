import { describe, expect, it } from 'vitest';
import type { OperatorEntitlementRow } from '@/server/billing/v3/operator-access';
import { addCalendarMonthUtc } from '@/server/billing/v3/trial';
import { sourceCatalog } from './contract';
import { handleCommand, readAssignments, type CommandStore, type IdentityCheck, type OperatorEntitlementDeps, type StripeView } from './service';

const USER = '00000000-0000-4000-8000-0000000000a1';
const ACCOUNT = '10000000-0000-4000-8000-0000000000a1';
const T0 = new Date('2026-11-04T12:00:00.000Z');
const later = (ms: number) => new Date(T0.getTime() + ms);
const DAY = 86_400_000;
// The server-computed one-calendar-month end from T0 (2026-12-04T12:00:00.000Z); equals later(30 * DAY) for November.
const MONTH_END = addCalendarMonthUtc(T0);
const REVISION = sourceCatalog().catalog_revision;
const NO_STRIPE: StripeView = { paidAccess: false, computeActive: false, productRef: null, state: null, checkoutOpen: false };
let ids = 0;
const id = (n = ++ids) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** In-memory source: the same CommandStore contract store.ts implements on PostgreSQL. */
function harness(options: { identity?: IdentityCheck; stripe?: StripeView } = {}) {
    const rows: OperatorEntitlementRow[] = [];
    const events = new Map<string, { payloadSha256: string; result: unknown; senderKid: string; reason: string; operatorActor: string }>();
    const state = { now: T0, identity: options.identity ?? 'ok' as IdentityCheck, stripe: options.stripe ?? NO_STRIPE, accessWrites: 0 };
    const store: CommandStore = {
        async withAccessTransaction(run) {
            const savedRows = structuredClone(rows), savedEvents = structuredClone([...events]), savedWrites = state.accessWrites;
            const result = await run();
            if (result.outcome === 'refused') {
                rows.splice(0, rows.length, ...savedRows);
                events.clear();
                for (const [key, value] of savedEvents) events.set(key, value);
                state.accessWrites = savedWrites;
            }
            return result;
        },
        async findEvent(commandId) {
            const e = events.get(commandId);
            return e ? { payloadSha256: e.payloadSha256, result: structuredClone(e.result) as never } : null;
        },
        async assignments(userId) { return rows.filter(r => r.userId === userId).map(r => ({ ...r })).sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime()); },
        async insertAssignment(row) {
            if (rows.some(r => r.userId === row.userId && r.endedAt === null)) throw new Error('one live assignment');
            rows.push({ ...row }); state.accessWrites++;
        },
        async updateAssignment(ref, expected, next) {
            const row = rows.find(r => r.ref === ref && r.revision === expected && r.endedAt === null);
            if (!row) return false;
            Object.assign(row, next); state.accessWrites++;
            return true;
        },
        async closeLapsed(ref, now) { const row = rows.find(r => r.ref === ref && r.endedAt === null); if (row && row.endsAt && row.endsAt <= now) { row.endedAt = row.endsAt; state.accessWrites++; } },
        async insertEvent(event) {
            if (events.has(event.commandId)) throw new Error('duplicate command_id');
            events.set(event.commandId, { payloadSha256: event.payloadSha256, result: structuredClone(event.result), senderKid: event.senderKid,
                reason: event.reason, operatorActor: event.operatorActor });
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

    it('until-revoked is refused; a Standard→Premium change preserves the period end; then end stops access (rev 1 → 2 → 3)', async () => {
        const h = harness();
        // until-revoked is no longer a supported validity: an operator plan runs one calendar month.
        expect(await run(h, command({ validity: { until_revoked: true } }))).toMatchObject({ outcome: 'refused', refusal: { code: 'invalid_command' }, assignment: null });
        expect(h.state.accessWrites).toBe(0);
        // Positive control: a valid one-calendar-month assign applies and stores the computed end.
        const a = await run(h, command());
        expect(a.assignment).toMatchObject({ revision: 1, ends_at: MONTH_END.toISOString(), until_revoked: false, state: 'active' });
        // A product change (Standard → Premium, no validity) preserves the one-month period end.
        const c = await run(h, command({ action: 'change', product: { ref: 'premium_monthly_v3', catalog_revision: REVISION },
            validity: null, assignment: { ref: a.assignment!.ref, expected_revision: 1 } }));
        expect(c).toMatchObject({ outcome: 'applied', assignment: { revision: 2, product_ref: 'premium_monthly_v3', ends_at: MONTH_END.toISOString() },
            effective_access: { state: 'active', product_ref: 'premium_monthly_v3', via: 'operator' } });
        // A change that carries any validity is refused: the period is fixed; use end to stop access early.
        expect(await run(h, command({ action: 'change', product: null, validity: { ends_at: later(10 * DAY).toISOString() },
            assignment: { ref: a.assignment!.ref, expected_revision: 2 } }))).toMatchObject({ outcome: 'refused', refusal: { code: 'invalid_command' } });
        h.state.now = later(DAY);
        const e = await run(h, command({ action: 'end', product: null, validity: null, assignment: { ref: a.assignment!.ref, expected_revision: 2 } }));
        expect(e).toMatchObject({ outcome: 'applied', assignment: { revision: 3, state: 'ended', ends_at: later(DAY).toISOString() },
            effective_access: { state: 'none', product_ref: null, via: null } });
        expect(h.rows[0]!.endedAt).toEqual(later(DAY));
    });

    it('a stale revision, an unknown or foreign assignment, and an ended one are refused without access writes', async () => {
        const h = harness();
        const a = await run(h, command());
        const writes = h.state.accessWrites;
        const end = (over: Record<string, unknown>) => run(h, command({ action: 'end', product: null, validity: null, ...over }));
        expect(await end({ assignment: { ref: a.assignment!.ref, expected_revision: 2 } })).toMatchObject({ refusal: { code: 'stale_revision' } });
        expect(await end({ assignment: { ref: 'osg-00000000-0000-4000-8000-00000000dead', expected_revision: 1 } })).toMatchObject({ refusal: { code: 'assignment_not_found' } });
        expect(await end({ assignment: { ref: a.assignment!.ref, expected_revision: 1 },
            target: { kind: 'individual', os_user_id: USER, account_public_id: '10000000-0000-4000-8000-0000000000b2' } })).toMatchObject({ refusal: { code: 'assignment_not_found' } });
        expect(h.state.accessWrites).toBe(writes);
        await end({ assignment: { ref: a.assignment!.ref, expected_revision: 1 } });
        expect(await end({ assignment: { ref: a.assignment!.ref, expected_revision: 2 } })).toMatchObject({ refusal: { code: 'invalid_command' } });
    });

    it('one live assignment per account; after the month expires, access recomputes to Free and a reassign starts a fresh month (no auto-renew)', async () => {
        const h = harness();
        const first = await run(h, command());
        expect(first.assignment).toMatchObject({ ends_at: MONTH_END.toISOString() });
        // A second assign while the first is live is refused.
        expect(await run(h, command())).toMatchObject({ refusal: { code: 'invalid_command' } });
        // Advance past the one-calendar-month end: access recomputes to none (Free) with nothing deleted, no renewal.
        h.state.now = new Date(MONTH_END.getTime() + DAY);
        expect((await readAssignments(h.deps, { kind: 'individual', os_user_id: USER, account_public_id: ACCOUNT }))!.effective_access)
            .toMatchObject({ state: 'none', product_ref: null, via: null });
        // Reassigning starts a NEW one-calendar-month period and closes the lapsed grant at its own end.
        const freshEnd = addCalendarMonthUtc(h.state.now);
        const second = await run(h, command({ validity: { ends_at: freshEnd.toISOString() } }));
        expect(second).toMatchObject({ outcome: 'applied', effective_access: { via: 'operator', product_ref: 'standard_monthly_v3' },
            assignment: { ends_at: freshEnd.toISOString() } });
        expect(h.rows.find(r => r.ref === first.assignment!.ref)!.endedAt).toEqual(MONTH_END);
        expect(h.rows.filter(r => r.endedAt === null)).toHaveLength(1);
    });

    it.each([
        ['Free', { product: { ref: 'free_v3', catalog_revision: REVISION } }, 'product_not_assignable'],
        ['an unknown product', { product: { ref: 'team_standard', catalog_revision: REVISION } }, 'product_not_assignable'],
        ['a stale catalog revision', { product: { ref: 'standard_monthly_v3', catalog_revision: 'v3.2026-11-04' } }, 'catalog_revision_mismatch'],
        ['a scheduled start', { starts_at: later(301_000).toISOString() }, 'invalid_command'],
        ['a back-dated start', { starts_at: later(-301_000).toISOString() }, 'invalid_command'],
        ['until-revoked', { validity: { until_revoked: true } }, 'invalid_command'],
        ['a malformed command', { quantity: 2 }, 'invalid_command'],
    ])('assign refuses %s without access writes', async (_name, over, code) => {
        const h = harness();
        expect(await run(h, command(over))).toMatchObject({ outcome: 'refused', refusal: { code }, assignment: null, audit_receipt: null });
        expect(h.state.accessWrites).toBe(0);
    });

    it('a start within ±300 s is normalized to server now', async () => {
        const h = harness();
        expect(await run(h, command({ starts_at: later(-299_000).toISOString() }))).toMatchObject({ assignment: { starts_at: T0.toISOString() } });
    });

    it.each([['identity_not_found'], ['ambiguous_identity']] as const)('%s refuses before anything is read or written', async identity => {
        const h = harness({ identity, stripe: { paidAccess: true, computeActive: true, productRef: 'premium_monthly_v3', state: 'active', checkoutOpen: false } });
        const result = await run(h, command());
        expect(result).toMatchObject({ outcome: 'refused', refusal: { code: identity }, effective_access: { state: 'none' } });
        expect(h.state.accessWrites).toBe(0);
        expect(await readAssignments(h.deps, { kind: 'individual', os_user_id: USER, account_public_id: ACCOUNT })).toBeNull();
    });
});

describe('ezil-os commands never replace Stripe', () => {
    const paid: StripeView = { paidAccess: true, computeActive: true, productRef: 'standard_monthly_v3', state: 'active', checkoutOpen: false };
    it('paid access refuses an assign with paid_subscription_conflict and reports via stripe; no access writes', async () => {
        const h = harness({ stripe: paid });
        expect(await run(h, command())).toMatchObject({ outcome: 'refused', refusal: { code: 'paid_subscription_conflict' },
            effective_access: { state: 'active', product_ref: 'standard_monthly_v3', via: 'stripe' } });
        expect(h.state.accessWrites).toBe(0);
    });
    it('an incomplete Stripe checkout refuses too', async () => {
        const h = harness({ stripe: { ...NO_STRIPE, state: 'incomplete', checkoutOpen: true } });
        expect(await run(h, command())).toMatchObject({ refusal: { code: 'paid_subscription_conflict' }, effective_access: { state: 'none' } });
    });
    it('once Stripe pays, a product upgrade is refused; any validity change is refused; ending still works', async () => {
        const h = harness();
        const a = await run(h, command());
        h.state.stripe = paid;
        const change = (over: Record<string, unknown>, revision: number) => run(h, command({ action: 'change', product: null, validity: null,
            assignment: { ref: a.assignment!.ref, expected_revision: revision }, ...over }));
        // A product upgrade gives more and is refused while Stripe covers the account; paid wins in the answer.
        expect(await change({ product: { ref: 'premium_monthly_v3', catalog_revision: REVISION } }, 1)).toMatchObject({ refusal: { code: 'paid_subscription_conflict' },
            effective_access: { via: 'stripe' } });
        // Any validity in a change is refused outright (the period is fixed) — a structural refusal, before the paid conflict.
        expect(await change({ validity: { ends_at: later(5 * DAY).toISOString() } }, 1)).toMatchObject({ refusal: { code: 'invalid_command' } });
        expect(await change({ validity: { until_revoked: true } }, 1)).toMatchObject({ refusal: { code: 'invalid_command' } });
        // Ending always works, even while paid.
        expect(await run(h, command({ action: 'end', product: null, validity: null, assignment: { ref: a.assignment!.ref, expected_revision: 1 } })))
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

describe('ezil-os operator plans run one source-defined calendar month', () => {
    const paid: StripeView = { paidAccess: true, computeActive: true, productRef: 'standard_monthly_v3', state: 'active', checkoutOpen: false };

    it.each([
        ['a clock-skewed end', new Date(MONTH_END.getTime() + 200_000)],
        ['an end in the past', later(-1000)],
        ['a forged far-future end', new Date(MONTH_END.getTime() + 365 * DAY)],
        ['a forged short end', later(DAY)],
    ])('ignores %s on the frozen v1 wire and stores only the server-computed one-calendar-month end', async (_name, sent) => {
        const h = harness();
        const r = await run(h, command({ validity: { ends_at: sent.toISOString() } }));
        expect(r).toMatchObject({ outcome: 'applied', assignment: { starts_at: T0.toISOString(), ends_at: MONTH_END.toISOString() } });
        expect(h.rows[0]!.endsAt).toEqual(MONTH_END);
    });

    it.each([
        // Sender start just before midnight, server start just after: the computed end follows the server, never the sender.
        ['30 Jan 23:59:59.5 sender vs 31 Jan 00:00:00.4 server (→ 28 Feb)', '2026-01-30T23:59:59.500Z', '2026-01-31T00:00:00.400Z'],
        ['28 Jan sender vs 29 Jan server, non-leap', '2026-01-28T23:59:59.500Z', '2026-01-29T00:00:00.400Z'],
        ['30 Mar sender vs 31 Mar server (→ 30 Apr)', '2026-03-30T23:59:59.500Z', '2026-03-31T00:00:00.400Z'],
    ])('a start across midnight applies (%s) and stores the clamped server end', async (_name, senderStart, serverNow) => {
        const h = harness();
        h.state.now = new Date(serverNow);
        const senderEnd = addCalendarMonthUtc(new Date(senderStart));
        const r = await run(h, command({ starts_at: senderStart, validity: { ends_at: senderEnd.toISOString() } }));
        const canonical = addCalendarMonthUtc(new Date(serverNow));
        expect(r).toMatchObject({ outcome: 'applied', assignment: { starts_at: new Date(serverNow).toISOString(), ends_at: canonical.toISOString() } });
        expect(h.rows[0]!.endsAt).toEqual(canonical);
    });

    it('a first attempt that was never stored can be retried with the same frozen body more than 5 min later', async () => {
        const h = harness();
        const body = command();   // frozen at T0: starts_at null, ends_at = the sender's T0 + one month hint
        // The first delivery was lost before the source stored anything; the identical body arrives 6 min later.
        h.state.now = later(6 * 60_000);
        expect(h.events.size).toBe(0);
        const r = await run(h, body);
        const canonical = addCalendarMonthUtc(h.state.now);
        expect(r).toMatchObject({ outcome: 'applied', assignment: { starts_at: h.state.now.toISOString(), ends_at: canonical.toISOString() } });
        expect(h.rows[0]!.endsAt).toEqual(canonical);
        // That stored result then replays unchanged.
        h.state.now = later(20 * 60_000);
        expect(await run(h, body)).toEqual({ ...r, outcome: 'replayed' });
    });

    it('a stored refusal replays as that refusal, not as a fresh evaluation', async () => {
        const h = harness({ stripe: { ...NO_STRIPE, state: 'incomplete', checkoutOpen: true } });
        const body = command();
        const first = await run(h, body);
        expect(first).toMatchObject({ outcome: 'refused', refusal: { code: 'paid_subscription_conflict' } });
        h.state.stripe = NO_STRIPE;
        h.state.now = later(6 * 60_000);
        expect(await run(h, body)).toEqual(first);
        expect(h.rows).toHaveLength(0);
    });

    it('a stored result replays unchanged later, even across a month boundary', async () => {
        const h = harness();
        const body = command();
        const first = await run(h, body);
        h.state.now = new Date(MONTH_END.getTime() + 2 * DAY);
        expect(await run(h, body)).toEqual({ ...first, outcome: 'replayed' });
        expect(h.rows[0]!.endsAt).toEqual(MONTH_END);
        expect(h.rows).toHaveLength(1);
    });

    it('clamps the one-calendar-month period to month end (31 Jan → 28 Feb)', async () => {
        const h = harness();
        const jan31 = new Date('2026-01-31T20:00:00.000Z');
        h.state.now = jan31;
        const r = await run(h, command({ starts_at: jan31.toISOString(), validity: { ends_at: '2026-02-28T20:00:00.000Z' } }));
        expect(r).toMatchObject({ outcome: 'applied', assignment: { starts_at: jan31.toISOString(), ends_at: '2026-02-28T20:00:00.000Z' } });
        expect(h.rows[0]!.endsAt).toEqual(new Date('2026-02-28T20:00:00.000Z'));
    });

    it('clamps to 29 Feb in a leap year (31 Jan 2028 → 29 Feb 2028)', async () => {
        const h = harness();
        h.state.now = new Date('2028-01-31T20:00:00.000Z');
        const r = await run(h, command({ validity: { ends_at: '2028-03-02T20:00:00.000Z' } }));
        expect(r).toMatchObject({ outcome: 'applied', assignment: { ends_at: '2028-02-29T20:00:00.000Z' } });
        expect(h.rows[0]!.endsAt).toEqual(new Date('2028-02-29T20:00:00.000Z'));
    });

    it('access holds until the exact stored end and stops at it (read-time expiry, no command needed)', async () => {
        const h = harness();
        await run(h, command());
        const read = async () => (await readAssignments(h.deps, { kind: 'individual', os_user_id: USER, account_public_id: ACCOUNT }))!.effective_access;
        h.state.now = new Date(MONTH_END.getTime() - 1);
        expect(await read()).toMatchObject({ state: 'active', via: 'operator', product_ref: 'standard_monthly_v3' });
        h.state.now = MONTH_END;
        expect(await read()).toMatchObject({ state: 'none', via: null, product_ref: null });
        expect(h.state.accessWrites).toBe(1);   // expiry is read-time: nothing was rewritten or deleted
    });

    it('after the operator month expires, access recomputes to a covering Stripe plan (files untouched)', async () => {
        const h = harness();
        await run(h, command());
        h.state.now = new Date(MONTH_END.getTime() + DAY);   // the operator grant has expired
        h.state.stripe = paid;
        const view = await readAssignments(h.deps, { kind: 'individual', os_user_id: USER, account_public_id: ACCOUNT });
        expect(view!.effective_access).toMatchObject({ state: 'active', product_ref: 'standard_monthly_v3', via: 'stripe' });
    });

    it('preserves a legacy until-revoked grant (null end): it stays in effect and readable', async () => {
        const h = harness();
        // A grant written under the old contract: until-revoked (null end), started long ago. No DB rewrite caps it.
        h.rows.push({ ref: 'osg-legacy-1', revision: 1, userId: USER, accountPublicId: ACCOUNT, sku: 'premium_monthly_v3',
            startsAt: new Date(T0.getTime() - 100 * DAY), endsAt: null, endedAt: null });
        const view = await readAssignments(h.deps, { kind: 'individual', os_user_id: USER, account_public_id: ACCOUNT });
        expect(view!.effective_access).toMatchObject({ state: 'active', product_ref: 'premium_monthly_v3', via: 'operator' });
        expect(view!.assignments[0]).toMatchObject({ until_revoked: true, ends_at: null, state: 'active' });
    });
});
