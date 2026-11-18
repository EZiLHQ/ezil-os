import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    STAGING_REF, EXPLICIT_FILES, TARGETED_APPLY_FILE, validateDatabaseUrl, redact, orderFiles,
    sha256, buildPlan, renderPlan, parseArgs, run,
} from './billing-staging-schema.mjs';

// Reserved example domains and a public fixture marker, never real credentials.
const password = 'public-fixture-marker';
const direct = `postgresql://postgres:${password}@db.${STAGING_REF}.example/postgres?sslmode=require`;
const pooler = `postgres://postgres.${STAGING_REF}:${password}@pooler.example:6543/postgres`;
const files = EXPLICIT_FILES.map((file) => ({
    file, sha256: sha256(readFileSync(fileURLToPath(new URL(`../../${file}`, import.meta.url)))),
}));
const row = (index, mode = 'apply') => ({ ...files[index], mode });

function harness(logged = [], override = {}) {
    const calls = [];
    const output = [];
    const options = {
        env: { BILLING_STAGING_DATABASE_URL: direct, ...override },
        write: (message) => output.push(message),
        spawnSyncImpl: (command, args, settings) => {
            calls.push({ command, args, settings });
            return { status: 0, stdout: args.some((arg) => arg.startsWith('SELECT COALESCE')) ? JSON.stringify(logged) : '', stderr: '' };
        },
    };
    return { calls, output, options };
}

test('URL pin accepts direct and pooler forms with either PostgreSQL scheme', () => {
    assert.equal(validateDatabaseUrl(direct).hostname, `db.${STAGING_REF}.example`);
    assert.equal(validateDatabaseUrl(pooler).username, `postgres.${STAGING_REF}`);
});

test('URL pin refuses missing pins, wrong schemes, and pins only in password/path/query', () => {
    for (const value of [undefined, '', 'invalid', 'postgres://postgres@other.example/postgres',
        `postgres://postgres:${STAGING_REF}@other.example/postgres`,
        `postgres://postgres@other.example/${STAGING_REF}`,
        `postgres://postgres@other.example/postgres?application_name=${STAGING_REF}`,
        direct.replace('postgresql:', 'https:')]) {
        assert.throws(() => validateDatabaseUrl(value));
    }
});

test('both protected refs are refused anywhere even with a valid staging pin', () => {
    for (const [ref, message] of [['btgqfmnzycdecmeyqubx', /LIVE production/], ['curomaahbwlrddzijatd', /Website project/]]) {
        for (const value of [
            `postgres://postgres@db.${ref}.example/postgres`,
            `postgres://postgres.${ref}@pooler.example/postgres`,
            direct.replace(password, ref), pooler.replace('pooler.example', `${ref}.example`),
            `${direct}&application_name=${ref}`, `${pooler}/${ref}`,
            `${direct}&invalid=%ZZ&blocked=${ref}`,
            direct.replace(password, ref.toUpperCase()),
            direct.replace(password, `%${ref.charCodeAt(0).toString(16)}${ref.slice(1)}`),
        ]) assert.throws(() => validateDatabaseUrl(value), message);
    }
});

test('query routing overrides and malformed URLs are refused', () => {
    for (const option of ['host=other.example', 'hostaddr=127.0.0.1', 'user=other', 'dbname=other', 'service=other', 'options=-csearch_path=other', 'sslmode=invalid']) {
        assert.throws(() => validateDatabaseUrl(`${direct}&${option}`), /Unsupported/);
    }
    assert.throws(() => validateDatabaseUrl(`${direct}#fragment`));
    assert.throws(() => validateDatabaseUrl(direct.replace(password, '%ZZ')));
    validateDatabaseUrl(`${direct}&connect_timeout=10`);
});

test('ordering is explicit, independent of directory order, and appends optional v3 once', () => {
    const drizzle = EXPLICIT_FILES.filter((file) => file.startsWith('app/drizzle/')).map((file) => file.split('/').at(-1)).reverse();
    const placement = EXPLICIT_FILES.filter((file) => file.startsWith('docs/')).map((file) => file.split('/').at(-1)).reverse();
    assert.deepEqual(orderFiles(drizzle, placement), EXPLICIT_FILES);
    assert.deepEqual(orderFiles([...drizzle, '0007_billing_v3.sql', 'meta', '0006_billing_v3.sql', 'other.sql', '0007_billing_v3.sql'], placement),
        [...EXPLICIT_FILES, 'app/drizzle/0006_billing_v3.sql', 'app/drizzle/0007_billing_v3.sql']);
    assert.throws(() => orderFiles(drizzle.slice(1), placement), /Required schema file missing/);
});

test('hashing uses file bytes and offline rendering only includes filenames and hashes', () => {
    assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.notEqual(sha256('a\n'), sha256('a\r\n'));
    assert.equal(renderPlan(files.slice(0, 1)), `${files[0].file}  ${files[0].sha256}`);
    const rendered = renderPlan(files, [row(0), row(1, 'baseline')]);
    assert.match(rendered, /applied \(apply\)/);
    assert.match(rendered, /applied \(baseline\)/);
    assert.match(rendered, /pending/);
});

test('sha mismatch refuses the whole plan and names the changed file', () => {
    const logged = [{ ...row(5), sha256: '0'.repeat(64) }];
    for (const check of [buildPlan, renderPlan]) {
        assert.throws(() => check(files, logged), (error) => error.message === `SHA-256 mismatch: ${files[5].file}`);
    }
});

test('apply and baseline require --yes before any psql call', () => {
    for (const args of [['apply'], ['baseline', files[0].file]]) {
        assert.throws(() => parseArgs(args), /requires --yes/);
        const { options, output, calls } = harness();
        assert.equal(run(args, options), 1);
        assert.match(output.join('\n'), /requires --yes/);
        assert.equal(calls.length, 0);
    }
    assert.equal(parseArgs([]).mode, 'plan');
    assert.equal(parseArgs(['--yes', 'apply']).mode, 'apply');
    assert.throws(() => parseArgs(['baseline', '--yes']));
    assert.throws(() => parseArgs(['apply', '--yes', 'unexpected']));
});

test('without URL default plan is entirely offline; writes refuse', () => {
    const { options, calls, output } = harness([], { BILLING_STAGING_DATABASE_URL: undefined });
    assert.equal(run([], options), 0);
    assert.equal(output[0], renderPlan(files));
    assert.equal(run(['apply', '--yes'], options), 1);
    assert.equal(run(['baseline', files[0].file, '--yes'], options), 1);
    assert.equal(calls.length, 0);
});

test('connected plan creates/reads the log and never executes a schema file', () => {
    const { options, calls, output } = harness([row(0, 'baseline')]);
    assert.equal(run(['plan'], options), 0);
    assert.equal(calls.length, 2);
    assert.match(calls[0].args.at(-1), /CREATE TABLE IF NOT EXISTS public.ezil_staging_schema_log/);
    assert.equal(calls.some(({ args }) => args.includes('-f')), false);
    assert.equal(output[0], renderPlan(files, [row(0, 'baseline')]));
});

test('apply skips logged files and atomically runs each pending file before its log insert', () => {
    const { options, calls } = harness([row(0)], { PGHOSTADDR: 'other', PGSERVICE: 'other', PGOPTIONS: 'other' });
    assert.equal(run(['apply', '--yes'], options), 0);
    const migrations = calls.slice(2);
    assert.equal(migrations.length, files.length - 1);
    migrations.forEach(({ command, args, settings }, index) => {
        assert.equal(command, 'psql');
        assert.ok(args.includes('--single-transaction'));
        assert.ok(args.includes('ON_ERROR_STOP=1'));
        assert.ok(args.includes('-X'));
        assert.ok(args.includes('--no-password'));
        assert.ok(args[args.indexOf('-f') + 1].endsWith(files[index + 1].file));
        assert.ok(args.indexOf('-f') < args.indexOf('-c'));
        assert.ok(args.at(-1).includes(files[index + 1].sha256));
        assert.match(args.at(-1), /'apply'\);$/);
        assert.equal(args.join(' ').includes(password), false);
        assert.equal(settings.env.PGHOST, `db.${STAGING_REF}.example`);
        assert.equal(settings.env.PGPORT, '5432');
        assert.equal(settings.env.PGUSER, 'postgres');
        assert.equal(settings.env.PGPASSWORD, password);
        assert.equal(settings.env.PGDATABASE, 'postgres');
        assert.equal(settings.env.PGSSLMODE, 'require');
        for (const key of ['PGHOSTADDR', 'PGSERVICE', 'PGOPTIONS', 'BILLING_STAGING_DATABASE_URL']) assert.equal(settings.env[key], undefined);
        assert.equal(settings.env.PGPASSFILE, '/dev/null');
    });
});

test('pooler connection fields and encoded password are passed to libpq without URI ambiguity', () => {
    const { options, calls } = harness([], { BILLING_STAGING_DATABASE_URL: pooler.replace(password, 'public%40fixture%3Amarker') });
    assert.equal(run(['plan'], options), 0);
    const connection = calls[0].settings.env;
    assert.equal(connection.PGHOST, 'pooler.example');
    assert.equal(connection.PGPORT, '6543');
    assert.equal(connection.PGUSER, `postgres.${STAGING_REF}`);
    assert.equal(connection.PGPASSWORD, 'public@fixture:marker');
    assert.equal(connection.PGDATABASE, 'postgres');
});

