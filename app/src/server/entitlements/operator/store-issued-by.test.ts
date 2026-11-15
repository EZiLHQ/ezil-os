import { describe, expect, it } from 'vitest';
import type { OperatorEntitlementRow } from '@/server/billing/v3/operator-access';
import { createOperatorEntitlementDeps, SourceUnavailable, type Executor, type TransactionalExecutor } from './store';

// A fake executor that records statement text and fails like Postgres when the labeled insert names a column that is not there.
const text = (query: unknown): string => {
    const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
    return chunks.map(c => (typeof c === 'object' && c && 'value' in c ? [(c as { value: unknown }).value].flat().join('') : '')).join('?');
};
function fake(options: { failLabeled?: unknown }) {
    const statements: string[] = [];
    let rolledBack = false;
    const tx: Executor = { async execute(query) {
        const sqlText = text(query);
        statements.push(sqlText);
        if (options.failLabeled && /INSERT INTO public\.ezil_operator_entitlements [\s\S]*issued_by/.test(sqlText)) throw options.failLabeled;
        return [];
    } };
    const db: TransactionalExecutor = { execute: tx.execute, async transaction(run) {
        try { return await run(tx); } catch (error) { rolledBack = true; throw error; }
    } };
    return { db, statements, rolled: () => rolledBack };
}
const deps = (db: TransactionalExecutor) => createOperatorEntitlementDeps(db, { store: {} as never, config: {} as never });
const row = (issuedBy: string | null): OperatorEntitlementRow => ({ ref: 'osg-1', revision: 1, userId: '00000000-0000-4000-8000-0000000000a1',
    accountPublicId: '10000000-0000-4000-8000-0000000000a1', sku: 'standard_monthly_v3', startsAt: new Date('2026-11-04T12:00:00Z'),
    endsAt: new Date('2026-12-04T12:00:00Z'), endedAt: null, issuedBy });
const pgError = (code: string, message: string, wrap = false) => wrap ? Object.assign(new Error('Failed query'), { cause: Object.assign(new Error(message), { code }) }) : Object.assign(new Error(message), { code });

describe('operator store: the labeled insert before 0023 is applied', () => {
    it.each([['direct', false], ['wrapped in a driver cause', true]])('undefined_column on issued_by (%s) is SourceUnavailable after a rollback, with no partial write', async (_n, wrap) => {
        const f = fake({ failLabeled: pgError('42703', 'column "issued_by" of relation "ezil_operator_entitlements" does not exist', wrap) });
        await expect(deps(f.db).withCommand('c1', 'u1', run => run.insertAssignment(row('Acme Labs')))).rejects.toBeInstanceOf(SourceUnavailable);
        expect(f.rolled()).toBe(true);
        expect(f.statements.filter(s => /INSERT INTO public\.ezil_operator_entitlements /.test(s))).toHaveLength(1);
        expect(f.statements.some(s => /ezil_operator_entitlement_events/.test(s))).toBe(false);
    });
    it('any other failure of the labeled insert, including another undefined column, stays the raw error', async () => {
        for (const error of [pgError('42703', 'column "other_col" does not exist'), pgError('23514', 'violates check constraint "ezil_operator_entitlements_issued_by"'), new Error('boom')]) {
            const f = fake({ failLabeled: error });
            await expect(deps(f.db).withCommand('c1', 'u1', run => run.insertAssignment(row('Acme Labs')))).rejects.toBe(error);
        }
    });
    it('an unlabeled insert never names the column, so the old command still works before 0023', async () => {
        const f = fake({ failLabeled: pgError('42703', 'column "issued_by" does not exist') });
        await deps(f.db).withCommand('c1', 'u1', run => run.insertAssignment(row(null)));
        expect(f.statements.filter(s => /INSERT INTO public\.ezil_operator_entitlements /.test(s)).every(s => !/issued_by/.test(s))).toBe(true);
        expect(f.rolled()).toBe(false);
    });
});
