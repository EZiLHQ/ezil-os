import { describe, expect, it } from 'vitest';
import type { OperatorEntitlementRow } from '@/server/billing/v3/operator-access';
import { createOperatorEntitlementDeps, readOperatorEntitlements, SourceUnavailable, type Executor, type TransactionalExecutor } from './store';

// A fake executor that records statement text (nested fragments inlined, parameters as ?) and fails like Postgres when an
// insert names access_override before 0038.
const text = (query: unknown): string => ((query as { queryChunks?: unknown[] }).queryChunks ?? []).map(c => typeof c === 'object' && c && 'queryChunks' in c ? text(c)
    : typeof c === 'object' && c && 'value' in c ? [(c as { value: unknown }).value].flat().join('') : '?').join('');
function fake(options: { failOverride?: unknown; rows?: Record<string, unknown>[] }) {
    const statements: string[] = [];
    let rolledBack = false;
    const tx: Executor = { async execute(query) {
        const sqlText = text(query);
        statements.push(sqlText);
        if (options.failOverride && /INSERT INTO public\.ezil_operator_entitlements [\s\S]*access_override/.test(sqlText)) throw options.failOverride;
        return /^SELECT ref, revision/.test(sqlText) ? options.rows ?? [] : [];
    } };
    const db: TransactionalExecutor = { execute: tx.execute, async transaction(run) {
        try { return await run(tx); } catch (error) { rolledBack = true; throw error; }
    } };
    return { db, statements, rolled: () => rolledBack };
}
const deps = (db: TransactionalExecutor) => createOperatorEntitlementDeps(db, { store: {} as never, config: {} as never });
const row = (over: Partial<OperatorEntitlementRow> = {}): OperatorEntitlementRow => ({ ref: 'osg-1', revision: 1, userId: '00000000-0000-4000-8000-0000000000a1',
    accountPublicId: '10000000-0000-4000-8000-0000000000a1', sku: 'free_v3', startsAt: new Date('2026-11-04T12:00:00Z'), endsAt: null, endedAt: null,
    issuedBy: null, accessOverride: true, ...over });
const pgError = (code: string, message: string) => Object.assign(new Error('Failed query'), { cause: Object.assign(new Error(message), { code }) });
const inserts = (statements: string[]) => statements.filter(s => /INSERT INTO public\.ezil_operator_entitlements /.test(s));
const stored = (over: Record<string, unknown>) => ({ ref: 'osg-1', revision: 1, user_id: '00000000-0000-4000-8000-0000000000a1',
    account_public_id: '10000000-0000-4000-8000-0000000000a1', sku: 'standard_monthly_v3', starts_at: '2026-11-04T12:00:00.000Z', ends_at: null, ended_at: null,
    issued_by: null, access_override: null, ...over });

describe('operator store: explicit access overrides (0038)', () => {
    it('an override insert names access_override (with issued_by only when named); an ordinary insert never does', async () => {
        const f = fake({});
        await deps(f.db).withCommand('c1', 'u1', async run => {
            await run.insertAssignment(row());
            await run.insertAssignment(row({ ref: 'osg-2', issuedBy: 'Acme Labs' }));
            await run.insertAssignment(row({ ref: 'osg-3', sku: 'standard_monthly_v3', accessOverride: undefined }));
            await run.insertAssignment(row({ ref: 'osg-4', sku: 'standard_monthly_v3', accessOverride: false, issuedBy: 'Acme Labs' }));
        });
        const [override, named, plain, labeled] = inserts(f.statements);
        expect(override).toMatch(/ended_at, access_override\)[\s\S]*NULL, true\)/);
        expect(override).not.toMatch(/issued_by/);
        expect(named).toMatch(/issued_by, access_override\)[\s\S]*true\)/);
        expect([plain, labeled].some(s => /access_override/.test(s!))).toBe(false);
        expect(labeled).toMatch(/issued_by\)/);
    });
    it('before 0038, undefined_column on access_override is SourceUnavailable after a rollback; nothing else is written', async () => {
        const f = fake({ failOverride: pgError('42703', 'column "access_override" of relation "ezil_operator_entitlements" does not exist') });
        await expect(deps(f.db).withCommand('c1', 'u1', run => run.insertAssignment(row()))).rejects.toEqual(new SourceUnavailable('access_override'));
        expect(f.rolled()).toBe(true);
        expect(f.statements.some(s => /ezil_operator_entitlement_events/.test(s))).toBe(false);
    });
    it('any other failure of the override insert stays the raw error', async () => {
        for (const error of [pgError('42703', 'column "access_overrides_other" does not exist'), pgError('23505', 'duplicate key value violates unique constraint "ezil_operator_entitlements_one_live_override"')]) {
            const f = fake({ failOverride: error });
            await expect(deps(f.db).withCommand('c1', 'u1', run => run.insertAssignment(row()))).rejects.toBe(error);
        }
    });
    it('the reader reads the flag through to_jsonb and keeps Free only on an override; a pre-0038 row is an ordinary grant', async () => {
        const f = fake({ rows: [
            stored({ ref: 'osg-a', sku: 'free_v3', access_override: 'true' }),
            stored({ ref: 'osg-b', sku: 'premium_monthly_v3', access_override: 'true' }),
            stored({ ref: 'osg-c', access_override: 'false' }),
            stored({ ref: 'osg-d' }),
            stored({ ref: 'osg-e', sku: 'free_v3', access_override: 'false' }),
            stored({ ref: 'osg-f', sku: 'legacy', access_override: 'true' }),
        ] });
        const rows = await readOperatorEntitlements(f.db, '00000000-0000-4000-8000-0000000000a1');
        expect(f.statements[0]).toMatch(/to_jsonb\(e\)->>'access_override' AS access_override/);
        expect(rows.map(r => [r.ref, r.sku, r.accessOverride])).toEqual([['osg-a', 'free_v3', true], ['osg-b', 'premium_monthly_v3', true],
            ['osg-c', 'standard_monthly_v3', undefined], ['osg-d', 'standard_monthly_v3', undefined]]);
        expect(rows.slice(2).every(r => !Object.hasOwn(r, 'accessOverride'))).toBe(true);
    });
});
