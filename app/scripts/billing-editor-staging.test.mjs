import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildPlan, EXPLICIT_FILES, parseArgs, RETIRED_HOST_RELEASE_FILE, run, sha256, TARGETED_APPLY_FILE } from './billing-staging-schema.mjs';
import { EDITOR_SQL_PINS, EDITOR_STAGING_SYSTEM_ID } from './billing-editor-staging.mjs';

const options = ['--editor-staging', '--target', 'aws-preview', '--expect-system-id', EDITOR_STAGING_SYSTEM_ID];
const pin = '--expect-event-trigger-sha256';
const otherDigest = '0'.repeat(64);
const approvedUrl = 'postgresql://postgres@127.0.0.1:15432/postgres';
const container = process.env.EDITOR_STAGING_PG_TEST_CONTAINER;
const steps = ['docs/aws-computers/sql/0001_compute_placement.sql.txt',
    'docs/aws-computers/sql/0002_image_rebase.sql.txt', TARGETED_APPLY_FILE, RETIRED_HOST_RELEASE_FILE];
const files = Object.keys(EDITOR_SQL_PINS);
const source = file => readFileSync(new URL('../../' + file, import.meta.url));
const row = file => ({ file, sha256: EDITOR_SQL_PINS[file], mode: 'apply' });

test('only the exact AWS staging database can select the reviewed editor schema profile', () => {
    assert.equal(parseArgs(['plan', ...options]).editorStaging, true);
    assert.equal(parseArgs(['apply', '--yes', ...options, pin, otherDigest]).editorStaging, true);
    for (const args of [
        ['plan', ...options.map(value => value === 'aws-preview' ? 'aws-production' : value)],
        ['plan', ...options.map(value => value === 'aws-preview' ? 'ezil-os-awstest' : value)],
        ['plan', ...options.map(value => value === EDITOR_STAGING_SYSTEM_ID ? '1' : value)],
        ['plan', ...options, pin, otherDigest],
        ['apply', ...options, pin, otherDigest],
        ['apply', '--yes', ...options],
        ['apply', '--yes', ...options, pin, otherDigest, '--only', TARGETED_APPLY_FILE],
        ['apply', '--yes', ...options, pin, otherDigest, '--only', RETIRED_HOST_RELEASE_FILE],
        ['baseline', files[0], '--yes', ...options],
    ]) assert.throws(() => parseArgs(args));
    for (const file of files) {
        assert.equal(sha256(source(file)), EDITOR_SQL_PINS[file]);
        assert.ok(!EXPLICIT_FILES.includes(file));
        assert.throws(() => buildPlan([], [row(file)]));
        assert.throws(() => buildPlan([], [{ ...row(file), mode: 'baseline' }], EDITOR_SQL_PINS));
        assert.deepEqual(buildPlan([], [row(file)], EDITOR_SQL_PINS), []);
    }
    assert.throws(() => buildPlan([], [{ file: 'app/drizzle/0026_session_effort.sql', sha256: otherDigest, mode: 'apply' }], EDITOR_SQL_PINS));
});

function postgres(args) {
    return spawnSync('docker', ['exec', '-i', container, 'psql', '-X', '--no-password', '-U', 'postgres', '-d', 'postgres',
        '-v', 'ON_ERROR_STOP=1', '-qAt', ...args], { encoding: 'utf8' });
}
function sql(statement) {
    const result = postgres(['-c', statement]);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}
function invoke(args, syntheticClusterId) {
    const output = [], calls = [], diagnostics = [];
    const rc = run(args, {
        env: { BILLING_STAGING_DATABASE_URL: approvedUrl },
        write: line => output.push(line),
        spawnSyncImpl: (command, argv, spawn) => {
            assert.equal(command, 'psql');
            assert.equal(spawn.env.PGHOST, '127.0.0.1');
            assert.equal(spawn.env.PGPORT, '15432');
            const [identity] = argv.filter(arg => arg.includes('system_identifier::text'));
            if (args.includes('--editor-staging')) assert.ok(identity.includes(EDITOR_STAGING_SYSTEM_ID));
            calls.push(argv);
            // Only the isolated fixture has a generated cluster ID. Mismatch is also tested without this substitution.
            const result = postgres(syntheticClusterId
                ? argv.map(arg => arg === identity ? arg.replace(EDITOR_STAGING_SYSTEM_ID, syntheticClusterId) : arg)
                : argv);
            if (result.status !== 0) diagnostics.push(result.stderr);
            return result;
        },
    });
    return { rc, output, calls, diagnostics };
}
const diagnostic = result => [...result.output, ...result.diagnostics].join('\n').slice(0, 2000);
const allReceipts = () => sql('SELECT jsonb_agg(to_jsonb(t) ORDER BY file) FROM public.ezil_staging_schema_log t;');

