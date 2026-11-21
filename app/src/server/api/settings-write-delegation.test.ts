import { initTRPC } from '@trpc/server';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ getDeps: vi.fn(), billing: vi.fn(), balance: vi.fn(), switchSize: vi.fn(), update: vi.fn(), touched: vi.fn() }));

vi.mock('@/server/billing/deps', () => ({ getBillingDeps: h.getDeps }));
vi.mock('./mcp-identity-bootstrap', async () => {
    const { z } = await import('zod');
    return { mcpIdentityProof: z.object({}), completeMcpConnection: vi.fn() };
});
vi.mock('./routers/account-ai-balance', () => ({ readSettingsAiBalance: h.balance }));
vi.mock('@/server/billing/v2/compute-access', () => ({ loadComputeBillingState: h.billing }));
vi.mock('./routers/compute-dispatch', () => ({ switchComputerConfiguration: h.switchSize }));
vi.mock('./trpc', () => {
    const t = initTRPC.context<{ user: { id: string }; db: unknown }>().create();
    return { createTRPCRouter: t.router, protectedProcedure: t.procedure, publicProcedure: t.procedure };
});

import {
    ONBOARDING_DELEGATION_POLICY, onboardingDelegationBinding, onboardingMutationPath,
} from './onboarding-delegation';
import { accountRouter } from './routers/account';
import { SETTINGS_WRITE_PROCEDURE } from './settings-write-delegation';

const owner = '11111111-1111-4111-8111-111111111111';
const stranger = '22222222-2222-4222-8222-222222222222';
const mine = '33333333-3333-4333-8333-333333333333';
const theirs = '44444444-4444-4444-8444-444444444444';
const gone = '55555555-5555-4555-8555-555555555555';
const key = '66666666-6666-4666-8666-666666666666';

type Row = { id: string; userId: string; name: string; slot: number; deletedAt: Date | null };
let rows: Row[];
const dialect = new PgDialect();
/** Evaluates a drizzle owner filter over the fake rows: every bound parameter must be this row's id or owner. */
function matching(where: Parameters<PgDialect['sqlToQuery']>[0]) {
    const query = dialect.sqlToQuery(where);
    const live = /"deleted_at" is null/.test(query.sql);
    return rows.filter(row => query.params.every(param => param === row.id || param === row.userId) && (!live || !row.deletedAt));
}
const fakeDb = {
    query: { computers: {
        findFirst: vi.fn(async ({ where }: { where: never }) => matching(where)[0]),
        findMany: vi.fn(async ({ where, columns }: { where: never; columns: Record<string, true> }) =>
            matching(where).map(row => Object.fromEntries(Object.keys(columns).map(column => [column, row[column as keyof Row]])))),
    } },
    update: () => ({ set: (values: { name: string }) => ({ where: (where: never) => ({ returning: async () => {
        h.update(values);
        const hit = matching(where);
        for (const row of hit) row.name = values.name;
        return hit.map(row => ({ id: row.id }));
    } }) }) }),
};
/** Any use at all is recorded: a handler that touches the database for plan.sku is caught here. */
const untouchedDb = new Proxy({}, { get: (_target, property) => { h.touched(property); throw new Error('database touched'); } });

const delegated = (procedure = SETTINGS_WRITE_PROCEDURE, userId = owner) => ({
    status: 'accepted', call: { jti: key, clientId: 'registered-client', userId, procedure },
});
const caller = (opts: { procedure?: string; userId?: string; db?: unknown; delegation?: unknown } = {}) => accountRouter.createCaller({
    user: { id: opts.userId ?? owner }, db: opts.db ?? fakeDb,
    ...('delegation' in opts ? (opts.delegation === undefined ? {} : { delegation: opts.delegation })
        : { delegation: delegated(opts.procedure, opts.userId) }),
} as never);
const write = (id: string, value: string, computerId?: string, extra: object = {}) =>
    ({ id, value, ...(computerId ? { computerId } : {}), idempotencyKey: key, ...extra }) as never;
const refusedAs = (id: string, reason: string) => ({ id, status: 'refused', value: null, reason, confirmUrl: null });

