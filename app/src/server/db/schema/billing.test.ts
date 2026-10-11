import { readFileSync } from 'node:fs';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import * as billing from './billing';

const migration = readFileSync(new URL('../../../../drizzle/0003_billing.sql', import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../../../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
const tables = Object.values(billing).map(getTableConfig);
const tableNames = tables.map((table) => table.name).sort();
const appendOnlyNames = [billing.billingGrants, billing.billingStorageSamples]
    .map((table) => getTableConfig(table).name);

/**
 * Split SQL without mistaking a function body's semicolons for top-level
 * statements. Comments cannot satisfy a guard, and an extra statement cannot
 * hide behind the migration runner's optional statement breakpoints.
 */
function statements(sql: string): string[] {
    const tokens = sql.match(/--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|\$\$[\s\S]*?\$\$|'(?:''|[^'])*'|"(?:""|[^"])*"|;|[^;'"$/-]+|[\s\S]/g) ?? [];
    const result: string[] = [];
    let current = '';
    for (const token of tokens) {
        if (token.startsWith('--') || token.startsWith('/*')) {
            current += ' ';
        } else if (token === ';') {
            if (current.trim()) result.push(current.trim());
            current = '';
        } else {
            current += token;
        }
    }
    if (current.trim()) result.push(current.trim());
    return result;
}

/** The same contract checks run on the real SQL and deliberately broken copies. */
function assertBillingMigration(sql: string): void {
    const parsed = statements(sql);
    const namesFor = (pattern: RegExp) => parsed.flatMap((statement) => {
        const match = statement.match(pattern);
        return match ? [match[1]] : [];
    }).sort();

    expect(namesFor(/^CREATE TABLE "([^"]+)"\s*\(/i)).toEqual(tableNames);
    expect(namesFor(/^ALTER TABLE "([^"]+)" ENABLE ROW LEVEL SECURITY$/i)).toEqual(tableNames);
    expect(namesFor(/^CREATE POLICY "[^"]+"\s+ON "([^"]+)" FOR ALL USING \(auth\.role\(\) = 'service_role'\)$/i))
        .toEqual(tableNames);

    for (const name of appendOnlyNames) {
        for (const [events, scope] of [['UPDATE OR DELETE', 'ROW'], ['TRUNCATE', 'STATEMENT']]) {
            const pattern = new RegExp(`^CREATE TRIGGER "[^"]+"\\s+BEFORE ${events} ON "${name}"\\s+FOR EACH ${scope} EXECUTE FUNCTION "public"\\."ezil_billing_refuse_mutation"\\(\\)$`, 'i');
            expect(parsed.filter((statement) => pattern.test(statement)), `${name}: ${events}`).toHaveLength(1);
        }
    }

    const functions = parsed.filter((statement) => /^CREATE FUNCTION/i.test(statement));
    expect(functions).toHaveLength(1);
    expect(functions[0]).toMatch(/^CREATE FUNCTION "public"\."ezil_billing_refuse_mutation"\(\)\s+RETURNS trigger\s+LANGUAGE plpgsql\s+AS \$\$\s+BEGIN\s+RAISE EXCEPTION '% is append-only: % is forbidden', TG_TABLE_NAME, TG_OP;\s+END;\s+\$\$$/i);

    for (const statement of parsed) {
        if (/\bDROP\b/i.test(statement)) throw new Error('Destructive DROP statement');
        if (statement === functions[0]) continue;
        const target = statement.match(/^(?:CREATE TABLE|ALTER TABLE) "([^"]+)"/i)
            ?? statement.match(/^CREATE (?:UNIQUE INDEX|POLICY|TRIGGER) "[^"]+"\s+(?:BEFORE (?:UPDATE OR DELETE|TRUNCATE)\s+)?ON "([^"]+)"/i);
        if (!target || !tableNames.includes(target[1])) {
            throw new Error('Statement targets something outside the billing tables');
        }
        if (/^ALTER TABLE/i.test(statement)) {
            expect(statement).toMatch(/^ALTER TABLE "[^"]+" (?:ENABLE ROW LEVEL SECURITY|ADD CONSTRAINT "[^"]+" FOREIGN KEY \("[^"]+"\) REFERENCES "(?:auth|public)"\."(?:users|ezil_computers)"\("id"\) ON DELETE cascade ON UPDATE cascade)$/i);
        }
    }
}

describe('billing schema and migration 0003', () => {
    it('exports exactly the seven contract tables and applies the migration guards to those names', () => {
        expect(tableNames).toEqual([
            'ezil_billing_customers',
            'ezil_billing_events',
            'ezil_billing_grants',
            'ezil_billing_outbox',
            'ezil_billing_storage_samples',
            'ezil_billing_subscriptions',
            'ezil_billing_usage_intervals',
        ]);
        assertBillingMigration(migration);
    });

    it('keeps RLS and explicitly named cascading auth ownership in both schema and SQL', () => {
        for (const table of tables) {
            expect(table.enableRLS).toBe(true);
            const fk = table.foreignKeys.find((key) => key.getName() === `${table.name}_user_id_fkey`);
            expect(fk).toBeDefined();
            expect(fk?.onDelete).toBe('cascade');
            expect(fk?.onUpdate).toBe('cascade');
            const reference = fk!.reference();
            expect(reference.columns.map((column) => column.name)).toEqual(['user_id']);
            expect(getTableConfig(reference.foreignTable)).toMatchObject({ name: 'users', schema: 'auth' });
            expect(reference.foreignColumns.map((column) => column.name)).toEqual(['id']);
            expect(migration).toContain(`ALTER TABLE "${table.name}" ADD CONSTRAINT "${table.name}_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE cascade;`);
        }
    });

    it('preserves bigint precision and the grant, byte and retry constraints', () => {
        for (const column of [billing.billingGrants.amount, billing.billingStorageSamples.bytes]) {
            expect(column.dataType).toBe('bigint');
            expect(column.mapFromDriverValue('9007199254740993')).toBe(BigInt('9007199254740993'));
            expect(column.notNull).toBe(true);
        }
        expect(migration).toContain('UNIQUE("source_type","source_id","meter","kind")');
        expect(migration).toContain('UNIQUE("event_key")');
        expect(migration).toContain('UNIQUE("stripe_customer_id")');
        expect(migration).toContain('CHECK ("ezil_billing_storage_samples"."bytes" >= 0)');
        expect(migration).toContain("in ('workspace_seconds', 'ai_usd_micro')");
        expect(migration).toContain("in ('pro_period', 'topup', 'revoke', 'suspend', 'restore')");
        expect(migration).toContain("in ('invoice', 'payment_intent', 'refund', 'dispute')");
        expect(billing.billingOutbox.attempts.default).toBe(0);
        expect(billing.billingSubscriptions.cancelAtPeriodEnd.default).toBe(false);
    });

    it('allows only one open interval per computer while retaining its computer FK', () => {
        const config = getTableConfig(billing.billingUsageIntervals);
        expect(config.indexes).toHaveLength(1);
        expect(config.indexes[0].config.unique).toBe(true);
        expect(migration).toContain('CREATE UNIQUE INDEX "ezil_billing_usage_intervals_open_computer_uidx" ON "ezil_billing_usage_intervals" USING btree ("computer_id") WHERE "ezil_billing_usage_intervals"."ended_at" is null;');
        expect(migration).toContain('FOREIGN KEY ("computer_id") REFERENCES "public"."ezil_computers"("id")');
        // The inbox must accept an event before ownership is resolved; the
        // actual funding and metering rows must always have an owner.
        expect(billing.billingEvents.userId.notNull).toBe(false);
        expect(billing.billingGrants.userId.notNull).toBe(true);
    });

    it('registers migration 3 and preserves all pre-existing snapshot tables', () => {
        expect(journal.entries.filter((entry: { idx: number }) => entry.idx === 3)).toEqual([
            expect.objectContaining({ idx: 3, tag: '0003_billing', version: '7', breakpoints: true }),
        ]);
        const previous = JSON.parse(readFileSync(new URL('../../../../drizzle/meta/0002_snapshot.json', import.meta.url), 'utf8'));
        const current = JSON.parse(readFileSync(new URL('../../../../drizzle/meta/0003_snapshot.json', import.meta.url), 'utf8'));
        expect(current.prevId).toBe(previous.id);
        for (const [name, table] of Object.entries(previous.tables)) {
            expect(current.tables[name]).toEqual(table);
        }
        expect(Object.keys(current.tables).filter((name) => !(name in previous.tables)).sort())
            .toEqual(tableNames.map((name) => `public.${name}`));
    });

    it.each([
        ['a missing table', (sql: string) => sql.replace('CREATE TABLE "ezil_billing_events"', 'CREATE TABLE "unexpected_events"')],
        ['disabled RLS', (sql: string) => sql.replace('ENABLE ROW LEVEL SECURITY', 'DISABLE ROW LEVEL SECURITY')],
        ['an authenticated policy', (sql: string) => sql.replace("auth.role() = 'service_role'", "auth.role() = 'authenticated'")],
        ['a missing row guard', (sql: string) => sql.replace('BEFORE UPDATE OR DELETE', 'BEFORE UPDATE')],
        ['a missing truncate guard', (sql: string) => sql.replace('BEFORE TRUNCATE', 'AFTER TRUNCATE')],
        ['a non-raising function', (sql: string) => sql.replace("RAISE EXCEPTION '% is append-only: % is forbidden', TG_TABLE_NAME, TG_OP;", 'RETURN NULL;')],
    ])('rejects %s with the unmodified migration as a positive control', (_name, mutate) => {
        assertBillingMigration(migration);
        expect(() => assertBillingMigration(mutate(migration))).toThrow();
    });

    it.each([
        'DROP TABLE "ezil_billing_events";',
        'ALTER TABLE "ezil_computers" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "unrelated_table" ADD COLUMN "billing" text;',
        'CREATE TABLE "unrelated_table" ("id" integer);',
        'DELETE FROM "unrelated_table";',
    ])('rejects unrelated or destructive SQL: %s', (extra) => {
        assertBillingMigration(migration);
        expect(() => assertBillingMigration(`${migration}\n${extra}`)).toThrow();
    });
});