test('real PostgreSQL preserves incumbent staging, rolls back a late SQL error and applies only the three editor receipts', { skip: !container }, () => {
    const inspected = spawnSync('docker', ['inspect', container], { encoding: 'utf8' });
    assert.equal(inspected.status, 0, inspected.stderr);
    const [safe] = JSON.parse(inspected.stdout);
    assert.equal(safe.Config.Labels['ezil.purpose'], 'editor-stage-schema-pg');
    assert.equal(safe.HostConfig.NetworkMode, 'none');
    sql('CREATE ROLE anon; CREATE ROLE authenticated;' +
        'CREATE TABLE public.ezil_computers (id uuid PRIMARY KEY, user_id uuid NOT NULL, slot smallint NOT NULL, deleted_at timestamptz);' +
        'ALTER TABLE public.ezil_computers ENABLE ROW LEVEL SECURITY;');
    for (const file of steps) sql(source(file).toString());
    sql('CREATE TABLE public.ezil_staging_schema_log(file text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), mode text NOT NULL);');
    for (const file of steps) sql("INSERT INTO public.ezil_staging_schema_log(file,sha256,mode) VALUES ('" + file + "','" + sha256(source(file)) + "','apply');");
    const replay = '00000000-0000-4000-8000-000000000001';
    sql("INSERT INTO public.ezil_delegation_replay VALUES ('" + replay + "', now() + interval '1 hour');");
    sql('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;');
    const initial = allReceipts();
    const id = sql('SELECT system_identifier FROM pg_control_system();');
    assert.notEqual(id, EDITOR_STAGING_SYSTEM_ID);
    const stagePlan = () => invoke(['plan', ...options], id);
    const stageApply = digest => invoke(['apply', '--yes', ...options, pin, digest], id);
    const wrongCluster = invoke(['plan', ...options]);
    assert.notEqual(wrongCluster.rc, 0);
    assert.match(diagnostic(wrongCluster), /System identifier mismatch/);
    const plan = stagePlan();
    assert.equal(plan.rc, 0, diagnostic(plan));
    assert.equal(plan.calls.length, 1);
    assert.ok(plan.calls[0].includes('SET TRANSACTION READ ONLY;'));
    assert.equal(plan.output.filter(line => line.endsWith('pending editor staging batch')).length, 3);
    const digest = plan.output[0].split(' ').at(-1);
    assert.match(digest, /^[a-f0-9]{64}$/);
    assert.equal(allReceipts(), initial);
    sql('GRANT UPDATE (expires_at) ON public.ezil_delegation_replay TO authenticated;');
    const replayDrift = stagePlan();
    assert.notEqual(replayDrift.rc, 0);
    assert.match(diagnostic(replayDrift), /Committed staging 0030 replay ownership, RLS or ACL mismatch/);
    sql('REVOKE UPDATE (expires_at) ON public.ezil_delegation_replay FROM authenticated;');
    const wrongTrigger = stageApply(otherDigest);
    assert.notEqual(wrongTrigger.rc, 0);
    assert.match(diagnostic(wrongTrigger), /event trigger fingerprint mismatch/);
    sql("INSERT INTO public.ezil_staging_schema_log(file,sha256,mode) VALUES ('app/drizzle/0026_session_effort.sql','" + otherDigest + "','apply');");
    const wrongProposal = stagePlan();
    assert.notEqual(wrongProposal.rc, 0);
    assert.match(diagnostic(wrongProposal), /outside reviewed source/);
    sql("DELETE FROM public.ezil_staging_schema_log WHERE file='app/drizzle/0026_session_effort.sql';" +
        "CREATE FUNCTION public.fixture_editor_drift() RETURNS event_trigger LANGUAGE plpgsql AS $fn$ BEGIN" +
        " IF to_regclass('public.ezil_control_operations') IS NOT NULL AND NOT EXISTS" +
        " (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.ezil_control_operations') AND attname='unexpected')" +
        " THEN ALTER TABLE public.ezil_control_operations ADD COLUMN unexpected integer; END IF; END $fn$;" +
        " CREATE EVENT TRIGGER fixture_editor_drift ON ddl_command_end WHEN TAG IN ('ALTER TABLE') EXECUTE FUNCTION public.fixture_editor_drift();");
    const rollbackPlan = stagePlan();
    assert.equal(rollbackPlan.rc, 0, diagnostic(rollbackPlan));
    const rollback = stageApply(rollbackPlan.output[0].split(' ').at(-1));
    assert.notEqual(rollback.rc, 0);
    assert.match(diagnostic(rollback), /Editor column count mismatch/);
    assert.equal(allReceipts(), initial);
    assert.equal(sql("SELECT to_regclass('public.ezil_agent_sessions');"), '');
    assert.equal(sql("SELECT to_regclass('public.ezil_control_operations');"), '');
    sql('DROP EVENT TRIGGER fixture_editor_drift; DROP FUNCTION public.fixture_editor_drift();');
    const apply = stageApply(digest);
    assert.equal(apply.rc, 0, diagnostic(apply));
    assert.equal(apply.calls.length, 1);
    assert.ok(apply.calls[0].includes('--single-transaction'));
    assert.equal(sql("SELECT jsonb_agg(to_jsonb(t) ORDER BY file) FROM public.ezil_staging_schema_log t WHERE file !~ '^app/drizzle/003[456]_';"), initial);
    assert.equal(sql("SELECT file || ':' || sha256 || ':' || mode FROM public.ezil_staging_schema_log WHERE file ~ '^app/drizzle/003[456]_' ORDER BY file;"),
        files.map(file => file + ':' + EDITOR_SQL_PINS[file] + ':apply').join('\n'));
    const exact = stagePlan();
    assert.equal(exact.rc, 0, diagnostic(exact));
    assert.equal(exact.output.filter(line => line.endsWith('exact apply receipt verified')).length, 3);
    const after = allReceipts();
    assert.equal(stageApply(digest).rc, 0);
    assert.equal(allReceipts(), after);
    assert.equal(sql('SELECT jti::text FROM public.ezil_delegation_replay;'), replay);
});
