import { readFileSync } from 'node:fs';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import * as billing from './billing';

const migration = readFileSync(new URL('../../../../drizzle/0003_billing.sql', import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../../../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
const v1Tables = [
    billing.billingCustomers, billing.billingEvents, billing.billingGrants, billing.billingOutbox,
    billing.billingStorageSamples, billing.billingSubscriptions, billing.billingUsageIntervals,
];
const tables = v1Tables.map(getTableConfig);
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
    // The guard refuses every UPDATE, DELETE and TRUNCATE, with one exemption:
    // a DELETE whose owning auth.users row is already gone, which is exactly
    // the ON DELETE CASCADE an account deletion produces.
    const guard = functions[0].replace(/--[^\n]*/g, '');
    expect(guard).toMatch(/^CREATE FUNCTION "public"\."ezil_billing_refuse_mutation"\(\)\s+RETURNS trigger\s+LANGUAGE plpgsql\s+AS \$\$\s+BEGIN\s/i);
    expect(guard).toMatch(/IF TG_OP = 'DELETE' AND NOT EXISTS \(\s*SELECT 1 FROM "auth"\."users" WHERE "id" = OLD\."user_id"\s*\) THEN\s+RETURN OLD;\s+END IF;/i);
    expect(guard).toMatch(/RAISE EXCEPTION '% is append-only: % is forbidden', TG_TABLE_NAME, TG_OP;\s+END;\s+\$\$$/i);

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
    it('keeps the seven v1 contract tables and applies the migration guards to those names', () => {
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

const migrationV2 = readFileSync(new URL('../../../../drizzle/0004_billing_v2.sql', import.meta.url), 'utf8');
const v2Tables = [
    billing.billingComputeEpochs, billing.billingOverageConsents, billing.billingOverageInvoices,
    billing.billingPaymentIssues, billing.billingPlanChanges, billing.billingSizePreferences,
].map(getTableConfig);
const v2Names = v2Tables.map(table => table.name).sort();
const grantChecks = {
    meter: `"ezil_billing_grants"."meter" in ('workspace_seconds', 'ai_usd_micro', 'compute_std_seconds')`,
    kind: `"ezil_billing_grants"."kind" in ('pro_period', 'topup', 'revoke', 'suspend', 'restore', 'plan_period', 'upgrade_prorated')`,
};
const v2Indexes = [
    `CREATE UNIQUE INDEX "ezil_billing_grants_plan_period_uidx" ON "ezil_billing_grants" USING btree ("subscription_id","period_start","meter") WHERE "ezil_billing_grants"."kind" = 'plan_period'`,
    `CREATE UNIQUE INDEX "ezil_billing_compute_epochs_open_computer_uidx" ON "ezil_billing_compute_epochs" USING btree ("computer_id") WHERE "ezil_billing_compute_epochs"."ended_at" is null`,
    `CREATE UNIQUE INDEX "ezil_billing_plan_changes_open_kind_uidx" ON "ezil_billing_plan_changes" USING btree ("subscription_id","kind") WHERE "ezil_billing_plan_changes"."state" in ('pending', 'requires_action', 'payment_failed', 'scheduled')`,
];

function assertBillingV2Migration(sql: string): void {
    const parsed = statements(sql);
    const namesFor = (pattern: RegExp) => parsed.flatMap(statement => {
        const match = statement.match(pattern);
        return match ? [match[1]] : [];
    }).sort();
    expect(namesFor(/^CREATE TABLE "([^"]+)"\s*\(/i)).toEqual(v2Names);
    expect(namesFor(/^ALTER TABLE "([^"]+)" ENABLE ROW LEVEL SECURITY$/i)).toEqual(v2Names);
    expect(namesFor(/^CREATE POLICY "Service role full access [^"]+"\s+ON "([^"]+)" FOR ALL USING \(auth\.role\(\) = 'service_role'\)$/i))
        .toEqual(v2Names);
    expect(parsed.filter(statement => /^CREATE (?:OR REPLACE )?FUNCTION/i.test(statement))).toEqual([]);

    for (const name of v2Names) {
        expect(parsed).toContain(`ALTER TABLE "${name}" ADD CONSTRAINT "${name}_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE cascade`);
        const create = parsed.find(statement => statement.startsWith(`CREATE TABLE "${name}"`))!;
        expect(create).toMatch(/"user_id" uuid (?:PRIMARY KEY )?NOT NULL/);
    }
    expect(parsed).toContain('ALTER TABLE "ezil_billing_compute_epochs" ADD CONSTRAINT "ezil_billing_compute_epochs_computer_id_fkey" FOREIGN KEY ("computer_id") REFERENCES "public"."ezil_computers"("id") ON DELETE cascade ON UPDATE cascade');

    expect(parsed.find(statement => statement.startsWith('CREATE TABLE "ezil_billing_overage_consents"')))
        .toContain('CONSTRAINT "ezil_billing_overage_consents_decision_unique" UNIQUE("user_id","subscription_id","accepted_at","enabled","cap_cents","terms_version","catalog_version","rate_cents_per_std_hour","actor")');
    for (const [events, scope] of [['UPDATE OR DELETE', 'ROW'], ['TRUNCATE', 'STATEMENT']]) {
        const pattern = new RegExp(`^CREATE TRIGGER "[^"]+"\\s+BEFORE ${events} ON "ezil_billing_overage_consents"\\s+FOR EACH ${scope} EXECUTE FUNCTION "public"\\."ezil_billing_refuse_mutation"\\(\\)$`, 'i');
        expect(parsed.filter(statement => pattern.test(statement))).toHaveLength(1);
    }
    const drops = ['meter', 'kind'].map(name => `ALTER TABLE "ezil_billing_grants" DROP CONSTRAINT "ezil_billing_grants_${name}_chk"`);
    const grantAlters = [
        ...drops,
        'ALTER TABLE "ezil_billing_grants" ADD COLUMN "subscription_id" text',
        ...Object.entries(grantChecks).map(([name, value]) => `ALTER TABLE "ezil_billing_grants" ADD CONSTRAINT "ezil_billing_grants_${name}_chk" CHECK (${value})`),
    ];
    expect(parsed.filter(statement => /\bDROP\b/i.test(statement)).sort()).toEqual(drops.sort());
    expect(parsed.filter(statement => statement.startsWith('ALTER TABLE "ezil_billing_grants"')).sort()).toEqual(grantAlters.sort());
    expect(parsed.filter(statement => /^CREATE UNIQUE INDEX/i.test(statement)).sort()).toEqual([...v2Indexes].sort());
    const dialect = new PgDialect();
    for (const table of v2Tables) {
        for (const check of table.checks) {
            if (sessionCheckNames.has(check.name)) continue; // Added in 0005, not 0004.
            expect(sql).toContain(`CONSTRAINT "${check.name}" CHECK (${dialect.sqlToQuery(check.value).sql})`);
        }
    }
    for (const statement of parsed) {
        const target = statement.match(/^(?:CREATE TABLE|ALTER TABLE) "([^"]+)"/i)
            ?? statement.match(/^CREATE (?:UNIQUE INDEX|POLICY|TRIGGER) "[^"]+"\s+(?:BEFORE (?:UPDATE OR DELETE|TRUNCATE)\s+)?ON "([^"]+)"/i);
        if (!target || ![...v2Names, 'ezil_billing_grants'].includes(target[1])) {
            throw new Error('Statement targets something outside the v2 billing tables');
        }
        if (/^ALTER TABLE/i.test(statement) && target[1] !== 'ezil_billing_grants') {
            expect(statement).toMatch(/^ALTER TABLE "[^"]+" (?:ENABLE ROW LEVEL SECURITY|ADD CONSTRAINT "[^"]+" FOREIGN KEY \("[^"]+"\) REFERENCES "(?:auth|public)"\."(?:users|ezil_computers)"\("id"\) ON DELETE cascade ON UPDATE cascade)$/i);
        }
    }
}

describe('billing schema and migration 0004', () => {
    it('adds exactly six tables with service-only RLS, cascading ownership and all SQL guards', () => {
        expect(v2Names).toEqual([
            'ezil_billing_compute_epochs', 'ezil_billing_overage_consents', 'ezil_billing_overage_invoices',
            'ezil_billing_payment_issues', 'ezil_billing_plan_changes', 'ezil_billing_size_preferences',
        ]);
        expect(Object.values(billing).map(table => getTableConfig(table).name).sort()).toEqual([...tableNames, ...v2Names].sort());
        assertBillingV2Migration(migrationV2);
        for (const table of v2Tables) {
            expect(table.enableRLS).toBe(true);
            const fk = table.foreignKeys.find(key => key.getName() === `${table.name}_user_id_fkey`)!;
            expect(fk).toBeDefined();
            expect(fk.onDelete).toBe('cascade');
            expect(fk.onUpdate).toBe('cascade');
            const ref = fk.reference();
            expect(ref.columns.map(column => column.name)).toEqual(['user_id']);
            expect(ref.columns[0].notNull).toBe(true);
            expect(getTableConfig(ref.foreignTable)).toMatchObject({ name: 'users', schema: 'auth' });
            expect(ref.foreignColumns.map(column => column.name)).toEqual(['id']);
        }
    });

    it('uses integer quantities, timezone-aware instants, identity order and partial uniqueness', () => {
        for (const table of v2Tables) {
            for (const column of table.columns) {
                expect(column.getSQLType()).not.toMatch(/numeric|real|double/i);
                if (column.dataType === 'date') expect(column.getSQLType()).toBe('timestamp with time zone');
            }
        }
        expect(billing.billingOverageConsents.id.generatedIdentity?.type).toBe('always');
        expect(billing.billingOverageConsents.id.primary).toBe(true);
        expect(billing.billingOverageInvoices.stdSecondsOver.mapFromDriverValue('9007199254740993')).toBe(BigInt('9007199254740993'));
        expect(billing.billingComputeEpochs.overheadSeconds.default).toBe(0);
        const computerFk = getTableConfig(billing.billingComputeEpochs).foreignKeys
            .find(key => key.getName() === 'ezil_billing_compute_epochs_computer_id_fkey')!;
        expect(computerFk.onDelete).toBe('cascade');
        expect(computerFk.onUpdate).toBe('cascade');
        for (const table of [billing.billingComputeEpochs, billing.billingPlanChanges, billing.billingGrants]) {
            const [index] = getTableConfig(table).indexes;
            expect(index.config.unique).toBe(true);
            expect(index.config.where).toBeDefined();
        }
    });

    it('registers 0004 and carries every previous table unchanged except the three specified grant additions', () => {
        expect(journal.entries.filter((entry: { idx: number }) => entry.idx === 4)).toEqual([
            expect.objectContaining({ idx: 4, tag: '0004_billing_v2', version: '7', when: expect.any(Number), breakpoints: true }),
        ]);
        const previous = JSON.parse(readFileSync(new URL('../../../../drizzle/meta/0003_snapshot.json', import.meta.url), 'utf8'));
        const current = JSON.parse(readFileSync(new URL('../../../../drizzle/meta/0004_snapshot.json', import.meta.url), 'utf8'));
        expect(current.prevId).toBe(previous.id);
        const grants = structuredClone(previous.tables['public.ezil_billing_grants']);
        grants.columns.subscription_id = { name: 'subscription_id', type: 'text', primaryKey: false, notNull: false };
        for (const [name, value] of Object.entries(grantChecks)) {
            grants.checkConstraints[`ezil_billing_grants_${name}_chk`].value = value;
        }
        grants.indexes.ezil_billing_grants_plan_period_uidx = {
            name: 'ezil_billing_grants_plan_period_uidx',
            columns: ['subscription_id', 'period_start', 'meter'].map(expression => ({ expression, isExpression: false, asc: true, nulls: 'last' })),
            isUnique: true, where: `"ezil_billing_grants"."kind" = 'plan_period'`, concurrently: false, method: 'btree', with: {},
        };
        for (const [name, table] of Object.entries(previous.tables)) {
            expect(current.tables[name]).toEqual(name === 'public.ezil_billing_grants' ? grants : table);
        }
        expect(Object.keys(current.tables).filter(name => !(name in previous.tables)).sort()).toEqual(v2Names.map(name => `public.${name}`));
        for (const table of v2Tables) {
            const snapshot = current.tables[`public.${table.name}`];
            expect(snapshot.isRLSEnabled).toBe(true);
            expect(Object.keys(snapshot.columns).sort()).toEqual(table.columns.filter(column => !sessionColumnNames.has(column.name)).map(column => column.name).sort());
            expect(Object.keys(snapshot.checkConstraints).sort()).toEqual(table.checks.filter(check => !sessionCheckNames.has(check.name)).map(check => check.name).sort());
        }
    });

    it.each([
        ['missing table', (sql: string) => sql.replace('CREATE TABLE "ezil_billing_compute_epochs"', 'CREATE TABLE "unexpected"')],
        ['missing RLS', (sql: string) => sql.replace('ENABLE ROW LEVEL SECURITY', 'DISABLE ROW LEVEL SECURITY')],
        ['client policy', (sql: string) => sql.replace("auth.role() = 'service_role'", "auth.role() = 'authenticated'")],
        ['missing user cascade', (sql: string) => sql.replace('ON DELETE cascade', 'ON DELETE restrict')],
        ['missing row trigger', (sql: string) => sql.replace('BEFORE UPDATE OR DELETE', 'BEFORE UPDATE')],
        ['missing truncate trigger', (sql: string) => sql.replace('BEFORE TRUNCATE', 'AFTER TRUNCATE')],
        ['wrong guard function', (sql: string) => sql.replace('EXECUTE FUNCTION "public"."ezil_billing_refuse_mutation"', 'EXECUTE FUNCTION "public"."other"')],
        ['missing grant meter', (sql: string) => sql.replace(", 'compute_std_seconds'", '')],
        ['missing grant kind', (sql: string) => sql.replace(", 'upgrade_prorated'", '')],
        ['missing grant predicate', (sql: string) => sql.replace(` WHERE "ezil_billing_grants"."kind" = 'plan_period'`, '')],
        ['missing epoch predicate', (sql: string) => sql.replace(' WHERE "ezil_billing_compute_epochs"."ended_at" is null', '')],
        ['missing plan predicate', (sql: string) => sql.replace(` WHERE "ezil_billing_plan_changes"."state" in ('pending', 'requires_action', 'payment_failed', 'scheduled')`, '')],
        ['wrong size check', (sql: string) => sql.replace("'free-cf', 'std-2', 'cmp-4', 'cmp-8'", "'std-2'")],
    ])('rejects %s with the original as a positive control', (_name, mutate) => {
        assertBillingV2Migration(migrationV2);
        expect(() => assertBillingV2Migration(mutate(migrationV2))).toThrow();
    });

    it.each([
        'DROP TABLE "ezil_billing_compute_epochs";',
        'ALTER TABLE "ezil_billing_grants" DROP CONSTRAINT "ezil_billing_grants_source_type_chk";',
        'ALTER TABLE "ezil_billing_compute_epochs" DROP COLUMN "size";',
        'ALTER TABLE "ezil_computers" ENABLE ROW LEVEL SECURITY;',
        'CREATE TABLE "unrelated" ("id" integer);',
        'DELETE FROM "unrelated";',
        'CREATE FUNCTION "public"."unexpected"() RETURNS integer LANGUAGE sql AS $$ SELECT 1; $$;',
    ])('rejects extra destructive or unrelated SQL: %s', extra => {
        assertBillingV2Migration(migrationV2);
        expect(() => assertBillingV2Migration(`${migrationV2}\n${extra}`)).toThrow();
    });
});

const sessionColumnNames = new Set(['deadline_at', 'last_heartbeat_at']);
const sessionCheckNames = new Set(['ezil_billing_compute_epochs_deadline_at_chk', 'ezil_billing_compute_epochs_last_heartbeat_at_chk']);

describe('billing schema and migration 0005', () => {
    it('registers 0005 and preserves every 0004 table except two columns, two checks and one index', () => {
        expect(journal.entries.filter((entry: { idx: number }) => entry.idx === 5)).toEqual([
            expect.objectContaining({ idx: 5, tag: '0005_billing_sessions', version: '7', when: expect.any(Number), breakpoints: true }),
        ]);
        const previous = JSON.parse(readFileSync(new URL('../../../../drizzle/meta/0004_snapshot.json', import.meta.url), 'utf8'));
        const current = JSON.parse(readFileSync(new URL('../../../../drizzle/meta/0005_snapshot.json', import.meta.url), 'utf8'));
        expect(current.prevId).toBe(previous.id);
        expect(current.id).not.toBe(previous.id);
        const epochs = structuredClone(previous.tables['public.ezil_billing_compute_epochs']);
        for (const name of sessionColumnNames) {
            epochs.columns[name] = { name, type: 'timestamp with time zone', primaryKey: false, notNull: false };
        }
        const table = getTableConfig(billing.billingComputeEpochs);
        const dialect = new PgDialect();
        const migration = readFileSync(new URL('../../../../drizzle/0005_billing_sessions.sql', import.meta.url), 'utf8');
        const expected = [...sessionColumnNames].map(name => `ALTER TABLE "${table.name}" ADD COLUMN "${name}" timestamp with time zone`);
        const checks = table.checks.filter(check => sessionCheckNames.has(check.name));
        expect(checks).toHaveLength(2);
        for (const check of checks) {
            const value = dialect.sqlToQuery(check.value).sql;
            epochs.checkConstraints[check.name] = { name: check.name, value };
            expected.push(`ALTER TABLE "${table.name}" ADD CONSTRAINT "${check.name}" CHECK (${value})`);
        }
        const name = 'ezil_billing_compute_epochs_open_deadline_idx';
        epochs.indexes[name] = { name,
            columns: [{ expression: 'deadline_at', isExpression: false, asc: true, nulls: 'last' }],
            isUnique: false, where: '"ezil_billing_compute_epochs"."ended_at" is null', concurrently: false, method: 'btree', with: {},
        };
        expected.push(`CREATE INDEX "${name}" ON "${table.name}" USING btree ("deadline_at") WHERE "${table.name}"."ended_at" is null`);
        expect(statements(migration).sort()).toEqual(expected.sort());
        expect(Object.keys(current.tables).sort()).toEqual(Object.keys(previous.tables).sort());
        for (const [name, oldTable] of Object.entries(previous.tables)) {
            expect(current.tables[name]).toEqual(name === 'public.ezil_billing_compute_epochs' ? epochs : oldTable);
        }
        expect(Object.keys(epochs.columns).sort()).toEqual(table.columns.map(column => column.name).sort());
        expect(Object.keys(epochs.checkConstraints).sort()).toEqual(table.checks.map(check => check.name).sort());
        const index = table.indexes.find(index => index.config.name === name)!;
        expect(index.config.unique).toBe(false);
        expect(dialect.sqlToQuery(index.config.where!).sql).toBe(epochs.indexes[name].where);
        expect(index.config.columns.map(column => 'name' in column ? column.name : null)).toEqual(['deadline_at']);
        for (const column of table.columns.filter(column => sessionColumnNames.has(column.name))) {
            expect(column.notNull).toBe(false);
            expect(column.getSQLType()).toBe('timestamp with time zone');
        }
    });
});
