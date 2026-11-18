import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildPlan, EXPLICIT_FILES, parseArgs, run, sha256, TARGETED_APPLY_FILE } from './billing-staging-schema.mjs';
import { NATIVE_PRODUCTION_FILES, NATIVE_SQL_PINS, PRODUCTION_RECEIPT_ONLY_PINS } from './billing-production-native.mjs';

const modeArgs = id => ['--native-production', '--target', 'aws-production', '--expect-system-id', id,
    '--expect-role', 'postgres', '--expect-database', 'postgres'];
const pinOption = '--expect-event-trigger-sha256';
const validPin = '0'.repeat(64);
const legacyFiles = EXPLICIT_FILES.map(file => ({ file, sha256: sha256(readFileSync(new URL('../../' + file, import.meta.url))) }));
const optionalCurrentMain = ['app/drizzle/0024_telemetry_alerts.sql', 'app/drizzle/0025_ai_request_traces.sql'];
const nonce = '00000000-0000-4000-8000-000000000001';

test('native production requires its own exact mode, target, and pins without changing the 0030 selector', () => {
    const apply = ['apply', '--yes', ...modeArgs('123'), pinOption, validPin];
    assert.equal(parseArgs(apply).nativeProduction, true);
    for (const bad of [
        apply.map(value => value === 'aws-production' ? 'aws-preview' : value),
        [...apply, '--only', TARGETED_APPLY_FILE],
        apply.slice(0, -2),
        ['plan', ...modeArgs('123'), pinOption, validPin],
        ['baseline', TARGETED_APPLY_FILE, '--yes', ...modeArgs('123')],
        ['apply', '--yes', '--target', 'aws-production', '--expect-system-id', '123', '--only', NATIVE_PRODUCTION_FILES[0]],
    ]) {
        assert.throws(() => parseArgs(bad));
    }
    assert.equal(parseArgs(['apply', '--yes', '--target', 'aws-production', '--expect-system-id', '123', '--only', TARGETED_APPLY_FILE]).only,
        TARGETED_APPLY_FILE);
});

test('ordinary production receipt validation recognizes exact out-of-band apply receipts without selecting their SQL', () => {
    const receipts = Object.entries(PRODUCTION_RECEIPT_ONLY_PINS).map(([file, sha256]) => ({ file, sha256, mode: 'apply' }));
    const pendingFiles = legacyFiles.filter(({ file }) => !Object.hasOwn(PRODUCTION_RECEIPT_ONLY_PINS, file));
    assert.equal(buildPlan(pendingFiles, receipts, PRODUCTION_RECEIPT_ONLY_PINS).length, pendingFiles.length);
    const currentMainPlan = buildPlan(legacyFiles, receipts, PRODUCTION_RECEIPT_ONLY_PINS);
    const issuer = currentMainPlan.filter(({ file }) => file === receipts[0].file);
    assert.deepEqual(issuer, [{ file: receipts[0].file, sha256: receipts[0].sha256, status: 'applied (apply)' }]);
    assert.throws(() => buildPlan(legacyFiles, receipts), /outside the reviewed list/);
    assert.throws(() => buildPlan(legacyFiles, [{ ...receipts[0], mode: 'baseline' }], PRODUCTION_RECEIPT_ONLY_PINS), /outside the reviewed list/);
    assert.throws(() => buildPlan(legacyFiles, [{ ...receipts[1], sha256: validPin }], PRODUCTION_RECEIPT_ONLY_PINS), /outside the reviewed list/);
});

const containerName = process.env.NATIVE_PRODUCTION_SQL_TEST_CONTAINER;
function exec(args) {
    return spawnSync('docker', ['exec', '-i', containerName, 'psql', '-X', '-U', 'postgres', '-d', 'postgres',
        '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-q', ...args], { encoding: 'utf8' });
}
function sql(statement) {
    const result = exec(['-c', statement]);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}
