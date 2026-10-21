#!/usr/bin/env node
// Hand-run staging only. Intentionally independent of the production runner.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STAGING_REF = 'yjnwyugyhfpalqpqrnnt';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const EXPLICIT_FILES = Object.freeze([
    'app/drizzle/0000_massive_mole_man.sql',
    'app/drizzle/0001_telemetry.sql',
    'app/drizzle/0002_os_access.sql',
    'app/drizzle/0003_billing.sql',
    'app/drizzle/0004_billing_v2.sql',
    'app/drizzle/0005_billing_sessions.sql',
    'app/drizzle/0006_compute_migrations.sql',
    'app/drizzle/0007_paid_session_deadlines.sql',
    'docs/aws-computers/sql/0001_compute_placement.sql.txt',
    'docs/aws-computers/sql/0002_ready_pool.sql.txt',
]);
const TABLE = 'public.ezil_staging_schema_log';
const HASH = /^[a-f0-9]{64}$/;
class Refusal extends Error {}
const refuse = (message) => { throw new Refusal(message); };

export function validateDatabaseUrl(value, target = 'ezil-os-awstest') {
    if (!['ezil-os-awstest', 'aws-preview'].includes(target)) refuse('Unknown staging target.');
    if (!value || typeof value !== 'string') refuse('BILLING_STAGING_DATABASE_URL is required.');
    let decoded = value;
    let invalidEncoding = false;
    try { decoded = decodeURIComponent(value); } catch { invalidEncoding = true; }
    // Check the entire URL, including password/path/query, before accepting the pin.
    const inspected = `${value}\n${decoded}`.toLowerCase();
    if (inspected.includes('btgqfmnzycdecmeyqubx')) refuse('LIVE production project btgqfmnzycdecmeyqubx is forbidden (including its preview alias).');
    if (inspected.includes('curomaahbwlrddzijatd')) refuse('Website project curomaahbwlrddzijatd is forbidden.');
    if (invalidEncoding) refuse('Invalid staging database URL encoding.');
    let url;
    try { url = new URL(value); } catch { refuse('Invalid staging database URL.'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.hash || /[\u0000-\u0020\u007f]/.test(value) || decoded.includes('\0')) {
        refuse('Expected a PostgreSQL database URL without whitespace or a fragment.');
    }
    const user = decodeURIComponent(url.username);
    if (!/^[a-zA-Z0-9.-]+$/.test(url.hostname) ||
        !/^[a-zA-Z0-9_-]*$/.test(decodeURIComponent(url.pathname.replace(/^\//, '')))) {
        refuse('Expected a single DNS host and a plain database name.');
    }
    if (target === 'aws-preview') {
        const tunnel = ['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === '15432';
        const privateHost = url.hostname === '10.61.20.35' && url.port === '5432';
        if (!tunnel && !privateHost) refuse('aws-preview requires localhost or 127.0.0.1:15432, or 10.61.20.35:5432.');
    } else if (!url.hostname.includes(STAGING_REF) && !user.includes(STAGING_REF)) {
        refuse(`Staging project pin missing: host or user must contain ${STAGING_REF}.`);
    }
    // libpq query parameters can override the pinned authority (host, user,
    // hostaddr, service, dbname). Only non-routing options are accepted.
    for (const [key, option] of url.searchParams) {
        if (key === 'sslmode' && ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'].includes(option)) continue;
        if (key === 'connect_timeout' && /^\d+$/.test(option)) continue;
        refuse('Unsupported database URL query option; only sslmode and connect_timeout are allowed.');
    }
    return url;
}

// Used on every emitted message, including controlled errors and filenames.
export function redact(message, databaseUrl) {
    let result = String(message);
    if (!databaseUrl) return result;
    const hidden = [databaseUrl];
    try {
        const password = new URL(databaseUrl).password;
        hidden.push(password, decodeURIComponent(password));
    } catch { /* Invalid URLs are never included in diagnostics. */ }
    for (const value of hidden.filter(Boolean).sort((a, b) => b.length - a.length)) {
        result = result.split(value).join('[REDACTED]');
    }
    return result;
}

export function orderFiles(drizzleNames, placementNames) {
    const present = new Set([
        ...drizzleNames.map((name) => `app/drizzle/${name}`),
        ...placementNames.map((name) => `docs/aws-computers/sql/${name}`),
    ]);
    for (const file of EXPLICIT_FILES) {
        if (!present.has(file)) refuse(`Required schema file missing: ${file}`);
    }
    const v3 = drizzleNames.filter((name) => name.includes('v3') && name.endsWith('.sql')).sort();
    if (v3.some((name) => !/^[a-zA-Z0-9_.-]+\.sql$/.test(name))) refuse('Invalid v3 schema filename.');
    return [...new Set([...EXPLICIT_FILES, ...v3.map((name) => `app/drizzle/${name}`)])];
}

export const sha256 = (content) => createHash('sha256').update(content).digest('hex');

export function buildPlan(files, logged = null) {
    const rows = new Map();
    if (logged !== null) {
        if (!Array.isArray(logged)) refuse('Invalid staging schema log.');
        for (const row of logged) {
            if (!row || typeof row.file !== 'string' || !HASH.test(row.sha256) ||
                !['apply', 'baseline'].includes(row.mode) || rows.has(row.file)) refuse('Invalid staging schema log row.');
            if (!files.some(({ file }) => file === row.file)) refuse('Staging schema log contains a file outside the reviewed list.');
            rows.set(row.file, row);
        }
    }
    return files.map(({ file, sha256: digest }) => {
        const row = rows.get(file);
        if (row && row.sha256 !== digest) refuse(`SHA-256 mismatch: ${file}`);
        return { file, sha256: digest, status: logged === null ? null : row ? `applied (${row.mode})` : 'pending' };
    });
}

export function renderPlan(files, logged = null) {
    return buildPlan(files, logged).map(({ file, sha256: digest, status }) =>
        `${file}  ${digest}${status === null ? '' : `  ${status}`}`).join('\n');
}

export function parseArgs(args) {
    let yes = false, target = 'ezil-os-awstest', expectSystemId;
    const positional = [], seen = new Set();
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--yes') { yes = true; continue; }
        if (arg === '--target' || arg === '--expect-system-id') {
            if (seen.has(arg) || !args[i + 1] || args[i + 1].startsWith('--')) refuse(`Missing or duplicate ${arg}.`);
            seen.add(arg);
            const value = args[++i];
            if (arg === '--target') target = value;
            else expectSystemId = value;
        } else if (arg.startsWith('--')) refuse('Unknown staging option.');
        else positional.push(arg);
    }
    if (!['ezil-os-awstest', 'aws-preview'].includes(target)) refuse('Unknown staging target.');
    if (target === 'aws-preview' && !/^[0-9]+$/.test(expectSystemId ?? '')) refuse('aws-preview requires --expect-system-id <digits>.');
    if (target !== 'aws-preview' && expectSystemId !== undefined) refuse('--expect-system-id requires --target aws-preview.');
    const mode = positional.shift() ?? 'plan';
    if (!['plan', 'apply', 'baseline'].includes(mode)) refuse('Usage: billing-staging-schema.mjs [plan | apply --yes | baseline <file...> --yes] [--target ezil-os-awstest|aws-preview] [--expect-system-id <digits>]');
    if (mode !== 'plan' && !yes) refuse(`${mode} requires --yes.`);
    if (mode === 'baseline' ? positional.length === 0 : positional.length !== 0) refuse('Only baseline accepts file arguments; baseline needs at least one file.');
    return { mode, files: positional, yes, target, expectSystemId };
}

const literal = (value) => `E'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
const insertSQL = (entry, mode) => `INSERT INTO ${TABLE} (file, sha256, mode) VALUES (${literal(entry.file)}, ${literal(entry.sha256)}, ${literal(mode)});`;

export function run(args = process.argv.slice(2), {
    env = process.env,
    spawnSyncImpl = spawnSync,
    write = (message) => console.log(message),
} = {}) {
    const databaseUrl = env.BILLING_STAGING_DATABASE_URL;
    const emit = (message) => write(redact(message, databaseUrl));
    try {
        const { mode, files: requested, target, expectSystemId } = parseArgs(args);
        const connection = databaseUrl ? validateDatabaseUrl(databaseUrl, target) : null;
        if (!connection && (mode !== 'plan' || target === 'aws-preview')) refuse('BILLING_STAGING_DATABASE_URL is required.');
        const ordered = orderFiles(readdirSync(resolve(ROOT, 'app/drizzle')), readdirSync(resolve(ROOT, 'docs/aws-computers/sql')));
        const files = ordered.map((file) => ({ file, sha256: sha256(readFileSync(resolve(ROOT, file))) }));
        const selected = new Set(requested.map((name) => {
            const normalized = name.replace(/^\.\//, '');
            const matches = ordered.filter((file) => file === normalized || basename(file) === normalized);
            if (matches.length !== 1) refuse('Baseline file must uniquely name a file in the plan.');
            return matches[0];
        }));
        if (!databaseUrl) {
            emit(renderPlan(files));
            return 0;
        }

        // No URL/password in argv, no psql startup file, password prompts or
        // inherited libpq routing overrides. Never forward child diagnostics.
        const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('PG') && key !== 'BILLING_STAGING_DATABASE_URL'));
        // Pass individual libpq fields: PGDATABASE is a database NAME, not a
        // reliable URI expansion mechanism. No inherited host can take effect.
        Object.assign(childEnv, {
            PGHOST: connection.hostname,
            PGPORT: connection.port || '5432',
            PGUSER: decodeURIComponent(connection.username) || 'postgres',
            PGPASSWORD: decodeURIComponent(connection.password),
            PGDATABASE: decodeURIComponent(connection.pathname.replace(/^\//, '')) || 'postgres',
            PGSSLMODE: connection.searchParams.get('sslmode') || (target === 'aws-preview' ? 'disable' : 'require'),
            PGCONNECT_TIMEOUT: connection.searchParams.get('connect_timeout') || '15',
            PGPASSFILE: '/dev/null',
        });
        const psql = (parameters) => {
            let result;
            try {
                result = spawnSyncImpl('psql', ['-X', '--no-password', '-v', 'ON_ERROR_STOP=1', '-q', '-A', '-t', ...(target === 'aws-preview' && !parameters.includes('SELECT system_identifier FROM pg_control_system();') ?
                        ['-c', `DO $pin$ BEGIN IF (SELECT system_identifier::text FROM pg_control_system()) IS DISTINCT FROM ${literal(expectSystemId)} THEN RAISE EXCEPTION 'Preview system identifier mismatch'; END IF; END; $pin$;`] : []), ...parameters], {
                    cwd: ROOT, env: childEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
                });
            } catch { refuse('psql could not start; diagnostics suppressed to protect credentials.'); }
            if (result.error || result.signal || result.status !== 0) refuse('psql failed; stopped without retry. Outcome may be unconfirmed; run plan before retrying. Diagnostics suppressed to protect credentials.');
            return result.stdout;
        };
        // Verify before even creating the log. Each later psql call opens a new
        // connection, so repeat the pin inside that same session before its SQL.
        if (target === 'aws-preview') {
            const actual = psql(['-c', 'SELECT system_identifier FROM pg_control_system();']).trim();
            if (!/^[0-9]+$/.test(actual) || actual !== expectSystemId) refuse('Preview system identifier mismatch; no schema operation performed.');
        }
        psql(['--single-transaction', '-c', `CREATE TABLE IF NOT EXISTS ${TABLE} (file text primary key, sha256 text not null, applied_at timestamptz not null default now(), mode text not null);`]);
        let logged;
        try {
            logged = JSON.parse(psql(['-c', `SELECT COALESCE(json_agg(row_to_json(entry)), '[]'::json)::text FROM (SELECT file, sha256, mode FROM ${TABLE} ORDER BY file) entry;`]));
        } catch (error) {
            if (error instanceof Refusal) throw error;
            refuse('Could not read the staging schema log; database output suppressed.');
        }
        // Validate the whole log before printing a plan or changing any schema file.
        if (!Array.isArray(logged)) refuse('Invalid staging schema log.');
        const plan = buildPlan(files, logged);
        if (mode === 'plan') {
            emit(renderPlan(files, logged));
            return 0;
        }
        for (const entry of plan) {
            if (mode === 'baseline' && !selected.has(entry.file)) continue;
            if (entry.status !== 'pending') {
                emit(`${entry.file}: already logged; skipped`);
                continue;
            }
            if (sha256(readFileSync(resolve(ROOT, entry.file))) !== entry.sha256) refuse(`SHA-256 mismatch: ${entry.file}`);
            // -f and the following -c execute in the SAME transaction: a failed
            // migration or log insert cannot leave an unlogged committed schema.
            const parameters = ['--single-transaction'];
            if (mode === 'apply') parameters.push('-f', resolve(ROOT, entry.file));
            parameters.push('-c', insertSQL(entry, mode));
            emit(`${entry.file}: ${mode === 'apply' ? 'applying' : 'baselining'}`);
            psql(parameters);
            emit(`${entry.file}: ${mode === 'apply' ? 'applied' : 'baselined'}`);
        }
        return 0;
    } catch (error) {
        emit(error instanceof Refusal ? error.message : 'Staging schema operation failed; diagnostics suppressed to protect credentials.');
        return 1;
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = run();
}