test('malformed or duplicate log rows fail closed', () => {
    for (const logged of [null, {}, [row(0), row(0)], [{ ...row(0), mode: 'unknown' }], [{ ...row(0), file: 'outside.sql' }]]) {
        const { options, calls } = harness(logged);
        assert.equal(run(['apply', '--yes'], options), 1);
        assert.equal(calls.length, 2);
    }
});

test('baseline logs only named files in schema order without running their SQL', () => {
    const { options, calls } = harness([row(0)]);
    assert.equal(run(['baseline', files[2].file, files[0].file, '0001_telemetry.sql', '--yes'], options), 0);
    assert.equal(calls.length, 4);
    assert.equal(calls.some(({ args }) => args.includes('-f')), false);
    assert.ok(calls[2].args.at(-1).includes(files[1].file));
    assert.ok(calls[3].args.at(-1).includes(files[2].file));
    assert.match(calls[3].args.at(-1), /'baseline'\);$/);
});

test('unknown baseline files and unsafe URLs refuse before psql', () => {
    for (const [args, url] of [[['baseline', '../outside.sql', '--yes'], direct], [['plan'], direct.replace(STAGING_REF, 'other')]]) {
        const { options, calls } = harness([], { BILLING_STAGING_DATABASE_URL: url });
        assert.equal(run(args, options), 1);
        assert.equal(calls.length, 0);
    }
});

test('every mode checks all hashes before writing even for an unrelated baseline selection', () => {
    for (const args of [['plan'], ['apply', '--yes'], ['baseline', files[0].file, '--yes']]) {
        const { options, calls, output } = harness([{ ...row(5), sha256: '0'.repeat(64) }]);
        assert.equal(run(args, options), 1);
        assert.equal(calls.length, 2);
        assert.ok(output.join('\n').includes(`SHA-256 mismatch: ${files[5].file}`));
    }
});

test('passwords and URLs never appear in output, including child errors and malformed log output', () => {
    const encodedUrl = direct.replace(password, 'public%40fixture%3Amarker');
    assert.equal(redact(`${encodedUrl} public%40fixture%3Amarker public@fixture:marker`, encodedUrl), '[REDACTED] [REDACTED] [REDACTED]');
    for (const failure of ['throw', 'status', 'signal', 'error', 'json']) {
        const { options, output } = harness();
        options.spawnSyncImpl = () => {
            if (failure === 'throw') throw new Error(direct);
            return { status: failure === 'status' ? 1 : 0, stdout: direct, stderr: password,
                signal: failure === 'signal' ? 'SIGTERM' : null,
                error: failure === 'error' ? new Error(password) : undefined };
        };
        assert.equal(run(['plan'], options), 1);
        assert.equal(output.join('\n').includes(password), false);
        assert.equal(output.join('\n').includes(direct), false);
    }
    const { options, output } = harness();
    assert.equal(run(['plan'], options), 0);
    assert.equal(output.join('\n').includes(password), false);
});

test('a failed migration stops immediately and never attempts later files', () => {
    const { options, calls, output } = harness();
    const successful = options.spawnSyncImpl;
    options.spawnSyncImpl = (...args) => {
        const result = successful(...args);
        return calls.length === 3 ? { status: 1, stdout: password, stderr: direct } : result;
    };
    assert.equal(run(['apply', '--yes'], options), 1);
    assert.equal(calls.length, 3);
    assert.match(output.join('\n'), /stopped without retry/);
    assert.equal(output.join('\n').includes(': applied'), false);
    assert.equal(output.join('\n').includes(password), false);
});

const previewId = '7568749223372036854'; // Deliberately larger than JS's safe integer.
const previewUrl = `postgres://postgres:${password}@127.0.0.1:15432/postgres`;
const previewArgs = ['--target', 'aws-preview', '--expect-system-id', previewId];
function previewHarness(actual = previewId) {
    const h = harness([], { BILLING_STAGING_DATABASE_URL: previewUrl, PGHOSTADDR: '10.63.20.1' });
    const original = h.options.spawnSyncImpl;
    h.options.spawnSyncImpl = (...args) => {
        const result = original(...args);
        if (args[1].includes('SELECT system_identifier FROM pg_control_system();')) result.stdout = `${actual}\n`;
        return result;
    };
    return h;
}

test('aws-preview accepts only the exact tunnel or private preview host and explicit port', () => {
    for (const host of ['127.0.0.1:15432', 'localhost:15432', '10.61.20.35:5432']) {
        assert.doesNotThrow(() => validateDatabaseUrl(`postgres://postgres@${host}/postgres`, 'aws-preview'));
    }
    for (const host of ['127.0.0.1:5432', 'localhost', 'localhost:15433', '10.61.20.35',
        '10.61.20.35:15432', '10.63.20.35:5432', '13.203.99.168:5432', '127.1:15432',
        'localhost.example:15432', '[::1]:15432']) {
        assert.throws(() => validateDatabaseUrl(`postgres://postgres@${host}/postgres`, 'aws-preview'));
    }
    assert.throws(() => validateDatabaseUrl(direct, 'aws-preview'));
    assert.throws(() => validateDatabaseUrl(`${previewUrl}?host=10.63.20.35`, 'aws-preview'));
    for (const ref of ['btgqfmnzycdecmeyqubx', 'curomaahbwlrddzijatd']) {
        assert.throws(() => validateDatabaseUrl(previewUrl.replace(password, ref), 'aws-preview'), /forbidden/);
        assert.throws(() => validateDatabaseUrl(previewUrl.replace(password, `%${ref.charCodeAt(0).toString(16)}${ref.slice(1)}`), 'aws-preview'), /forbidden/);
    }
});

test('targets and system-id arguments fail closed before any SQL', () => {
    assert.equal(parseArgs(['--target', 'ezil-os-awstest', 'plan']).target, 'ezil-os-awstest');
    for (const args of [['--target', 'aws-preview'], ['--target', 'production'],
        ['--target'], ['--expect-system-id', previewId],
        [...previewArgs, '--target', 'aws-preview'],
        ...['', '1e10', '-123', '123.0', "123'; SELECT 1"].map(id => ['--target', 'aws-preview', '--expect-system-id', id])]) {
        const h = previewHarness();
        assert.equal(run(args, h.options), 1);
        assert.equal(h.calls.length, 0);
    }
    const h = previewHarness();
    h.options.env.BILLING_STAGING_DATABASE_URL = undefined;
    assert.equal(run(previewArgs, h.options), 1, 'preview never offers an unpinned offline plan');
    assert.equal(h.calls.length, 0);
});

test('preview system identifier mismatch or malformed output blocks all modes before writes', () => {
    for (const mode of [['plan'], ['apply', '--yes'], ['baseline', files[0].file, '--yes']]) {
        for (const actual of ['7568749223372036855', '', 'garbage', `${previewId}\n${previewId}`]) {
            const h = previewHarness(actual);
            assert.equal(run([...mode, ...previewArgs], h.options), 1);
            assert.equal(h.calls.length, 1);
            assert.equal(h.calls[0].args.at(-1), 'SELECT system_identifier FROM pg_control_system();');
            assert.match(h.output.join('\n'), /identifier mismatch/);
            assert.equal(h.output.join('\n').includes(password), false);
        }
    }
});

test('preview pins before the log and inside every subsequent plan/apply/baseline connection', () => {
    for (const mode of [['plan'], ['apply', '--yes'], ['baseline', files[0].file, '--yes']]) {
        const h = previewHarness();
        assert.equal(run([...mode, ...previewArgs], h.options), 0);
        assert.equal(h.calls[0].args.at(-1), 'SELECT system_identifier FROM pg_control_system();');
        assert.ok(h.calls.length >= 3);
        for (const { args, settings } of h.calls.slice(1)) {
            const guardIndex = args.findIndex(arg => arg.startsWith('DO $pin$'));
            assert.ok(guardIndex > 0);
            assert.ok(args[guardIndex].includes(previewId));
            assert.ok(guardIndex < args.length - 1);
            if (args.includes('-f')) assert.ok(guardIndex < args.indexOf('-f'));
            assert.equal(settings.env.PGHOST, '127.0.0.1');
            assert.equal(settings.env.PGPORT, '15432');
            assert.equal(settings.env.PGHOSTADDR, undefined);
            assert.equal(settings.env.PGSSLMODE, 'disable');
        }
    }
});

test('a failed preview pin query stops immediately without exposing child diagnostics', () => {
    const h = previewHarness();
    h.options.spawnSyncImpl = () => ({ status: 1, stdout: '', stderr: previewUrl });
    assert.equal(run(previewArgs, h.options), 1);
    assert.equal(h.output.join('\n').includes(password), false);
    assert.ok(EXPLICIT_FILES.includes('app/drizzle/0006_compute_migrations.sql'));
});