function invoke(args) {
    const output = [], calls = [], diagnostics = [];
    const rc = run(args, {
        env: { BILLING_STAGING_DATABASE_URL: 'postgres://postgres@127.0.0.1:5432/postgres?sslmode=disable' },
        write: line => output.push(line),
        spawnSyncImpl: (command, parameters, settings) => {
            assert.equal(command, 'psql');
            assert.equal(settings.env.PGHOST, '127.0.0.1');
            assert.equal(settings.env.PGPORT, '5432');
            calls.push(parameters);
            const result = exec(parameters);
            if (result.status !== 0) diagnostics.push(result.stderr);
            return result;
        },
    });
    return { rc, output, calls, diagnostics };
}
function setup() {
    const result = spawnSync('docker', ['inspect', containerName], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const [container] = JSON.parse(result.stdout);
    assert.equal(container.Config.Labels['ezil.purpose'], 'native-production-sql-disposable');
    assert.equal(container.HostConfig.NetworkMode, 'none');
    sql("DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;" +
        "DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;");
    sql('DROP SCHEMA public CASCADE; CREATE SCHEMA public;' +
        'CREATE TABLE public.ezil_computers (id uuid PRIMARY KEY, user_id uuid NOT NULL, slot smallint NOT NULL, deleted_at timestamptz);' +
        'ALTER TABLE public.ezil_computers ENABLE ROW LEVEL SECURITY;');
    for (const file of [...Object.keys(NATIVE_SQL_PINS).slice(0, 2), TARGETED_APPLY_FILE]) {
        sql(readFileSync(new URL('../../' + file, import.meta.url), 'utf8'));
    }
    sql('CREATE TABLE public.ezil_staging_schema_log (file text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), mode text NOT NULL);');
    const historical = Object.entries(PRODUCTION_RECEIPT_ONLY_PINS)[0];
    const receipts = legacyFiles.filter(({ file }) => !file.includes('0012_compute_reverse_moves') &&
        file !== historical[0] && !optionalCurrentMain.includes(file)).concat([{ file: historical[0], sha256: historical[1] }]);
    for (const { file, sha256: digest } of receipts) {
        sql("INSERT INTO public.ezil_staging_schema_log (file,sha256,mode) VALUES ('" + file + "','" + digest + "','apply');");
    }
    sql("INSERT INTO public.ezil_delegation_replay VALUES ('" + nonce + "', now() + interval '1 hour');");
    const id = sql('SELECT system_identifier FROM pg_control_system()');
    const plan = invoke(['plan', ...modeArgs(id)]);
    assert.equal(plan.rc, 0, [...plan.output, ...plan.diagnostics].join('\n'));
    assert.ok(plan.calls[0].includes('SET TRANSACTION READ ONLY;'));
    assert.equal(plan.output.filter(line => line.endsWith('pending native production batch')).length, 4);
    const hash = plan.output[0].split(' ').at(-1);
    assert.match(hash, /^[a-f0-9]{64}$/);
    return { id, hash };
}
const apply = (id, hash) => invoke(['apply', '--yes', ...modeArgs(id), pinOption, hash]);
const receiptSnapshot = () => sql("SELECT jsonb_agg(to_jsonb(t) ORDER BY file) FROM public.ezil_staging_schema_log t WHERE file < 'app/drizzle/0029' OR file='" +
    TARGETED_APPLY_FILE + "';");
const nativeTableCount = () => sql("SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND relname LIKE 'ezil_native_%';");


test('real production-shaped batch preserves 0030 and all older receipts and is idempotent', { skip: !containerName }, () => {
    const { id, hash } = setup();
    for (const { file, sha256: digest } of legacyFiles.filter(({ file }) => optionalCurrentMain.includes(file))) {
        sql("INSERT INTO public.ezil_staging_schema_log (file,sha256,mode) VALUES ('" + file + "','" + digest + "','apply');");
    }
    const withCurrentMain = invoke(['plan', ...modeArgs(id)]);
    assert.equal(withCurrentMain.rc, 0, [...withCurrentMain.output, ...withCurrentMain.diagnostics].join('\n'));
    const replayOid = sql("SELECT 'public.ezil_delegation_replay'::regclass::oid;");
    const legacyBefore = receiptSnapshot();
    const proof = apply(id, hash);
    assert.equal(proof.rc, 0, [...proof.output, ...proof.diagnostics].join('\n'));
    assert.equal(proof.calls.length, 1);
    assert.ok(proof.calls[0].includes('--single-transaction'));
    assert.equal(nativeTableCount(), '9');
    assert.equal(sql("SELECT 'public.ezil_delegation_replay'::regclass::oid;"), replayOid);
    assert.equal(sql('SELECT jti::text FROM public.ezil_delegation_replay;'), nonce);
    assert.equal(receiptSnapshot(), legacyBefore);
    const native = sql("SELECT file || ':' || sha256 || ':' || mode FROM public.ezil_staging_schema_log WHERE file IN (" +
        NATIVE_PRODUCTION_FILES.map(file => "'" + file + "'").join(',') + ') ORDER BY file;');
    assert.equal(native, NATIVE_PRODUCTION_FILES.map(file => file + ':' + NATIVE_SQL_PINS[file] + ':apply').join('\n'));
    const allReceiptsBefore = sql('SELECT jsonb_agg(to_jsonb(t) ORDER BY file) FROM public.ezil_staging_schema_log t;');
    assert.equal(apply(id, hash).rc, 0);
    const readback = invoke(['plan', ...modeArgs(id)]);
    assert.equal(readback.rc, 0, [...readback.output, ...readback.diagnostics].join('\n'));
    assert.equal(readback.output.filter(line => line.endsWith('exact apply receipt verified')).length, 4);
    assert.equal(sql('SELECT jsonb_agg(to_jsonb(t) ORDER BY file) FROM public.ezil_staging_schema_log t;'), allReceiptsBefore);
    assert.equal(sql('SELECT jti::text FROM public.ezil_delegation_replay;'), nonce);
});


test('real PostgreSQL rolls back every new statement after a late schema collision', { skip: !containerName }, () => {
    const { id, hash } = setup();
    sql('CREATE TABLE public.ezil_native_runtime_requests (collision integer);');
    const before = receiptSnapshot();
    const failure = apply(id, hash);
    assert.equal(failure.rc, 1);
    assert.match(failure.diagnostics.join('\n'), /relation "ezil_native_runtime_requests" already exists/);
    assert.equal(failure.calls.length, 1);
    assert.equal(nativeTableCount(), '1');
    assert.equal(receiptSnapshot(), before);
    assert.equal(sql('SELECT jti::text FROM public.ezil_delegation_replay;'), nonce);
    assert.equal(sql("SELECT count(*) FROM public.ezil_staging_schema_log WHERE file LIKE 'app/drizzle/0029_%'"), '0');
});

test('real PostgreSQL refuses missing, drifted and altered production proof without schema writes', { skip: !containerName }, () => {
    const { id, hash } = setup();
    assert.equal(apply('0', hash).rc, 1, 'wrong system identifier');
    assert.equal(apply(id, validPin).rc, 1, 'wrong trigger fingerprint');
    const assertNoWrites = () => {
        assert.equal(nativeTableCount(), '0');
        assert.equal(sql('SELECT jti::text FROM public.ezil_delegation_replay;'), nonce);
    };
    assertNoWrites();
    sql('ALTER TABLE public.ezil_delegation_replay DISABLE ROW LEVEL SECURITY;');
    assert.equal(apply(id, hash).rc, 1, 'receipt/catalog drift');
    sql('ALTER TABLE public.ezil_delegation_replay ENABLE ROW LEVEL SECURITY;');
    sql('DROP INDEX public.ezil_delegation_replay_jti_key;');
    assert.equal(apply(id, hash).rc, 1, 'missing 0030 replay uniqueness fence');
    sql('CREATE UNIQUE INDEX ezil_delegation_replay_jti_key ON public.ezil_delegation_replay (jti);');
    sql('CREATE FUNCTION public.native_test_hook() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;' +
        'CREATE EVENT TRIGGER native_test_hook ON ddl_command_end EXECUTE FUNCTION public.native_test_hook();');
    assert.equal(apply(id, hash).rc, 1, 'catalog hook inventory changed after preflight');
    sql('DROP EVENT TRIGGER native_test_hook; DROP FUNCTION public.native_test_hook();');
    sql("UPDATE public.ezil_staging_schema_log SET mode='baseline' WHERE file='" + TARGETED_APPLY_FILE + "';");
    assert.equal(apply(id, hash).rc, 1, '0030 was not applied');
    sql("UPDATE public.ezil_staging_schema_log SET mode='apply' WHERE file='" + TARGETED_APPLY_FILE + "';");
    sql("INSERT INTO public.ezil_staging_schema_log (file,sha256,mode) VALUES ('out-of-band.sql',repeat('a',64),'apply');");
    assert.equal(apply(id, hash).rc, 1, 'unknown prior receipt');
    sql("DELETE FROM public.ezil_staging_schema_log WHERE file='out-of-band.sql';");
    const file = NATIVE_PRODUCTION_FILES[0];
    sql("INSERT INTO public.ezil_staging_schema_log (file,sha256,mode) VALUES ('" + file + "','" + NATIVE_SQL_PINS[file] + "','apply');");
    assert.equal(apply(id, hash).rc, 1, 'partial native history');
    sql("DELETE FROM public.ezil_staging_schema_log WHERE file='" + file + "';");
    sql('GRANT UPDATE ON public.ezil_staging_schema_log TO authenticated;');
    assert.equal(apply(id, hash).rc, 1, 'client-writable historical receipts');
    sql('REVOKE UPDATE ON public.ezil_staging_schema_log FROM authenticated;');
    sql('ALTER TABLE public.ezil_computer_placements ALTER COLUMN generation DROP NOT NULL;');
    assert.equal(apply(id, hash).rc, 1, 'invalid placement prerequisite');
    assertNoWrites();
});

const aclOption = '--harden-receipt-acl';
const aclPinOption = '--expect-receipt-acl-sha256';
const aclPlan = id => invoke(['plan', ...modeArgs(id), aclOption]);
const aclApply = (id, eventHash, aclHash) => invoke(['apply', '--yes', ...modeArgs(id), aclOption, pinOption, eventHash, aclPinOption, aclHash]);
const fullReceiptSnapshot = () => sql('SELECT jsonb_agg(to_jsonb(t) ORDER BY file) FROM public.ezil_staging_schema_log t;');

test('receipt ACL hardening is an explicit pinned production operation', () => {
    assert.equal(parseArgs(['plan', ...modeArgs('123'), aclOption]).hardenReceiptAcl, true);
    assert.equal(parseArgs(['apply', '--yes', ...modeArgs('123'), aclOption, pinOption, validPin, aclPinOption, validPin]).expectReceiptAclSha256, validPin);
    for (const args of [
        ['plan', aclOption, '--target', 'aws-production', '--expect-system-id', '123'],
        ['plan', ...modeArgs('123'), aclOption, aclPinOption, validPin],
        ['apply', '--yes', ...modeArgs('123'), aclOption, pinOption, validPin],
        ['apply', '--yes', ...modeArgs('123'), pinOption, validPin, aclPinOption, validPin],
    ]) assert.throws(() => parseArgs(args));
});

test('real PostgreSQL narrows exact Supabase-style write ACLs and preserves receipts, replay, and other grants', { skip: !containerName }, () => {
    const { id } = setup();
    const pg17 = Number(sql("SELECT current_setting('server_version_num');")) >= 170000;
    const table = 'public.ezil_staging_schema_log';
    const optionalMaintain = pg17 ? ',MAINTAIN' : '';
    sql("DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;" +
        "DO $$ BEGIN CREATE ROLE ezil_mcp_admin; EXCEPTION WHEN duplicate_object THEN NULL; END $$;");
    sql('GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES' + optionalMaintain + ' ON ' + table +
        ' TO anon,authenticated,service_role; GRANT DELETE ON ' + table + ' TO ezil_mcp_admin;');
    const before = fullReceiptSnapshot();
    const replay = sql("SELECT 'public.ezil_delegation_replay'::regclass::oid || ':' || jti FROM public.ezil_delegation_replay;");
    const expectedReads = sql("SELECT has_table_privilege('anon','" + table + "','SELECT,REFERENCES" + optionalMaintain + "')," +
        "has_table_privilege('authenticated','" + table + "','SELECT,REFERENCES" + optionalMaintain + "');");
    assert.equal(invoke(['plan', ...modeArgs(id)]).rc, 1, 'normal native plan stays fail-closed');
    const plan = aclPlan(id);
    assert.equal(plan.rc, 0, [...plan.output, ...plan.diagnostics].join('\n'));
    assert.ok(plan.calls[0].includes('SET TRANSACTION READ ONLY;'));
    assert.equal(plan.output[2], 'Production receipt ACL hardening pending');
    const [eventHash, aclHash] = plan.output.slice(0,2).map(line => line.split(' ').at(-1));
    const wrong = aclApply(id, eventHash, validPin);
    assert.equal(wrong.rc, 1);
    assert.match(wrong.diagnostics.join('\n'), /receipt ACL fingerprint mismatch/);
    assert.equal(fullReceiptSnapshot(), before);
    const repaired = aclApply(id, eventHash, aclHash);
    assert.equal(repaired.rc, 0, [...repaired.output, ...repaired.diagnostics].join('\n'));
    assert.equal(repaired.calls.length, 1);
    assert.ok(repaired.calls[0].includes('--single-transaction'));
    assert.equal(fullReceiptSnapshot(), before);
    assert.equal(sql("SELECT 'public.ezil_delegation_replay'::regclass::oid || ':' || jti FROM public.ezil_delegation_replay;"), replay);
    assert.equal(nativeTableCount(), '0');
    assert.equal(sql("SELECT has_table_privilege('anon','" + table + "','SELECT,REFERENCES" + optionalMaintain + "')," +
        "has_table_privilege('authenticated','" + table + "','SELECT,REFERENCES" + optionalMaintain + "');"), expectedReads);
    assert.equal(sql("SELECT has_table_privilege('anon','" + table + "','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')," +
        "has_table_privilege('authenticated','" + table + "','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')," +
        "has_table_privilege('service_role','" + table + "','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')," +
        "has_table_privilege('ezil_mcp_admin','" + table + "','DELETE');"), 'f|f|t|t');
    const readback = aclPlan(id);
    assert.equal(readback.rc, 0, [...readback.output, ...readback.diagnostics].join('\n'));
    assert.equal(readback.output[2], 'Production receipt ACL already hardened');
    assert.equal(invoke(['plan', ...modeArgs(id)]).rc, 0, 'normal native plan reopens after exact repair');

    // Model the production defaults when the later native tables are created.
    sql('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES' +
        optionalMaintain + ' ON TABLES TO anon, authenticated, service_role;');
    const native = apply(id, eventHash);
    assert.equal(native.rc, 0, [...native.output, ...native.diagnostics].join('\n'));
    assert.equal(nativeTableCount(), '9');
    assert.equal(sql("SELECT count(*) FROM pg_class c WHERE relnamespace='public'::regnamespace AND relkind='r'" +
        " AND relname LIKE 'ezil_native_%' AND (has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER" +
        optionalMaintain + "') OR has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER" +
        optionalMaintain + "') OR NOT has_table_privilege('service_role',c.oid,'INSERT'));"), '0');
    sql('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated, service_role;');
});


test('real PostgreSQL refuses unexpected ACL shapes and rolls back a repair when inherited writes survive', { skip: !containerName }, () => {
    const { id } = setup();
    const table = 'public.ezil_staging_schema_log';
    sql('GRANT UPDATE(file) ON ' + table + ' TO anon;');
    assert.equal(aclPlan(id).rc, 1, 'column-level client write grant requires reconciliation');
    sql('REVOKE UPDATE(file) ON ' + table + ' FROM anon;');
    sql('GRANT INSERT ON ' + table + ' TO authenticated WITH GRANT OPTION;');
    assert.equal(aclPlan(id).rc, 1, 'downstream grant option requires reconciliation');
    sql('REVOKE INSERT ON ' + table + ' FROM authenticated;');
    sql('GRANT INSERT ON ' + table + ' TO anon,authenticated; GRANT UPDATE ON ' + table + ' TO PUBLIC;');
    const before = fullReceiptSnapshot();
    const plan = aclPlan(id);
    assert.equal(plan.rc, 0, [...plan.output, ...plan.diagnostics].join('\n'));
    const [eventHash, aclHash] = plan.output.slice(0,2).map(line => line.split(' ').at(-1));
    const failure = aclApply(id, eventHash, aclHash);
    assert.equal(failure.rc, 1);
    assert.match(failure.diagnostics.join('\n'), /Native receipts must not be client-writable/);
    assert.equal(sql("SELECT has_table_privilege('anon','" + table + "','INSERT');"), 't', 'restricted revoke rolled back');
    assert.equal(fullReceiptSnapshot(), before);
    assert.equal(nativeTableCount(), '0');
});