beforeEach(() => {
    vi.stubEnv('EZIL_DELEGATED_ONBOARDING', 'enabled');
    vi.stubEnv('EZIL_DELEGATED_SETTINGS_WRITE', 'enabled');
    vi.stubEnv('EZIL_DELEGATION_ISSUER', 'https://connect-staging.ezil.work');
    vi.stubEnv('EZIL_DELEGATION_AUDIENCE', 'https://os-staging.ezil.work');
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    rows = [
        { id: mine, userId: owner, name: 'Desktop', slot: 1, deletedAt: null },
        { id: theirs, userId: stranger, name: 'Theirs', slot: 1, deletedAt: null },
        { id: gone, userId: owner, name: 'Deleted', slot: 2, deletedAt: new Date('2026-11-01T00:00:00Z') },
    ];
    for (const spy of [h.update, h.touched, fakeDb.query.computers.findFirst, fakeDb.query.computers.findMany]) spy.mockClear();
    h.balance.mockReset().mockResolvedValue(null);
    h.billing.mockReset().mockResolvedValue({
        planSku: 'standard_monthly_v3',
        summary: { version: 3, computer: { machineChoice: [{ size: 'free-cf' }, { size: 'std-2' }] } },
        window: { start: '2026-11-01T00:00:00Z', end: '2026-12-01T00:00:00Z' },
        usedStdSeconds: 0, allowanceStdSeconds: 100,
    });
    h.getDeps.mockReset().mockReturnValue({ now: () => new Date('2026-11-21T00:00:00Z'), aiCredits: { receiptsFor: async () => [] } });
    h.switchSize.mockReset().mockResolvedValue({ ok: true, effective: 'switching', current: 'free-cf', target: 'std-2', transitionId: 't1' });
});
afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