test('aws-production accepts only the DB container namespace and needs a system-id pin', async () => {
    const { validateDatabaseUrl } = await import('./billing-staging-schema.mjs');
    assert.doesNotThrow(() => validateDatabaseUrl('postgres://postgres:p@127.0.0.1:5432/postgres', 'aws-production'));
    assert.doesNotThrow(() => validateDatabaseUrl('postgres://postgres:p@localhost/postgres', 'aws-production'));
    for (const bad of ['postgres://postgres:p@db.ezil.work:5432/postgres', 'postgres://postgres:p@db.ezil.work/postgres',
        'postgres://postgres:p@10.63.20.10:5432/postgres', 'postgres://postgres:p@10.63.20.252:5432/postgres',
        'postgres://postgres:p@127.0.0.1:15432/postgres', 'postgres://postgres:p@localhost:5433/postgres',
        'postgres://postgres:p@127.0.0.1:5432/postgres?host=db.ezil.work',
        'postgres://postgres:p@db.btgqfmnzycdecmeyqubx.supabase.co:5432/postgres']) {
        assert.throws(() => validateDatabaseUrl(bad, 'aws-production'), bad);
    }
});

test('pool v2 is registered after its prerequisites and preserves service-only RLS', () => {
    const file = 'docs/aws-computers/sql/0003_pool_hosts_v2.sql.txt';
    const rebase = 'docs/aws-computers/sql/0002_image_rebase.sql.txt';
    // Release plan §4.2: ready pool, then image rebase (now logged), then pool v2.
    assert.equal(EXPLICIT_FILES.indexOf(rebase), EXPLICIT_FILES.indexOf('docs/aws-computers/sql/0002_ready_pool.sql.txt') + 1);
    assert.equal(EXPLICIT_FILES.indexOf(file), EXPLICIT_FILES.indexOf(rebase) + 1);
    const sql = readFileSync(fileURLToPath(new URL(`../../${file}`, import.meta.url)), 'utf8');
    assert.match(sql, /REVOKE ALL ON TABLE public.ezil_compute_pool_hosts FROM public, anon, authenticated/);
    assert.match(sql, /ALTER TABLE public.ezil_compute_pool_hosts ENABLE ROW LEVEL SECURITY/);
    assert.doesNotMatch(sql, /GRANT |CREATE POLICY |DISABLE ROW LEVEL SECURITY|DROP TABLE|DROP COLUMN/);
    assert.equal((sql.match(/ADD COLUMN IF NOT EXISTS/g) || []).length, 7);
    assert.equal((sql.match(/CREATE INDEX IF NOT EXISTS/g) || []).length, 3);
});

const productionId = '7568749223372036999';
const productionUrl = `postgres://postgres:${password}@localhost:5432/postgres`;
const productionArgs = ['--target', 'aws-production', '--expect-system-id', productionId];
const neverBaselined = ['docs/aws-computers/sql/0003_pool_hosts_v2.sql.txt', 'app/drizzle/0008_pool_dispatch.sql',
    'app/drizzle/0009_capacity_demands.sql', 'app/drizzle/0010_migration_restore_progress.sql', 'app/drizzle/0011_feedback.sql',
    'app/drizzle/0019_operator_entitlements.sql', 'app/drizzle/0020_operator_refusal_receipts.sql', 'app/drizzle/0021_standard_trial.sql', 'app/drizzle/0022_feedback_notifications.sql',
    'app/drizzle/0024_telemetry_alerts.sql', 'app/drizzle/0025_ai_request_traces.sql'];
function productionHarness(logged = [], actual = productionId) {
    const h = harness(logged, { BILLING_STAGING_DATABASE_URL: productionUrl, PGHOSTADDR: '10.63.20.252', PGSERVICE: 'other' });
    const original = h.options.spawnSyncImpl;
    h.options.spawnSyncImpl = (...args) => {
        const result = original(...args);
        if (args[1].includes('SELECT system_identifier FROM pg_control_system();')) result.stdout = `${actual}\n`;
        return result;
    };
    return h;
}

test('pool v2 production baseline refuses before any connection while plan and other baselines still work', () => {
    for (const mode of [['baseline', '0003_pool_hosts_v2.sql.txt', '--yes'],
        ['baseline', './docs/aws-computers/sql/0003_pool_hosts_v2.sql.txt', '--yes']]) {
        const h = productionHarness();
        assert.equal(run([...mode, ...productionArgs], h.options), 1);
        assert.equal(h.calls.length, 0);
        assert.match(h.output.join('\n'), /never baselined/);
    }
    assert.equal(run(['plan', ...productionArgs], productionHarness().options), 0);
    const h = productionHarness();
    assert.equal(run(['baseline', files[0].file, '--yes', ...productionArgs], h.options), 0);
    assert.match(h.calls.at(-1).args.at(-1), /'baseline'\);$/);
});

test('production apply runs the reviewed files that belong on production (0019-0021 applied), 0012 skipped, each pinned and logged', () => {
    const applied = files.filter(f => !f.file.endsWith('0012_compute_reverse_moves.sql'));
    const h = productionHarness();
    assert.equal(run(['apply', '--yes', ...productionArgs], h.options), 0);
    assert.equal(h.calls[0].args.at(-1), 'SELECT system_identifier FROM pg_control_system();');
    const migrations = h.calls.slice(3);
    assert.deepEqual(migrations.map(({ args }) => EXPLICIT_FILES.find(file => args[args.indexOf('-f') + 1].endsWith(`/${file}`))), applied.map(f => f.file));
    assert.ok(EXPLICIT_FILES.includes('docs/aws-computers/sql/0002_image_rebase.sql.txt'));
    // 0012 (reverse moves) is staging-only on production: skipped, never applied.
    assert.match(h.output.join('\n'), /0012_compute_reverse_moves\.sql: staging-only on production; skipped/);
    assert.equal(migrations.some(({ args }) => args.join(' ').includes('0012_compute_reverse_moves')), false);
    for (const { args, settings } of h.calls.slice(1)) {
        const guardIndex = args.findIndex(arg => arg.startsWith('DO $pin$'));
        assert.ok(guardIndex > 0 && args[guardIndex].includes(productionId));
        assert.equal(settings.env.PGHOST, 'localhost');
        assert.equal(settings.env.PGPORT, '5432');
        assert.equal(settings.env.PGSSLMODE, 'disable');
        assert.equal(settings.env.PGHOSTADDR, undefined);
        assert.equal(settings.env.PGSERVICE, undefined);
        assert.equal(args.join(' ').includes(password), false);
    }
    migrations.forEach(({ args }, index) => {
        assert.ok(args.includes('--single-transaction'));
        assert.ok(args.findIndex(arg => arg.startsWith('DO $pin$')) < args.indexOf('-f'));
        assert.ok(args.indexOf('-f') < args.lastIndexOf('-c'));
        assert.ok(args.at(-1).includes(applied[index].file) && args.at(-1).includes(applied[index].sha256));
        assert.match(args.at(-1), /INSERT INTO public\.ezil_staging_schema_log .*'apply'\);$/);
    });
    assert.equal(h.output.filter(line => line.endsWith(': applied')).length, applied.length);
    assert.equal(h.output.join('\n').includes(password), false);
});

test('production apply resumes after logged files and stops on the first failure', () => {
    const h = productionHarness([row(0), row(1)]);
    assert.equal(run(['apply', '--yes', ...productionArgs], h.options), 0);
    // 0 and 1 already logged (skipped); 0012 is staging-only on production (skipped); the rest apply.
    assert.equal(h.calls.length, 3 + files.length - 2 - 1);
    assert.ok(h.calls[3].args[h.calls[3].args.indexOf('-f') + 1].endsWith(files[2].file));
    const failing = productionHarness();
    const successful = failing.options.spawnSyncImpl;
    failing.options.spawnSyncImpl = (...args) => {
        const result = successful(...args);
        return failing.calls.length === 4 ? { status: 1, stdout: password, stderr: productionUrl } : result; // the first migration
    };
    assert.equal(run(['apply', '--yes', ...productionArgs], failing.options), 1);
    assert.equal(failing.calls.length, 4);
    assert.match(failing.output.join('\n'), /stopped without retry/);
    assert.equal(failing.output.join('\n').includes(': applied'), false);
    assert.equal(failing.output.join('\n').includes(password), false);
});

test('production apply refuses before any write on a wrong system id, host, URL or pin argument', () => {
    for (const actual of ['7568749223372036998', '', 'garbage']) {
        const h = productionHarness([], actual);
        assert.equal(run(['apply', '--yes', ...productionArgs], h.options), 1);
        assert.equal(h.calls.length, 1);
        assert.match(h.output.join('\n'), /identifier mismatch/);
    }
    for (const url of [undefined, 'postgres://postgres@db.ezil.work:5432/postgres', 'postgres://postgres@10.63.20.252:5432/postgres',
        'postgres://postgres@127.0.0.1:15432/postgres']) {
        const h = productionHarness();
        h.options.env.BILLING_STAGING_DATABASE_URL = url;
        assert.equal(run(['apply', '--yes', ...productionArgs], h.options), 1);
        assert.equal(h.calls.length, 0);
    }
    for (const args of [['apply', '--yes', '--target', 'aws-production'], ['apply', '--target', 'aws-production', '--expect-system-id', productionId],
        ['apply', '--yes', '--target', 'aws-production', '--expect-system-id', "1'; DROP TABLE x; --"]]) {
        const h = productionHarness();
        assert.equal(run(args, h.options), 1);
        assert.equal(h.calls.length, 0);
    }
});

