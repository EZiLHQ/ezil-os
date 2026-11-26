import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { operatorBranchEnabled, operatorEntitlementsInstalled, operatorOverridesInstalled } from './installed';
import { readOperatorEntitlements, type Executor } from './store';
import { paidCloudflareCandidates } from '@/server/lib/compute/placement';
import { readPaidPoolEligibility, readPoolDemand } from '@/server/lib/compute/ready-pool';

const USER = '00000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-11-25T12:00:00Z');
const dialect = new PgDialect();
const missing = Object.assign(new Error('relation missing'), { code: '42P01' });

describe('operator availability holds unknown, supports verified absence', () => {
    it.each([undefined, null, {}, [], { rows: [] }, [{ present: null }], [{ present: 'false' }], [{ present: false }, { present: true }]])(
        'malformed probe %j cannot disable the operator branch or advertise overrides', async result => {
            const db = { execute: vi.fn().mockResolvedValue(result) };
            await expect(operatorBranchEnabled(db)).rejects.toThrow('operator_schema_probe_unavailable');
            await expect(operatorOverridesInstalled(db)).rejects.toThrow('operator_schema_probe_unavailable');
        });
    it('verified absence is distinct from failure; negatives are never reused and do not leak between executors', async () => {
        const db = { execute: vi.fn().mockResolvedValueOnce([{ present: false }]).mockResolvedValueOnce({ rows: [{ present: true }] })
            .mockRejectedValueOnce(new Error('probe offline')) };
        expect(await operatorEntitlementsInstalled(db)).toBe(false);
        expect(await operatorBranchEnabled(db)).toBe(true);
        await expect(operatorBranchEnabled(db)).rejects.toThrow('probe offline');
        expect(await operatorBranchEnabled({ execute: async () => [{ present: false }] })).toBe(false);
    });
    it.each(['eligibility', 'demand', 'discovery'])('%s never executes legacy paid SQL after an unknown table probe', async consumer => {
        const db: Executor = { execute: vi.fn(async query => {
            expect(dialect.sqlToQuery(query).sql).toContain("to_regclass('public.ezil_operator_entitlements')");
            throw new Error('table probe offline');
        }) };
        const call = consumer === 'eligibility' ? () => readPaidPoolEligibility(db, USER, NOW)
            : consumer === 'discovery' ? () => paidCloudflareCandidates(db, NOW)
                : () => readPoolDemand(db, { region: 'ap-south-1', zoneId: 'aps1-az1', instanceType: 'm6i.large' }, NOW);
        await expect(call()).rejects.toThrow('table probe offline');
        expect(db.execute).toHaveBeenCalledTimes(1);
    });
    it('a missing-relation read yields no grants only when table absence is independently verified', async () => {
        const db = { execute: vi.fn().mockRejectedValueOnce(missing).mockResolvedValueOnce([{ present: false }]) };
        expect(await readOperatorEntitlements(db, USER)).toEqual([]);
        const present = { execute: vi.fn().mockRejectedValueOnce(missing).mockResolvedValueOnce([{ present: true }]) };
        await expect(readOperatorEntitlements(present, USER)).rejects.toBe(missing);
        const unavailable = { execute: vi.fn().mockRejectedValueOnce(missing).mockRejectedValueOnce(new Error('probe offline')) };
        await expect(readOperatorEntitlements(unavailable, USER)).rejects.toThrow('probe offline');
    });
    it.each([undefined, {}, { rows: null }])('malformed assignment response %j never becomes an empty grant list', async result => {
        await expect(readOperatorEntitlements({ execute: async () => result }, USER)).rejects.toThrow('rows');
    });
    it.each(['42501', '57014', '08006', '42703'])('read failure %s is propagated, never no overrides', async code => {
        const error = Object.assign(new Error('synthetic reader failure'), { code });
        await expect(readOperatorEntitlements({ execute: async () => { throw error; } }, USER)).rejects.toBe(error);
    });
});
