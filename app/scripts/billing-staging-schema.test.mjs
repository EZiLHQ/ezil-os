import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    STAGING_REF, EXPLICIT_FILES, validateDatabaseUrl, redact, orderFiles,
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
    for (const bad of ['postgres://postgres:p@db.ezil.work:5432/postgres', 'postgres://postgres:p@10.63.20.10:5432/postgres',
        'postgres://postgres:p@127.0.0.1:15432/postgres', 'postgres://postgres:p@db.btgqfmnzycdecmeyqubx.supabase.co:5432/postgres']) {
        assert.throws(() => validateDatabaseUrl(bad, 'aws-production'), bad);
    }
});

test('pool v2 is registered after its prerequisite and preserves service-only RLS', () => {
    const file = 'docs/aws-computers/sql/0003_pool_hosts_v2.sql.txt';
    assert.equal(EXPLICIT_FILES.indexOf(file), EXPLICIT_FILES.indexOf('docs/aws-computers/sql/0002_ready_pool.sql.txt') + 1);
    const sql = readFileSync(fileURLToPath(new URL(`../../${file}`, import.meta.url)), 'utf8');
    assert.match(sql, /REVOKE ALL ON TABLE public.ezil_compute_pool_hosts FROM public, anon, authenticated/);
    assert.match(sql, /ALTER TABLE public.ezil_compute_pool_hosts ENABLE ROW LEVEL SECURITY/);
    assert.doesNotMatch(sql, /GRANT |CREATE POLICY |DISABLE ROW LEVEL SECURITY|DROP TABLE|DROP COLUMN/);
    assert.equal((sql.match(/ADD COLUMN IF NOT EXISTS/g) || []).length, 7);
    assert.equal((sql.match(/CREATE INDEX IF NOT EXISTS/g) || []).length, 3);
});

test('pool v2 production apply and baseline refuse before any connection while other baselines still work', () => {
    for (const mode of [['apply', '--yes'], ['baseline', '0003_pool_hosts_v2.sql.txt', '--yes'],
        ['baseline', './docs/aws-computers/sql/0003_pool_hosts_v2.sql.txt', '--yes']]) {
        const h = harness([], { BILLING_STAGING_DATABASE_URL: 'postgres://postgres@localhost:5432/postgres' });
        assert.equal(run([...mode, '--target', 'aws-production', '--expect-system-id', previewId], h.options), 1);
        assert.equal(h.calls.length, 0);
        assert.match(h.output.join('\n'), /staging-only/);
    }
    const plan = previewHarness();
    plan.options.env.BILLING_STAGING_DATABASE_URL = 'postgres://postgres@localhost:5432/postgres';
    assert.equal(run(['plan', '--target', 'aws-production', '--expect-system-id', previewId], plan.options), 0);
    const h = previewHarness();
    h.options.env.BILLING_STAGING_DATABASE_URL = 'postgres://postgres@localhost:5432/postgres';
    assert.equal(run(['baseline', files[0].file, '--yes', '--target', 'aws-production', '--expect-system-id', previewId], h.options), 0);
});