test('production refuses to baseline any file that must be applied, alone or mixed with allowed files', () => {
    for (const file of neverBaselined) {
        for (const name of [file.split('/').at(-1), file, `./${file}`]) {
            for (const requested of [[name], [files[0].file, name]]) {
                const h = productionHarness();
                assert.equal(run(['baseline', ...requested, '--yes', ...productionArgs], h.options), 1);
                assert.equal(h.calls.length, 0);
                assert.match(h.output.join('\n'), /never baselined/);
            }
        }
        // Preview keeps its baseline path for files applied out of band.
        const preview = previewHarness();
        assert.equal(run(['baseline', file, '--yes', ...previewArgs], preview.options), 0);
    }
});

test('restore progress follows 0009 and is registered as a production snapshot only', () => {
    const file = 'app/drizzle/0010_migration_restore_progress.sql';
    assert.equal(EXPLICIT_FILES.indexOf(file), EXPLICIT_FILES.indexOf('app/drizzle/0009_capacity_demands.sql') + 1);
    const sql = readFileSync(fileURLToPath(new URL(`../../${file}`, import.meta.url)), 'utf8');
    assert.match(sql, /ALTER TABLE public.ezil_compute_migrations ADD COLUMN IF NOT EXISTS restore_progress jsonb/);
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../.github/production-migrations.json', import.meta.url)), 'utf8'));
    assert.deepEqual(manifest.sources.find(source => source.path === file), { path: file, sha256: sha256(sql), kind: 'snapshot' });
    assert.equal(manifest.migrations.some(migration => migration.path === file), false);
});

test('restore progress production baseline refuses before connecting', () => {
    for (const mode of [['baseline', '0010_migration_restore_progress.sql', '--yes'],
        ['baseline', './app/drizzle/0010_migration_restore_progress.sql', '--yes']]) {
        const h = harness([], { BILLING_STAGING_DATABASE_URL: 'postgres://postgres@localhost:5432/postgres' });
        assert.equal(run([...mode, '--target', 'aws-production', '--expect-system-id', previewId], h.options), 1);
        assert.equal(h.calls.length, 0);
        assert.match(h.output.join('\n'), /never baselined/);
    }
});

test('a production log that already has 0000-0011 plans cleanly: only 0019-0021 are pending, 0012 is skipped', () => {
    // Production reality (public.ezil_staging_schema_log on the prod primary): 0000-0011 and the docs/aws-computers
    // SQL are applied; 0012 and 0019-0021 are not. Such a log must not make plan or apply refuse.
    const stagingOrNew = ['0012_compute_reverse_moves.sql', '0019_operator_entitlements.sql', '0020_operator_refusal_receipts.sql', '0021_standard_trial.sql'];
    const logged = files.filter(f => !stagingOrNew.some(n => f.file.endsWith(n))).map(f => ({ ...f, mode: 'apply' }));
    assert.equal(run(['plan', ...productionArgs], productionHarness(logged).options), 0);
    const h = productionHarness(logged);
    assert.equal(run(['apply', '--yes', ...productionArgs], h.options), 0);
    const appliedNow = h.output.filter(line => line.endsWith(': applied')).map(line => line.slice(0, line.indexOf(':')));
    assert.deepEqual(appliedNow, ['app/drizzle/0019_operator_entitlements.sql', 'app/drizzle/0020_operator_refusal_receipts.sql', 'app/drizzle/0021_standard_trial.sql']);
    assert.match(h.output.join('\n'), /0012_compute_reverse_moves\.sql: staging-only on production; skipped/);
});

test('feedback follows 0010 and is registered as a production snapshot only', () => {
    const file = 'app/drizzle/0011_feedback.sql';
    assert.equal(EXPLICIT_FILES.indexOf(file), EXPLICIT_FILES.indexOf('app/drizzle/0010_migration_restore_progress.sql') + 1);
    assert.equal(EXPLICIT_FILES.indexOf('app/drizzle/0012_compute_reverse_moves.sql'), EXPLICIT_FILES.indexOf(file) + 1);
    const sql = readFileSync(fileURLToPath(new URL(`../../${file}`, import.meta.url)), 'utf8');
    for (const table of ['ezil_feedback_reports', 'ezil_feedback_attachments', 'ezil_feedback_access_log']) {
        assert.match(sql, new RegExp(`CREATE TABLE public\\.${table} \\(`));
        assert.match(sql, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY;`));
        assert.match(sql, new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM public, anon, authenticated;`));
    }
    assert.match(sql, /deploy_sha text NULL/);
    assert.doesNotMatch(sql, /PRIMARY KEY|DEFAULT|UNIQUE|REFERENCES|CREATE POLICY|DROP |TRUNCATE/i);
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../.github/production-migrations.json', import.meta.url)), 'utf8'));
    assert.deepEqual(manifest.sources.find(source => source.path === file), { path: file, sha256: sha256(sql), kind: 'snapshot' });
    assert.equal(manifest.migrations.some(migration => migration.path === file), false);
});

test('feedback production baseline refuses before connecting', () => {
    for (const mode of [['baseline', '0011_feedback.sql', '--yes'],
        ['baseline', './app/drizzle/0011_feedback.sql', '--yes']]) {
        const h = harness([], { BILLING_STAGING_DATABASE_URL: 'postgres://postgres@localhost:5432/postgres' });
        assert.equal(run([...mode, '--target', 'aws-production', '--expect-system-id', previewId], h.options), 1);
        assert.equal(h.calls.length, 0);
        assert.match(h.output.join('\n'), /never baselined/);
    }
});

test('reverse moves follow 0011 and are registered as a production snapshot only', () => {
    const file = 'app/drizzle/0012_compute_reverse_moves.sql';
    assert.equal(EXPLICIT_FILES.indexOf(file), EXPLICIT_FILES.indexOf('app/drizzle/0011_feedback.sql') + 1);
    const sql = readFileSync(fileURLToPath(new URL(`../../${file}`, import.meta.url)), 'utf8');
    // A NEW table: 0006 (the forward table) is never altered or relaxed.
    assert.match(sql, /CREATE TABLE public\.ezil_compute_reverse_moves \(/);
    assert.doesNotMatch(sql, /ezil_compute_migrations|ALTER TABLE public\.(?!ezil_compute_reverse_moves )/);
    assert.match(sql, /state text NOT NULL DEFAULT 'requested' CHECK \(state IN \('requested', 'booting', 'exporting', 'copying', 'checking', 'flipping', 'committed', 'failed_reopened', 'failed_needs_operator'\)\)/);
    assert.match(sql, /CREATE UNIQUE INDEX ezil_compute_reverse_moves_one_active_per_computer\s+ON public\.ezil_compute_reverse_moves \(computer_id\)\s+WHERE state NOT IN \('committed', 'failed_reopened'\);/);
    assert.match(sql, /ALTER TABLE public\.ezil_compute_reverse_moves ENABLE ROW LEVEL SECURITY;/);
    assert.match(sql, /REVOKE ALL ON TABLE public\.ezil_compute_reverse_moves FROM public, anon, authenticated;/);
    assert.doesNotMatch(sql, /GRANT |CREATE POLICY |DISABLE ROW LEVEL SECURITY|DROP |TRUNCATE|CREATE (?:OR REPLACE )?(?:FUNCTION|TRIGGER)/i);
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../.github/production-migrations.json', import.meta.url)), 'utf8'));
    assert.deepEqual(manifest.sources.find(source => source.path === file), { path: file, sha256: sha256(sql), kind: 'snapshot' });
    assert.equal(manifest.migrations.some(migration => migration.path === file), false);
});

test('reverse moves (0012) stay staging-only on production: baseline refused, and a full apply skips it', () => {
    for (const mode of [['baseline', '0012_compute_reverse_moves.sql', '--yes'],
        ['baseline', './app/drizzle/0012_compute_reverse_moves.sql', '--yes']]) {
        const h = harness([], { BILLING_STAGING_DATABASE_URL: 'postgres://postgres@localhost:5432/postgres' });
        assert.equal(run([...mode, '--target', 'aws-production', '--expect-system-id', previewId], h.options), 1);
        assert.equal(h.calls.length, 0);
        assert.match(h.output.join('\n'), /staging-only; production apply\/baseline is forbidden/);
    }
    // A full production apply succeeds but NEVER applies 0012 (it is skipped), while 0019-0021 do apply.
    const h = productionHarness();
    assert.equal(run(['apply', '--yes', ...productionArgs], h.options), 0);
    assert.match(h.output.join('\n'), /0012_compute_reverse_moves\.sql: staging-only on production; skipped/);
    assert.equal(h.output.join('\n').includes('0012_compute_reverse_moves.sql: applied'), false);
    for (const f of ['0019_operator_entitlements.sql', '0020_operator_refusal_receipts.sql', '0021_standard_trial.sql']) {
        assert.ok(h.output.join('\n').includes(`${f}: applied`));
    }
});

// Product entitlements v1 (producer ezil-os): two new tables, additive; staging-only like 0011/0012.
test('operator entitlements follow 0012, stay additive, server-only and a production snapshot only', () => {
    const file = 'app/drizzle/0019_operator_entitlements.sql';
    assert.equal(EXPLICIT_FILES.indexOf(file), EXPLICIT_FILES.indexOf('app/drizzle/0012_compute_reverse_moves.sql') + 1);
    assert.equal(EXPLICIT_FILES.indexOf('app/drizzle/0020_operator_refusal_receipts.sql'), EXPLICIT_FILES.indexOf(file) + 1);
    const sql = readFileSync(fileURLToPath(new URL(`../../${file}`, import.meta.url)), 'utf8');
    // New tables only: no existing (Stripe, billing or compute) table is altered or written.
    assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.ezil_operator_entitlements \(/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.ezil_operator_entitlement_events \(/);
    assert.doesNotMatch(sql, /ezil_billing_|ALTER TABLE public\.(?!ezil_operator_entitlement)|INSERT INTO|UPDATE public|DELETE FROM|TRUNCATE|DROP TABLE/i);
    assert.match(sql, /sku text NOT NULL CHECK \(sku IN \('standard_monthly_v3', 'premium_monthly_v3'\)\)/);
    assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS ezil_operator_entitlements_one_live\s+ON public\.ezil_operator_entitlements \(user_id\) WHERE ended_at IS NULL;/);
    assert.match(sql, /command_id uuid NOT NULL UNIQUE/);
    assert.match(sql, /BEFORE UPDATE OR DELETE ON public\.ezil_operator_entitlement_events/);
    for (const table of ['ezil_operator_entitlements', 'ezil_operator_entitlement_events']) {
        assert.match(sql, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY;`));
        assert.match(sql, new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM public, anon, authenticated;`));
    }
    assert.doesNotMatch(sql, /GRANT |CREATE POLICY |DISABLE ROW LEVEL SECURITY/i);
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../.github/production-migrations.json', import.meta.url)), 'utf8'));
    assert.deepEqual(manifest.sources.find(source => source.path === file), { path: file, sha256: sha256(sql), kind: 'snapshot' });
    assert.equal(manifest.migrations.some(migration => migration.path === file), false);
});

