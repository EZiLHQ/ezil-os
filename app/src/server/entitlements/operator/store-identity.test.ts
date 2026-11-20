import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { readBillingConfig } from '@/server/billing/config';
import { createOperatorEntitlementDeps, SourceUnavailable, type TransactionalExecutor } from './store';

const USER = '00000000-0000-4000-8000-000000000001';
const ACCOUNT = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-11-20T10:00:00.000Z');
const PRODUCTION = 'https://ai.ezil.work/v1/funding';
const STAGING = 'https://ai-staging.ezil.work/v1/funding';
const TARGET = { kind: 'individual' as const, os_user_id: USER, account_public_id: ACCOUNT };
const NATIVE_READ = "select ezil_ai.os_member_by_auth($1::uuid)->>'public_id' as public_id";
const dialect = new PgDialect();

function fixture(fundingUrl: string, options: {
    users?: Record<string, unknown>[];
    nativeAccount?: string | null;
    nativeError?: { code: string };
    stageRows?: Record<string, unknown>[];
} = {}) {
    const execute = vi.fn(async (query: SQL) => {
        const { sql, params } = dialect.sqlToQuery(query);
        if (sql.includes('FROM auth.users')) {
            expect(params).toEqual([USER]);
            return options.users ?? [{}];
        }
        if (sql.includes('FROM ezil_works.ai_members')) {
            expect(params).toEqual([USER, ACCOUNT]);
            return options.stageRows ?? [];
        }
        throw new Error('Unexpected identity query');
    });
    const nativeExecute = vi.fn(async (query: SQL) => {
        const { sql, params } = dialect.sqlToQuery(query);
        if (sql === 'set local role ezil_os_ai_enroller' || sql === 'set local role none') return [];
        if (sql !== NATIVE_READ) throw new Error('Unexpected native identity query');
        expect(params).toEqual([USER]);
        if (options.nativeError) throw options.nativeError;
        return [{ public_id: options.nativeAccount ?? null }];
    });
    const transactionCalls = vi.fn();
    const transaction: TransactionalExecutor['transaction'] = run => {
        transactionCalls();
        return run({ execute: nativeExecute });
    };
    const deps = createOperatorEntitlementDeps({ execute, transaction }, {
        config: readBillingConfig({ BILLING_FUNDING_URL: fundingUrl }),
        store: {} as never,
    }, () => NOW);
    return { execute, nativeExecute, transaction: transactionCalls, check: () => deps.identity(TARGET) };
}

describe('operator entitlement identity by Gateway member contract', () => {
    it('accepts the exact production pair via the native reader and drops its read role', async () => {
        const db = fixture(PRODUCTION, { nativeAccount: ACCOUNT });
        await expect(db.check()).resolves.toBe('ok');
        expect(db.execute).toHaveBeenCalledOnce();
        expect(db.transaction).toHaveBeenCalledOnce();
        expect(db.nativeExecute.mock.calls.map(([sql]) => dialect.sqlToQuery(sql).sql)).toEqual([
            'set local role ezil_os_ai_enroller',
            NATIVE_READ,
            'set local role none',
        ]);
    });

    it.each([OTHER, null])('refuses a missing or different production account (%s)', async nativeAccount => {
        const db = fixture(PRODUCTION, { nativeAccount });
        await expect(db.check()).resolves.toBe('identity_not_found');
        expect(db.execute).toHaveBeenCalledOnce();
    });

    it.each(['42883', '42501'])('fails closed without the Works view when the native reader errors (%s)', async code => {
        const db = fixture(PRODUCTION, { nativeError: { code } });
        await expect(db.check()).rejects.toBeInstanceOf(SourceUnavailable);
        expect(db.execute).toHaveBeenCalledOnce();
    });

    it.each([
        [],
        [{ deleted_at: '2026-11-19T10:00:00.000Z' }],
        [{ banned_until: '2026-11-21T10:00:00.000Z' }],
        [{ is_anonymous: 'true' }],
    ])('refuses inactive production OS users before opening a native transaction (%j)', async (...users) => {
        const db = fixture(PRODUCTION, { users, nativeAccount: ACCOUNT });
        await expect(db.check()).resolves.toBe('identity_not_found');
        expect(db.transaction).not.toHaveBeenCalled();
    });

    it('preserves the staging lookup and its ambiguity refusal', async () => {
        const linked = { auth_user_id: USER, public_id: ACCOUNT };
        const unique = fixture(STAGING, { stageRows: [linked] });
        await expect(unique.check()).resolves.toBe('ok');
        expect(unique.transaction).not.toHaveBeenCalled();
        const duplicate = fixture(STAGING, { stageRows: [linked, { ...linked, public_id: OTHER }] });
        await expect(duplicate.check()).resolves.toBe('ambiguous_identity');
        expect(duplicate.transaction).not.toHaveBeenCalled();
    });
});