describe('account.mcpSetSetting gate', () => {
    it('is reachable only by the delegated owner for this procedure while the write gate is open', async () => {
        const input = write('computer.name', 'Renamed', mine);
        // Positive control: the same call succeeds when everything is open.
        await expect(caller().mcpSetSetting(input)).resolves.toMatchObject({ status: 'applied' });
        expect(h.update).toHaveBeenCalledTimes(1);
        h.update.mockClear();
        rows[0]!.name = 'Desktop';

        const refusals: [string, ReturnType<typeof caller>][] = [
            ['a cookie session', caller({ delegation: undefined })],
            ['a rejected assertion', caller({ delegation: { status: 'rejected' } })],
            ['another procedure', caller({ procedure: 'account.mcpSettings' })],
            ['another owner', caller({ delegation: delegated(SETTINGS_WRITE_PROCEDURE, stranger) })],
        ];
        for (const [, refused] of refusals) await expect(refused.mcpSetSetting(input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        expect(h.update).not.toHaveBeenCalled();
        expect(rows[0]!.name).toBe('Desktop');
    });

    it('reads the write gate per request and refuses unless it is exactly enabled', async () => {
        const input = write('computer.name', 'Renamed', mine);
        for (const value of ['', 'disabled', 'ENABLED', 'true', '1']) {
            vi.stubEnv('EZIL_DELEGATED_SETTINGS_WRITE', value);
            await expect(caller().mcpSetSetting(input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        }
        vi.unstubAllEnvs();
        for (const [name, setting] of [['EZIL_DELEGATED_ONBOARDING', 'enabled'], ['EZIL_DELEGATION_ISSUER', 'https://connect-staging.ezil.work'],
            ['EZIL_DELEGATION_AUDIENCE', 'https://os-staging.ezil.work']] as const) vi.stubEnv(name, setting);
        // The write gate alone, without the onboarding gate or with it closed, is not enough either.
        await expect(caller().mcpSetSetting(input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        vi.stubEnv('EZIL_DELEGATED_SETTINGS_WRITE', 'enabled');
        vi.stubEnv('EZIL_DELEGATED_ONBOARDING', 'disabled');
        await expect(caller().mcpSetSetting(input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        expect(h.update).not.toHaveBeenCalled();
        // The same process opens again the moment the gates do.
        vi.stubEnv('EZIL_DELEGATED_ONBOARDING', 'enabled');
        await expect(caller().mcpSetSetting(input)).resolves.toMatchObject({ status: 'applied' });
    });

    it('answers a closed gate before it reads the input', async () => {
        vi.stubEnv('EZIL_DELEGATED_SETTINGS_WRITE', 'disabled');
        await expect(caller().mcpSetSetting({ nonsense: true } as never)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        vi.stubEnv('EZIL_DELEGATED_SETTINGS_WRITE', 'enabled');
        await expect(caller().mcpSetSetting({ nonsense: true } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('takes exactly {id, value, computerId?, idempotencyKey: uuid} and nothing else', async () => {
        await expect(caller().mcpSetSetting(write('computer.name', 'Fine', mine))).resolves.toMatchObject({ status: 'applied' });
        for (const bad of [
            write('computer.name', 'Fine', mine, { extra: 1 }), write('computer.name', 'Fine', mine, { idempotencyKey: 'not-a-uuid' }),
            write('computer.name', 'Fine', mine, { idempotencyKey: undefined }), write('computer.colour', 'red', mine),
            write('computer.name', 'Fine', 'not-a-uuid'), { id: 'computer.name', idempotencyKey: key, computerId: mine },
            write('computer.name', 'Fine', mine, { value: 5 }),
        ]) await expect(caller().mcpSetSetting(bad)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        expect(h.update).toHaveBeenCalledTimes(1);
    });
});

describe('computer.name', () => {
    const mcpSettings = () => caller({ procedure: 'account.mcpSettings' }).mcpSettings({});

    it('renames a live owned computer and the next account.mcpSettings read returns that name', async () => {
        expect((await mcpSettings()).computers).toEqual([{ id: mine, name: 'Desktop', slot: 1 }]);
        expect(await caller().mcpSetSetting(write('computer.name', '  Studio  ', mine)))
            .toEqual({ id: 'computer.name', status: 'applied', value: 'Studio', reason: null, confirmUrl: null });
        expect(h.update).toHaveBeenCalledWith({ name: 'Studio' });
        expect((await mcpSettings()).computers).toEqual([{ id: mine, name: 'Studio', slot: 1 }]);
        expect(rows.find(row => row.id === theirs)!.name).toBe('Theirs');
    });

    it('returns unchanged without a write for the same name, after the trim', async () => {
        for (const value of ['Desktop', ' Desktop ']) {
            expect(await caller().mcpSetSetting(write('computer.name', value, mine)))
                .toEqual({ id: 'computer.name', status: 'unchanged', value: 'Desktop', reason: null, confirmUrl: null });
        }
        expect(h.update).not.toHaveBeenCalled();
        expect(await caller().mcpSetSetting(write('computer.name', 'Desktop 2', mine))).toMatchObject({ status: 'applied' });
        expect(h.update).toHaveBeenCalledTimes(1);
    });

    it('keeps the 1 to 200 character rule of computer.rename, counted after the trim', async () => {
        const longest = 'n'.repeat(200);
        expect(await caller().mcpSetSetting(write('computer.name', ` ${longest} `, mine))).toMatchObject({ status: 'applied', value: longest });
        for (const value of ['', '   ', '\n\t', 'n'.repeat(201)]) {
            expect(await caller().mcpSetSetting(write('computer.name', value, mine))).toEqual(refusedAs('computer.name', 'invalid_value'));
        }
        expect(await caller().mcpSetSetting(write('computer.name', 'x', mine))).toMatchObject({ status: 'applied', value: 'x' });
        expect(h.update).toHaveBeenCalledTimes(2);
        expect(rows[0]!.name).toBe('x');
    });

    it('refuses a foreign, soft-deleted, unknown or unaddressed computer without writing', async () => {
        for (const computerId of [theirs, gone, '77777777-7777-4777-8777-777777777777']) {
            expect(await caller().mcpSetSetting(write('computer.name', 'Taken', computerId))).toEqual(refusedAs('computer.name', 'computer_not_found'));
        }
        expect(await caller().mcpSetSetting(write('computer.name', 'Taken'))).toEqual(refusedAs('computer.name', 'invalid_value'));
        expect(h.update).not.toHaveBeenCalled();
        expect(rows.map(row => row.name)).toEqual(['Desktop', 'Theirs', 'Deleted']);
        // Positive control: the owner reaches the same row that the stranger could not.
        expect(await caller({ userId: stranger, delegation: delegated(SETTINGS_WRITE_PROCEDURE, stranger) })
            .mcpSetSetting(write('computer.name', 'Mine now', theirs))).toMatchObject({ status: 'applied' });
        expect(rows[1]!.name).toBe('Mine now');
    });
});

describe('computer.size', () => {
    const resolved = (effective: string, current: string, target: string) => ({ ok: true, effective, current, target, transitionId: 't1' });

    it('switches through switchComputerConfiguration with the idempotency key as the request id', async () => {
        expect(await caller().mcpSetSetting(write('computer.size', 'std-2', mine)))
            .toEqual({ id: 'computer.size', status: 'pending', value: 'std-2', reason: null, confirmUrl: null });
        expect(h.switchSize).toHaveBeenCalledTimes(1);
        expect(h.switchSize).toHaveBeenCalledWith(fakeDb, { userId: owner, computerId: mine }, { size: 'std-2', requestId: key });
        expect(rows[0]!.name).toBe('Desktop');
        expect(h.update).not.toHaveBeenCalled();
    });

    it('reports a switch that waits for the next start as applied, and the size already in use as unchanged', async () => {
        h.switchSize.mockResolvedValueOnce(resolved('next_start', 'free-cf', 'std-2'));
        expect(await caller().mcpSetSetting(write('computer.size', 'std-2', mine))).toMatchObject({ status: 'applied', value: 'std-2' });
        h.switchSize.mockResolvedValueOnce(resolved('next_start', 'std-2', 'std-2'));
        expect(await caller().mcpSetSetting(write('computer.size', 'std-2', mine))).toMatchObject({ status: 'unchanged', value: 'std-2' });
    });

    it('offers only a size in the same allowedComputerSizes that account.mcpSettings reports', async () => {
        const reported = (await caller({ procedure: 'account.mcpSettings' }).mcpSettings({})).entitlements.allowedComputerSizes;
        expect(reported).toEqual(['free-cf', 'std-2']);
        for (const size of reported!) {
            expect(await caller().mcpSetSetting(write('computer.size', size, mine))).toMatchObject({ status: 'pending', value: size });
        }
        const calls = h.switchSize.mock.calls.length;
        for (const size of ['cmp-4', 'cmp-8']) {
            expect(await caller().mcpSetSetting(write('computer.size', size, mine))).toEqual(refusedAs('computer.size', 'size_not_allowed'));
        }
        expect(h.switchSize).toHaveBeenCalledTimes(calls);
        // A v2 plan reports its one entitled size, and the write follows it.
        h.billing.mockResolvedValue({ ...(await h.billing()), summary: { version: 2 }, entitledSize: 'cmp-4' });
        expect((await caller({ procedure: 'account.mcpSettings' }).mcpSettings({})).entitlements.allowedComputerSizes).toEqual(['cmp-4']);
        expect(await caller().mcpSetSetting(write('computer.size', 'cmp-4', mine))).toMatchObject({ status: 'pending' });
        expect(await caller().mcpSetSetting(write('computer.size', 'std-2', mine))).toEqual(refusedAs('computer.size', 'size_not_allowed'));
        expect(h.switchSize).toHaveBeenCalledTimes(calls + 1);
    });

    it('fails closed when the account sizes cannot be read', async () => {
        h.billing.mockRejectedValue(new Error('billing store unavailable'));
        expect(await caller().mcpSetSetting(write('computer.size', 'std-2', mine))).toEqual(refusedAs('computer.size', 'size_not_allowed'));
        expect(h.switchSize).not.toHaveBeenCalled();
        h.billing.mockResolvedValue({ summary: { version: 3, computer: { machineChoice: [{ size: 'std-2' }] } } });
        expect(await caller().mcpSetSetting(write('computer.size', 'std-2', mine))).toMatchObject({ status: 'pending' });
    });

    it('returns an unknown size or a missing computer as a value before anything is switched', async () => {
        for (const value of ['gpu-9', '', 'STD-2', 'std-2 ', 'cmp-16']) {
            expect(await caller().mcpSetSetting(write('computer.size', value, mine))).toEqual(refusedAs('computer.size', 'invalid_value'));
        }
        expect(await caller().mcpSetSetting(write('computer.size', 'std-2'))).toEqual(refusedAs('computer.size', 'invalid_value'));
        for (const computerId of [theirs, gone]) {
            expect(await caller().mcpSetSetting(write('computer.size', 'std-2', computerId))).toEqual(refusedAs('computer.size', 'computer_not_found'));
        }
        expect(h.switchSize).not.toHaveBeenCalled();
        expect(h.getDeps).not.toHaveBeenCalled();
        expect(await caller().mcpSetSetting(write('computer.size', 'std-2', mine))).toMatchObject({ status: 'pending' });
        expect(h.switchSize).toHaveBeenCalledTimes(1);
    });

    it('relays the switch refusals as section 6 reasons', async () => {
        const table = {
            foreign_computer: 'computer_not_found', not_entitled: 'size_not_allowed', aws_monthly_cap: 'size_not_allowed',
            computer_busy: 'computer_busy', switch_in_progress: 'computer_busy', capacity_unavailable: 'computer_busy',
        };
        for (const [from, reason] of Object.entries(table)) {
            h.switchSize.mockResolvedValueOnce({ ok: false, reason: from });
            expect(await caller().mcpSetSetting(write('computer.size', 'std-2', mine))).toEqual(refusedAs('computer.size', reason));
        }
    });
});

describe('plan.sku', () => {
    it('returns the upgrade-sheet confirmation link for each plan and touches nothing', async () => {
        for (const sku of ['standard', 'premium', 'compute', 'pro']) {
            const output = await caller({ db: untouchedDb }).mcpSetSetting(write('plan.sku', sku));
            expect(output).toEqual({
                id: 'plan.sku', status: 'confirmation_required', value: sku, reason: null,
                confirmUrl: `https://os-staging.ezil.work/os?settings=billing&upgrade=${sku}`,
            });
            const link = new URL(output.confirmUrl!);
            expect(link.pathname).toBe('/os');
            expect([...link.searchParams]).toEqual([['settings', 'billing'], ['upgrade', sku]]);
        }
        // No billing dependency, billing state, switch or database access of any kind.
        expect(h.getDeps).not.toHaveBeenCalled();
        expect(h.billing).not.toHaveBeenCalled();
        expect(h.switchSize).not.toHaveBeenCalled();
        expect(h.touched).not.toHaveBeenCalled();
        expect(h.update).not.toHaveBeenCalled();
        // Positive control: the spies are live, the size write on the same setup does reach them.
        await caller().mcpSetSetting(write('computer.size', 'std-2', mine));
        expect(h.getDeps).toHaveBeenCalled();
        expect(h.billing).toHaveBeenCalled();
        expect(h.switchSize).toHaveBeenCalled();
        await expect(caller({ db: untouchedDb }).mcpSetSetting(write('computer.name', 'x', mine))).rejects.toThrow('database touched');
        expect(h.touched).toHaveBeenCalled();
    });

    it('refuses an unknown plan or an addressed computer as invalid_value', async () => {
        for (const value of ['free', 'standard_monthly_v3', 'Standard', '', 'enterprise']) {
            expect(await caller({ db: untouchedDb }).mcpSetSetting(write('plan.sku', value))).toEqual(refusedAs('plan.sku', 'invalid_value'));
        }
        expect(await caller({ db: untouchedDb }).mcpSetSetting(write('plan.sku', 'pro', mine))).toEqual(refusedAs('plan.sku', 'invalid_value'));
        expect(h.touched).not.toHaveBeenCalled();
        expect(await caller({ db: untouchedDb }).mcpSetSetting(write('plan.sku', 'pro'))).toMatchObject({ status: 'confirmation_required' });
    });
});

describe('delegation policy entries', () => {
    const line = (method: string, procedure = SETTINGS_WRITE_PROCEDURE, body = '{"json":{"id":"plan.sku"}}') => ({
        method, url: `https://os-staging.ezil.work/api/trpc/${procedure}`, hasBody: method === 'POST', editorBody: Buffer.from(body),
    });

    it('admits account.mcpSetSetting as a signed mutation under ezil:settings:write and nothing wider', () => {
        expect(SETTINGS_WRITE_PROCEDURE).toBe('account.mcpSetSetting');
        expect(ONBOARDING_DELEGATION_POLICY.scopeByProcedure.get(SETTINGS_WRITE_PROCEDURE)).toBe('ezil:settings:write');
        expect(ONBOARDING_DELEGATION_POLICY.scopeByProcedure.get('computer.createNamed')).toBe('ezil:computers:create');
        expect(ONBOARDING_DELEGATION_POLICY.scopeByProcedure.get('account.mcpSettings')).toBe('ezil:settings:read');
        expect(ONBOARDING_DELEGATION_POLICY.scopeByProcedure.size).toBe(3);
        expect(onboardingMutationPath(new URL('https://os-staging.ezil.work/api/trpc/account.mcpSetSetting'))).toBe(true);
        expect(onboardingMutationPath(new URL('https://os-staging.ezil.work/api/trpc/account.mcpSetSettings'))).toBe(false);
        expect(onboardingDelegationBinding(line('POST'))).toEqual({
            procedure: SETTINGS_WRITE_PROCEDURE, serializedInput: '{"json":{"id":"plan.sku"}}', type: 'mutation',
        });
        expect(onboardingDelegationBinding(line('GET'))).toBeUndefined();
        expect(onboardingDelegationBinding(line('POST', 'account.mcpSettings'))).toBeUndefined();
    });
});