test('operator entitlements (0019) production baseline refuses: it must be applied, never baselined', () => {
    for (const mode of [['baseline', '0019_operator_entitlements.sql', '--yes'], ['baseline', './app/drizzle/0019_operator_entitlements.sql', '--yes']]) {
        const h = harness([], { BILLING_STAGING_DATABASE_URL: 'postgres://postgres@localhost:5432/postgres' });
        assert.equal(run([...mode, '--target', 'aws-production', '--expect-system-id', previewId], h.options), 1);
        assert.equal(h.calls.length, 0);
        assert.match(h.output.join('\n'), /never baselined/);
    }
});


test('operator refusal receipts follow immutable 0019 and are a production snapshot only', () => {
    const file = 'app/drizzle/0020_operator_refusal_receipts.sql';
    assert.equal(EXPLICIT_FILES.indexOf(file), EXPLICIT_FILES.indexOf('app/drizzle/0019_operator_entitlements.sql') + 1);
    assert.equal(EXPLICIT_FILES.indexOf('app/drizzle/0021_standard_trial.sql'), EXPLICIT_FILES.indexOf(file) + 1);
    const sql = readFileSync(fileURLToPath(new URL(`../../${file}`, import.meta.url)), 'utf8');
    assert.match(sql, /ALTER COLUMN assignment_ref DROP NOT NULL/);
    assert.match(sql, /ALTER COLUMN revision DROP NOT NULL/);
    assert.match(sql, /ADD CONSTRAINT ezil_operator_entitlement_events_result_links/);
    assert.doesNotMatch(sql, /GRANT |CREATE POLICY |DISABLE ROW LEVEL SECURITY|DROP TABLE|INSERT INTO|UPDATE public|DELETE FROM|TRUNCATE/i);
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../.github/production-migrations.json', import.meta.url)), 'utf8'));
    assert.deepEqual(manifest.sources.find(source => source.path === file), { path: file, sha256: sha256(sql), kind: 'snapshot' });
    assert.equal(manifest.migrations.some(migration => migration.path === file), false);
});

test('operator refusal receipts (0020) production baseline refuses: it must be applied, never baselined', () => {
    for (const mode of [['baseline', '0020_operator_refusal_receipts.sql', '--yes'],
        ['baseline', './app/drizzle/0020_operator_refusal_receipts.sql', '--yes']]) {
        const h = harness([], { BILLING_STAGING_DATABASE_URL: 'postgres://postgres@localhost:5432/postgres' });
        assert.equal(run([...mode, '--target', 'aws-production', '--expect-system-id', previewId], h.options), 1);
        assert.equal(h.calls.length, 0);
        assert.match(h.output.join('\n'), /never baselined/);
    }
});

// Standard trial (request standard-trial-01b28d18): one new table, three nullable subscription columns, two widened
// grant CHECKs and a partial unique index. Additive, staging-only, a production snapshot only.
test('the Standard trial follows 0020, stays additive and is a production snapshot only', () => {
    const file = 'app/drizzle/0021_standard_trial.sql';
    assert.equal(EXPLICIT_FILES.indexOf(file), EXPLICIT_FILES.indexOf('app/drizzle/0020_operator_refusal_receipts.sql') + 1);
    assert.equal(EXPLICIT_FILES.indexOf('app/drizzle/0022_feedback_notifications.sql'), EXPLICIT_FILES.indexOf(file) + 1);
    const sql = readFileSync(fileURLToPath(new URL(`../../${file}`, import.meta.url)), 'utf8');
    assert.match(sql, /CREATE TABLE "ezil_billing_trials" \(/);
    // Review R4: every verified identity of a started trial, append-only, removed only with its trial.
    assert.match(sql, /CREATE TABLE "ezil_billing_trial_identities" \(/);
    assert.match(sql, /ALTER TABLE "ezil_billing_trial_identities" ENABLE ROW LEVEL SECURITY;/);
    assert.match(sql, /REFERENCES "public"\."ezil_billing_trials"\("id"\) ON DELETE cascade ON UPDATE cascade;/);
    assert.match(sql, /CREATE POLICY "Service role full access billing trial identities"/);
    for (const constraint of ['user_unique', 'subject_unique', 'email_unique', 'checkout_unique', 'subscription_unique', 'bound_chk']) {
        assert.match(sql, new RegExp(`CONSTRAINT "ezil_billing_trials_${constraint}"`));
    }
    assert.match(sql, /ALTER TABLE "ezil_billing_trials" ENABLE ROW LEVEL SECURITY;/);
    assert.match(sql, /CREATE POLICY "Service role full access billing trials"\s+ON "ezil_billing_trials" FOR ALL USING \(auth\.role\(\) = 'service_role'\);/);
    for (const column of ['trial_start', 'trial_end', 'first_paid_at']) {
        assert.match(sql, new RegExp(`ALTER TABLE "ezil_billing_subscriptions" ADD COLUMN "${column}" timestamp with time zone;`));
    }
    assert.match(sql, /'upgrade_prorated', 'trial_period'\)\);/);
    assert.match(sql, /'dispute', 'trial'\)\);/);
    assert.match(sql, /CREATE UNIQUE INDEX "ezil_billing_grants_trial_once_uidx" ON "ezil_billing_grants" USING btree \("user_id","meter"\) WHERE "ezil_billing_grants"\."kind" = 'trial_period';/);
    // Nothing is dropped except the two CHECKs it re-adds wider; no data is written.
    // cb1: each CHECK widening is DROP IF EXISTS plus ADD, inside 0021's one transaction.
    assert.deepEqual([...sql.matchAll(/DROP CONSTRAINT IF EXISTS "([^"]+)"/g)].map(match => match[1]),
        ['ezil_billing_grants_kind_chk', 'ezil_billing_grants_source_type_chk']);
    // Review R4: the only DML is the capture hook's own insert into the identities table, inside its function body;
    // it runs on auth.users changes and deletions and never writes auth.users itself.
    const hook = /CREATE FUNCTION "public"\."ezil_billing_trial_identity_capture"\(\)[\s\S]*?\$\$([\s\S]*?)\$\$;/.exec(sql);
    assert.ok(hook, 'capture hook function');
    assert.deepEqual([...hook[1].matchAll(/INSERT INTO ([\w.]+)/g)].map(match => match[1]),
        ['public.ezil_billing_trial_identities', 'public.ezil_billing_paid_identities']);
    // Paid history per verified person: an append-only identity table with no user link.
    assert.match(sql, /CREATE TABLE "ezil_billing_paid_identities" \(/);
    assert.match(sql, /ALTER TABLE "ezil_billing_paid_identities" ENABLE ROW LEVEL SECURITY;/);
    assert.match(sql, /CREATE POLICY "Service role full access billing paid identities"/);
    assert.match(hook[1], /EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING/);
    assert.match(sql, /SECURITY DEFINER\s+SET search_path = ''/);
    assert.match(sql, /CREATE TRIGGER "ezil_billing_trial_identity_on_change"\s+AFTER UPDATE OF "email", "email_confirmed_at", "raw_app_meta_data" ON "auth"\."users"/);
    assert.match(sql, /CREATE TRIGGER "ezil_billing_trial_identity_on_delete"\s+BEFORE DELETE ON "auth"\."users"/);
    assert.match(sql, /REVOKE ALL ON FUNCTION "public"\."ezil_billing_trial_identity_capture"\(\) FROM public, anon, authenticated;/);
    const outside = sql.replace(hook[0], '');
    assert.doesNotMatch(outside, /DROP (?:TABLE|COLUMN|INDEX)|INSERT INTO|UPDATE "|UPDATE public|DELETE FROM|TRUNCATE|GRANT |DISABLE ROW LEVEL SECURITY|ALTER TABLE "auth"/i);
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../.github/production-migrations.json', import.meta.url)), 'utf8'));
    assert.deepEqual(manifest.sources.find(source => source.path === file), { path: file, sha256: sha256(sql), kind: 'snapshot' });
    assert.equal(manifest.migrations.some(migration => migration.path === file), false);
});

test('Standard trial (0021) production baseline refuses: it must be applied, never baselined', () => {
    for (const mode of [['baseline', '0021_standard_trial.sql', '--yes'], ['baseline', './app/drizzle/0021_standard_trial.sql', '--yes']]) {
        const h = harness([], { BILLING_STAGING_DATABASE_URL: 'postgres://postgres@localhost:5432/postgres' });
        assert.equal(run([...mode, '--target', 'aws-production', '--expect-system-id', previewId], h.options), 1);
        assert.equal(h.calls.length, 0);
        assert.match(h.output.join('\n'), /never baselined/);
    }
});


test('feedback notifications follow Standard trial, remain server-only and cannot baseline on production', () => {
    const file = 'app/drizzle/0022_feedback_notifications.sql';
    assert.equal(EXPLICIT_FILES.indexOf(file), EXPLICIT_FILES.indexOf('app/drizzle/0021_standard_trial.sql') + 1);
    assert.equal(EXPLICIT_FILES.indexOf('app/drizzle/0023_operator_issued_by.sql'), EXPLICIT_FILES.indexOf(file) + 1);
    const sql = readFileSync(fileURLToPath(new URL(`../../${file}`, import.meta.url)), 'utf8');
    assert.match(sql, /CREATE TABLE public\.ezil_feedback_notifications/);
    assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
    assert.match(sql, /REVOKE ALL ON TABLE public\.ezil_feedback_notifications FROM public, anon, authenticated/);
    assert.doesNotMatch(sql, /INSERT|CREATE TRIGGER|CREATE POLICY|DEFAULT|PRIMARY KEY|FOREIGN KEY/);
    const h = productionHarness();
    assert.equal(run(['baseline', '0022_feedback_notifications.sql', '--yes', ...productionArgs], h.options), 1);
    assert.equal(h.calls.length, 0);
});

// Issuing organization (0023): one nullable column and its CHECK on the operator table, after 0022; a snapshot only.
test('the issuing organization follows 0022, stays additive and is a production snapshot only', () => {
    const file = 'app/drizzle/0023_operator_issued_by.sql';
    assert.equal(EXPLICIT_FILES.indexOf(file), EXPLICIT_FILES.indexOf('app/drizzle/0022_feedback_notifications.sql') + 1);
    assert.equal(EXPLICIT_FILES.indexOf('app/drizzle/0024_telemetry_alerts.sql'), EXPLICIT_FILES.indexOf(file) + 1);
    const sql = readFileSync(fileURLToPath(new URL(`../../${file}`, import.meta.url)), 'utf8');
    assert.match(sql, /ALTER TABLE public\.ezil_operator_entitlements ADD COLUMN IF NOT EXISTS issued_by text;/);
    assert.match(sql, /ADD CONSTRAINT ezil_operator_entitlements_issued_by CHECK \(issued_by IS NULL OR/);
    // No NUL in a PostgreSQL regex: text cannot hold it, and the control range starts at U+0001.
    assert.doesNotMatch(sql, /\\u0000/);
    // Escapes only: no raw invisible or non-ASCII character in the file, and the bidi/Arabic-mark/BOM ranges are present.
    assert.doesNotMatch(sql, /[^\x09\x0a\x20-\x7e]/);
    for (const escape of ['\\u061c', '\\u200b-\\u200f', '\\u2028-\\u202e', '\\u2060-\\u2069', '\\ufeff', '\\u0001-\\u001f', '\\u007f-\\u009f']) assert.ok(sql.includes(escape), escape);
    assert.doesNotMatch(sql, /DROP |INSERT INTO|UPDATE public|DELETE FROM|TRUNCATE|GRANT |NOT NULL|DEFAULT /i);
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../.github/production-migrations.json', import.meta.url)), 'utf8'));
    assert.deepEqual(manifest.sources.find(source => source.path === file), { path: file, sha256: sha256(sql), kind: 'snapshot' });
    assert.equal((manifest.migrations ?? []).some(migration => migration.path === file), false);
});

test('issuing organization (0023) must be applied on production, never baselined', () => {
    for (const name of ['0023_operator_issued_by.sql', './app/drizzle/0023_operator_issued_by.sql']) {
        const h = productionHarness();
        assert.equal(run(['baseline', name, '--yes', ...productionArgs], h.options), 1);
        assert.equal(h.calls.length, 0);
        assert.match(h.output.join('\n'), /never baselined/);
    }
});

// Incident alerts (0024) and AI request traces (0025): the exact staging-released files, appended after 0023.
const stageReleased = {
    'app/drizzle/0024_telemetry_alerts.sql': '05023bae8b6b38a17fec0e425baca20287b4858198d10e307eb003e1569f2456',
    'app/drizzle/0025_ai_request_traces.sql': 'b7c8f09b07e77b1abbec520aebd490c759e8deb50f48dd0f7af060457f1a0a87',
};

test('incident alerts and AI traces (0024, 0025) follow 0023 in order, before 0030, with the exact released bytes', () => {
    assert.deepEqual(EXPLICIT_FILES.slice(-4), ['app/drizzle/0023_operator_issued_by.sql', ...Object.keys(stageReleased), 'app/drizzle/0030_delegation_replay.sql']);
    for (const [file, digest] of Object.entries(stageReleased)) {
        assert.equal(files.find(entry => entry.file === file).sha256, digest);
        assert.equal(buildPlan(files, []).find(row => row.file === file).status, 'pending');
    }
});

test('incident alerts and AI traces (0024, 0025) must be applied on production, never baselined', () => {
    for (const file of Object.keys(stageReleased)) {
        for (const name of [file.split('/').at(-1), file, `./${file}`]) {
            const h = productionHarness();
            assert.equal(run(['baseline', name, '--yes', ...productionArgs], h.options), 1);
            assert.equal(h.calls.length, 0);
            assert.match(h.output.join('\n'), /never baselined/);
        }
    }
});

test('production apply really runs 0024 and 0025 after 0023, then 0030, and still skips 0012', () => {
    const h = productionHarness();
    assert.equal(run(['apply', '--yes', ...productionArgs], h.options), 0);
    const applied = h.calls.slice(3).map(({ args }) => EXPLICIT_FILES.find(file => args[args.indexOf('-f') + 1].endsWith(`/${file}`)));
    assert.deepEqual(applied.slice(-4), ['app/drizzle/0023_operator_issued_by.sql', ...Object.keys(stageReleased), 'app/drizzle/0030_delegation_replay.sql']);
    assert.equal(applied.includes('app/drizzle/0012_compute_reverse_moves.sql'), false);
    for (const file of Object.keys(stageReleased)) assert.ok(h.output.includes(`${file}: applied`));
});

test('the staging log (22 rows, without 0002_image_rebase, 0022 and the new 0030) leaves 0022 and 0030 pending after the supported 0002 baseline', () => {
    const imageRebase = 'docs/aws-computers/sql/0002_image_rebase.sql.txt';
    const feedback = 'app/drizzle/0022_feedback_notifications.sql';
    const replay = 'app/drizzle/0030_delegation_replay.sql';
    const logged = files.filter(({ file }) => file !== imageRebase && file !== feedback && file !== replay)
        .map(({ file, sha256: digest }) => ({ file, sha256: digest, mode: 'apply' }));
    assert.equal(logged.length, 22);
    // Before the baseline all three are genuinely pending; 0002 is never counted as applied by default.
    assert.deepEqual(buildPlan(files, logged).filter(row => row.status === 'pending').map(row => row.file), [imageRebase, feedback, replay]);
    // The supported single-file baseline of 0002 (its catalog checked out of band by rebase_schema) logs only that file.
    const h = harness(logged);
    assert.equal(run(['baseline', '0002_image_rebase.sql.txt', '--yes'], h.options), 0);
    const last = h.calls.at(-1).args.at(-1);
    assert.ok(last.includes(imageRebase) && last.includes(files.find(({ file }) => file === imageRebase).sha256));
    assert.match(last, /'baseline'\);$/);
    assert.equal(h.calls.some(({ args }) => args.includes('-f')), false);
    const baselined = [...logged, { file: imageRebase, sha256: files.find(({ file }) => file === imageRebase).sha256, mode: 'baseline' }];
    const plan = buildPlan(files, baselined);
    assert.deepEqual(plan.filter(row => row.status === 'pending').map(row => row.file), [feedback, replay]);
    assert.equal(plan.find(row => row.file === imageRebase).status, 'applied (baseline)');
    for (const file of Object.keys(stageReleased)) assert.equal(plan.find(row => row.file === file).status, 'applied (apply)');
    // A drifted 0024/0025 log hash is refused, never re-run or rebaselined.
    const drifted = baselined.map(row => row.file === 'app/drizzle/0025_ai_request_traces.sql' ? { ...row, sha256: '0'.repeat(64) } : row);
    assert.throws(() => buildPlan(files, drifted), /SHA-256 mismatch: app\/drizzle\/0025_ai_request_traces\.sql/);
});

// Delegation replay ledger (0030): one new table, server-only, applied for real on production after 0025.
const replayFile = 'app/drizzle/0030_delegation_replay.sql';
const replayEntry = files.find(f => f.file === replayFile);
const beforeReplay = () => files.filter(f => f.file !== replayFile && !f.file.endsWith('0012_compute_reverse_moves.sql')).map(f => ({ ...f, mode: 'apply' }));

test('a logged 0030 is skipped while pending 0024 and 0025 still run, in order, in a full production apply', () => {
    const logged = files.filter(f => !Object.keys(stageReleased).includes(f.file) && !f.file.endsWith('0012_compute_reverse_moves.sql')).map(f => ({ ...f, mode: 'apply' }));
    assert.ok(logged.some(row => row.file === replayFile));
    const h = productionHarness(logged);
    assert.equal(run(['apply', '--yes', ...productionArgs], h.options), 0);
    const runs = h.calls.filter(({ args }) => args.includes('-f')).map(({ args }) => args[args.indexOf('-f') + 1]);
    assert.equal(runs.length, 2);
    Object.keys(stageReleased).forEach((file, i) => assert.ok(runs[i].endsWith(`/${file}`), file));
    assert.equal(h.calls.filter(({ args }) => args.at(-1).includes('INSERT INTO')).length, 2);
    assert.ok(h.output.includes(`${replayFile}: already logged; skipped`));
    assert.equal(h.output.includes(`${replayFile}: applying`), false);
});

test('the delegation replay ledger is last, after 0025, additive, server-only and a production snapshot only', () => {
    assert.equal(EXPLICIT_FILES.at(-1), replayFile);
    assert.equal(EXPLICIT_FILES.indexOf(replayFile), EXPLICIT_FILES.indexOf('app/drizzle/0025_ai_request_traces.sql') + 1);
    assert.equal(EXPLICIT_FILES.filter(file => file === replayFile).length, 1);
    const sql = readFileSync(fileURLToPath(new URL(`../../${replayFile}`, import.meta.url)), 'utf8');
    // A bare CREATE TABLE: a pre-existing table fails the apply (and rolls back) instead of being silently adopted.
    assert.match(sql, /^CREATE TABLE public\.ezil_delegation_replay \(/m);
    assert.match(sql, /CREATE UNIQUE INDEX ezil_delegation_replay_jti_key ON public\.ezil_delegation_replay \(jti\);/);
    assert.match(sql, /ALTER TABLE public\.ezil_delegation_replay ENABLE ROW LEVEL SECURITY;/);
    assert.match(sql, /REVOKE ALL ON TABLE public\.ezil_delegation_replay FROM public, anon, authenticated;/);
    assert.doesNotMatch(sql, /GRANT |CREATE POLICY |DISABLE ROW LEVEL SECURITY|DROP |INSERT INTO|UPDATE |DELETE FROM|TRUNCATE|ALTER TABLE public\.(?!ezil_delegation_replay)/i);
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../.github/production-migrations.json', import.meta.url)), 'utf8'));
    assert.deepEqual(manifest.sources.find(source => source.path === replayFile), { path: replayFile, sha256: sha256(sql), kind: 'snapshot' });
    assert.equal(manifest.migrations.some(migration => migration.path === replayFile), false);
    assert.equal(sha256(sql), replayEntry.sha256);
});

test('delegation replay ledger (0030) must be applied on production, never baselined, alone or mixed', () => {
    for (const name of ['0030_delegation_replay.sql', replayFile, `./${replayFile}`]) {
        for (const requested of [[name], [files[0].file, name]]) {
            const h = productionHarness();
            assert.equal(run(['baseline', ...requested, '--yes', ...productionArgs], h.options), 1);
            assert.equal(h.calls.length, 0);
            assert.match(h.output.join('\n'), /delegation replay ledger must be applied on production, never baselined/);
        }
    }
    // Preview keeps its baseline path for files applied out of band.
    assert.equal(run(['baseline', replayFile, '--yes', ...previewArgs], previewHarness().options), 0);
});

test('production apply with 0000-0025 logged runs only 0030: pinned, hash-checked, one transaction with its ledger row', () => {
    const h = productionHarness(beforeReplay());
    assert.equal(run(['apply', '--yes', ...productionArgs], h.options), 0);
    const migrations = h.calls.filter(({ args }) => args.includes('-f'));
    assert.equal(migrations.length, 1);
    const { args, settings } = migrations[0];
    assert.ok(args[args.indexOf('-f') + 1].endsWith(`/${replayFile}`));
    assert.ok(args.includes('--single-transaction'));
    const pin = args.findIndex(arg => arg.startsWith('DO $pin$'));
    assert.ok(pin >= 0 && args[pin].includes(productionId) && pin < args.indexOf('-f') && args.indexOf('-f') < args.lastIndexOf('-c'));
    assert.match(args.at(-1), new RegExp(`INSERT INTO public\\.ezil_staging_schema_log .*${replayFile}.*${replayEntry.sha256}.*'apply'\\);$`));
    assert.equal(settings.env.PGHOST, 'localhost');
    assert.equal(settings.env.PGHOSTADDR, undefined);
    // Ordered after the system-id probe, the log create and the log read; nothing else ran a schema file or an insert.
    assert.equal(h.calls.findIndex(call => call === migrations[0]), 3);
    assert.equal(h.calls.filter(({ args: a }) => a.at(-1).includes('INSERT INTO')).length, 1);
    assert.deepEqual(h.output.filter(line => line.includes('0030')), [`${replayFile}: applying`, `${replayFile}: applied`]);
    assert.equal(h.output.join('\n').includes(password), false);
});

test('production plan shows 0030 pending, and apply from an empty log runs it last after every earlier file', () => {
    const plan = productionHarness(beforeReplay());
    assert.equal(run(['plan', ...productionArgs], plan.options), 0);
    assert.match(plan.output.join('\n'), new RegExp(`${replayFile}  ${replayEntry.sha256}  pending`));
    assert.equal(plan.calls.some(({ args }) => args.includes('-f')), false);
    const h = productionHarness();
    assert.equal(run(['apply', '--yes', ...productionArgs], h.options), 0);
    const applied = h.calls.filter(({ args }) => args.includes('-f')).map(({ args }) => args[args.indexOf('-f') + 1]);
    assert.ok(applied.at(-1).endsWith(`/${replayFile}`));
    assert.equal(applied.length, EXPLICIT_FILES.length - 1);
});

test('a failed 0030 stops with no retry, never logs, and an already logged 0030 is skipped', () => {
    const h = productionHarness(beforeReplay());
    const original = h.options.spawnSyncImpl;
    h.options.spawnSyncImpl = (command, args, settings) => {
        const result = original(command, args, settings);
        return args.includes('-f') ? { status: 3, stdout: '', stderr: `relation exists ${password}` } : result;
    };
    assert.equal(run(['apply', '--yes', ...productionArgs], h.options), 1);
    assert.equal(h.calls.filter(({ args }) => args.includes('-f')).length, 1);
    assert.match(h.output.join('\n'), /psql failed; stopped without retry/);
    assert.equal(h.output.join('\n').includes(password), false);
    assert.equal(h.output.join('\n').includes('relation exists'), false);
    const done = productionHarness([...beforeReplay(), { ...replayEntry, mode: 'apply' }]);
    assert.equal(run(['apply', '--yes', ...productionArgs], done.options), 0);
    assert.equal(done.calls.some(({ args }) => args.includes('-f')), false);
    assert.match(done.output.join('\n'), new RegExp(`${replayFile}: already logged; skipped`));
});

test('a 0030 ledger row with a different checksum refuses before any schema write, in plan and apply', () => {
    const logged = [...beforeReplay(), { file: replayFile, sha256: 'f'.repeat(64), mode: 'apply' }];
    for (const mode of [['plan'], ['apply', '--yes']]) {
        const h = productionHarness(logged);
        assert.equal(run([...mode, ...productionArgs], h.options), 1);
        assert.match(h.output.join('\n'), new RegExp(`SHA-256 mismatch: ${replayFile}`));
        assert.equal(h.calls.some(({ args }) => args.includes('-f') || args.at(-1).includes('INSERT INTO')), false);
    }
});

test('a system id mismatch or wrong host blocks 0030 before the ledger is even created', () => {
    const wrongId = productionHarness(beforeReplay(), '1234');
    assert.equal(run(['apply', '--yes', ...productionArgs], wrongId.options), 1);
    assert.equal(wrongId.calls.length, 1);
    const wrongHost = harness(beforeReplay(), { BILLING_STAGING_DATABASE_URL: `postgres://postgres:${password}@10.63.20.252:5432/postgres` });
    assert.equal(run(['apply', '--yes', ...productionArgs], wrongHost.options), 1);
    assert.equal(wrongHost.calls.length, 0);
});

test('0030 is a required explicit file: removing it from the directory refuses ordering', () => {
    const drizzle = EXPLICIT_FILES.filter(f => f.startsWith('app/drizzle/')).map(f => f.split('/').at(-1));
    const placement = EXPLICIT_FILES.filter(f => f.startsWith('docs/aws-computers/sql/')).map(f => f.split('/').at(-1));
    assert.ok(orderFiles(drizzle, placement).includes(replayFile));
    assert.throws(() => orderFiles(drizzle.filter(n => n !== '0030_delegation_replay.sql'), placement), new RegExp(`Required schema file missing: ${replayFile}`));
});

// Targeted apply (--only <file>): exactly one reviewed file; the default apply above still runs every pending file.
const schemaRuns = h => h.calls.filter(({ args }) => args.includes('-f'));
const insertsOf = h => h.calls.filter(({ args }) => args.at(-1).includes('INSERT INTO'));

test('--only parses for apply only, once, with a value; plan and baseline refuse it', () => {
    assert.equal(parseArgs(['apply', '--only', replayFile, '--yes', ...productionArgs]).only, replayFile);
    assert.equal(parseArgs(['apply', '--yes', ...productionArgs]).only, undefined);
    for (const bad of [['apply', '--only', '--yes'], ['apply', '--yes', '--only'], ['apply', '--only', 'a.sql', '--only', 'b.sql', '--yes'],
        ['plan', '--only', replayFile], ['baseline', replayFile, '--only', replayFile, '--yes'], ['apply', replayFile, '--only', replayFile, '--yes']]) {
        assert.throws(() => parseArgs([...bad, ...productionArgs]));
    }
    assert.throws(() => parseArgs(['apply', '--only', replayFile, ...productionArgs]), /requires --yes/);
});

test('production --only 0030 with every earlier file still pending runs exactly 0030 and no other SQL', () => {
    for (const name of [replayFile]) {
        const h = productionHarness();
        assert.equal(run(['apply', '--only', name, '--yes', ...productionArgs], h.options), 0);
        const runs = schemaRuns(h);
        assert.equal(runs.length, 1);
        assert.ok(runs[0].args[runs[0].args.indexOf('-f') + 1].endsWith(`/${replayFile}`));
        // The only calls: system-id probe, log create, log read, then 0030 itself; one ledger insert, for 0030.
        assert.equal(h.calls.length, 4);
        assert.equal(h.calls[0].args.at(-1), 'SELECT system_identifier FROM pg_control_system();');
        assert.equal(insertsOf(h).length, 1);
        const { args, settings } = runs[0];
        assert.ok(args.includes('--single-transaction'));
        const pin = args.findIndex(arg => arg.startsWith('DO $pin$'));
        assert.ok(pin >= 0 && args[pin].includes(productionId) && pin < args.indexOf('-f') && args.indexOf('-f') < args.lastIndexOf('-c'));
        assert.match(args.at(-1), new RegExp(`${replayFile}.*${replayEntry.sha256}.*'apply'\\);$`));
        assert.equal(settings.env.PGHOST, 'localhost');
        assert.equal(settings.env.PGHOSTADDR, undefined);
        // Unselected pending files: no SQL, no insert, no hash or name in any argument, no "applying" line.
        for (const other of files.filter(f => f.file !== replayFile)) {
            assert.equal(h.calls.some(({ args: a }) => a.some(arg => arg.includes(other.file) || arg.includes(other.sha256))), false, other.file);
        }
        assert.deepEqual(h.output.filter(line => line.endsWith(': applying') || line.endsWith(': applied')), [`${replayFile}: applying`, `${replayFile}: applied`]);
        assert.equal(h.output.some(line => line.includes('staging-only on production')), false);
    }
});

test('--only refuses unknown, outside-the-list, ambiguous and staging-only files before any psql call', () => {
    for (const name of ['0031_nothing.sql', 'app/drizzle/0030_delegation_replay.sql.bak', '../app/drizzle/0030_delegation_replay.sql',
        '/etc/passwd', 'app/drizzle/', '0030', '0003_pool_hosts_v2.sql.txt' + 'x']) {
        const h = productionHarness();
        assert.equal(run(['apply', '--only', name, '--yes', ...productionArgs], h.options), 1);
        assert.equal(h.calls.length, 0, name);
        assert.match(h.output.join('\n'), /--only accepts only app\/drizzle\/0030_delegation_replay\.sql/);
    }
    // 0012 is staging-only on production: even an explicit selection is refused.
    for (const name of ['0012_compute_reverse_moves.sql', './app/drizzle/0012_compute_reverse_moves.sql']) {
        const h = productionHarness();
        assert.equal(run(['apply', '--only', name, '--yes', ...productionArgs], h.options), 1);
        assert.equal(h.calls.length, 0);
        assert.match(h.output.join('\n'), /--only accepts only app\/drizzle\/0030_delegation_replay\.sql/);
    }
    // Multiple files are not selectable by any spelling.
    for (const argv of [['apply', '--only', replayFile, '--only', files[0].file, '--yes'], ['apply', '--only', `${replayFile},${files[0].file}`, '--yes'],
        ['apply', '--only', replayFile, files[0].file, '--yes']]) {
        const h = productionHarness();
        assert.equal(run([...argv, ...productionArgs], h.options), 1);
        assert.equal(h.calls.length, 0);
    }
});

test('--only accepts ONLY the canonical 0030 path: every other reviewed file, alias or target makes no psql call', () => {
    assert.equal(TARGETED_APPLY_FILE, replayFile);
    const others = EXPLICIT_FILES.filter(file => file !== replayFile);
    assert.equal(others.length, EXPLICIT_FILES.length - 1);
    const harnesses = { production: [productionHarness, productionArgs], preview: [previewHarness, previewArgs] };
    for (const [, [make, targetArgs]] of Object.entries(harnesses)) {
        for (const file of others) {
            for (const name of [file, `./${file}`, file.split('/').at(-1)]) {
                const h = make();
                assert.equal(run(['apply', '--only', name, '--yes', ...targetArgs], h.options), 1, name);
                assert.equal(h.calls.length, 0, name);
                assert.match(h.output.join('\n'), /--only accepts only app\/drizzle\/0030_delegation_replay\.sql/);
            }
        }
        // Even the 0030 aliases are refused: only the exact canonical path is accepted.
        for (const name of ['0030_delegation_replay.sql', `./${replayFile}`, `${replayFile}/`, replayFile.toUpperCase(), ` ${replayFile}`]) {
            const h = make();
            assert.equal(run(['apply', '--only', name, '--yes', ...targetArgs], h.options), 1, name);
            assert.equal(h.calls.length, 0, name);
        }
    }
    // The default staging target (URL pin only) refuses another file too.
    const staging = harness();
    assert.equal(run(['apply', '--only', files[0].file, '--yes'], staging.options), 1);
    assert.equal(staging.calls.length, 0);
    // The canonical path still works, and unrelated pending files stay unexecuted (re-proved on this exact spelling).
    const ok = productionHarness();
    assert.equal(run(['apply', '--only', replayFile, '--yes', ...productionArgs], ok.options), 0);
    assert.equal(schemaRuns(ok).length, 1);
    assert.equal(insertsOf(ok).length, 1);
    assert.equal(ok.calls.length, 4);
});

test('--only keeps the pin, checksum, log and failure protections, and never baselines', () => {
    // Wrong system id: only the probe runs.
    const wrongId = productionHarness([], '1234');
    assert.equal(run(['apply', '--only', replayFile, '--yes', ...productionArgs], wrongId.options), 1);
    assert.equal(wrongId.calls.length, 1);
    // A tampered ledger row for an UNSELECTED file still refuses the whole run before any write.
    const tampered = productionHarness([{ ...files[0], sha256: 'f'.repeat(64), mode: 'apply' }]);
    assert.equal(run(['apply', '--only', replayFile, '--yes', ...productionArgs], tampered.options), 1);
    assert.match(tampered.output.join('\n'), new RegExp(`SHA-256 mismatch: ${files[0].file}`));
    assert.equal(schemaRuns(tampered).length + insertsOf(tampered).length, 0);
    // An already logged 0030 is skipped: no SQL at all beyond the log read.
    const done = productionHarness([{ ...replayEntry, mode: 'apply' }]);
    assert.equal(run(['apply', '--only', replayFile, '--yes', ...productionArgs], done.options), 0);
    assert.equal(schemaRuns(done).length + insertsOf(done).length, 0);
    assert.match(done.output.join('\n'), new RegExp(`${replayFile}: already logged; skipped`));
    // A failing 0030 stops with suppressed diagnostics and no ledger insert of its own.
    const failing = productionHarness();
    const original = failing.options.spawnSyncImpl;
    failing.options.spawnSyncImpl = (command, args, settings) => {
        const result = original(command, args, settings);
        return args.includes('-f') ? { status: 3, stdout: '', stderr: password } : result;
    };
    assert.equal(run(['apply', '--only', replayFile, '--yes', ...productionArgs], failing.options), 1);
    assert.equal(schemaRuns(failing).length, 1);
    assert.equal(failing.output.join('\n').includes(password), false);
    // Production baseline of 0030 is still refused, with --only never reachable from baseline.
    const baseline = productionHarness();
    assert.equal(run(['baseline', replayFile, '--yes', ...productionArgs], baseline.options), 1);
    assert.equal(baseline.calls.length, 0);
});

test('without --only a production apply still runs every pending file, and --only works on preview with the same pin', () => {
    const full = productionHarness();
    assert.equal(run(['apply', '--yes', ...productionArgs], full.options), 0);
    assert.equal(schemaRuns(full).length, EXPLICIT_FILES.length - 1);
    const preview = previewHarness();
    assert.equal(run(['apply', '--only', replayFile, '--yes', ...previewArgs], preview.options), 0);
    assert.equal(schemaRuns(preview).length, 1);
    assert.ok(preview.calls.at(-1).args.some(arg => arg.startsWith('DO $pin$')));
});
