/**
 * PR-only, explicit-selection hosted migrations. Node >= 20; no dependencies.
 * From the repository root (arguments are basenames, in _journal.json order):
 *   node app/scripts/ci-migrate.mjs --dry-run 0002_os_access.sql
 *   node app/scripts/ci-migrate.mjs --apply 0003_example.sql
 * CI supplies SUPABASE_ACCESS_TOKEN; apply also requires GITHUB_ACTIONS=true
 * and GITHUB_EVENT_NAME=pull_request. Never put the token in arguments.
 *
 * There is no hosted Drizzle journal (docs/RUNBOOK.md). Nothing is discovered
 * or replayed automatically, including 0000/0001/0002. Explicitly selecting an
 * old file does NOT make it idempotent. The caller must determine the changed
 * files from the PR diff, preserve manifest order, and skip an empty selection.
 *
 * Each file uses one transaction/request, in order, stopping at first failure.
 * Earlier files may have committed; do not blindly retry an uncertain outcome.
 * No journal, baseline, remote state checks, retries, or deployment are provided.
 *
 * The conservative SQL guard accepts CREATE TABLE, CREATE INDEX, CREATE POLICY,
 * and limited ALTER TABLE only for public.ezil_* tables created in that file.
 * This is a source-scope guard, NOT a PostgreSQL parser or a SQL sandbox:
 * expressions/functions, FK side effects, policies and existing DB objects still
 * need review. Unsupported DDL requires a separately reviewed migration route.
 * CI must protect the runner, manifest and SQL, review same-repository PRs before
 * exposing secrets, and serialize jobs against the shared project. Environment
 * checks prevent accidental invocation; they are not an authorization boundary.
 */
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DRIZZLE_DIR = fileURLToPath(new URL('../drizzle/', import.meta.url));
const ENDPOINT = 'https://api.supabase.com/v1/projects/btgqfmnzycdecmeyqubx/database/query';
const BASENAME = /^\d{4}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
const MAX_BYTES = 1024 * 1024;
const USAGE = 'usage: node app/scripts/ci-migrate.mjs (--dry-run | --apply) <basename.sql> [...]';

class Refusal extends Error {}
function requireSafe(condition, message) {
    if (!condition) throw new Refusal(message);
}

// Refuse symlinks, hard links, special files and oversized inputs. Open with
// O_NOFOLLOW as well as checking realpath, then read through the checked handle.
async function readCanonical(path) {
    requireSafe(await realpath(path) === path, 'noncanonical source refused');
    const info = await lstat(path);
    requireSafe(info.isFile() && info.nlink === 1 && info.size <= MAX_BYTES,
        'source must be a regular, unlinked file of at most 1 MiB');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const opened = await handle.stat();
        requireSafe(opened.isFile() && opened.nlink === 1 && opened.size <= MAX_BYTES
            && opened.ino === info.ino && opened.dev === info.dev, 'source changed during validation');
        const bytes = await handle.readFile();
        requireSafe(bytes.length <= MAX_BYTES, 'source exceeds 1 MiB');
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } finally {
        await handle.close();
    }
}

// Lex only enough to recognize statement boundaries and object targets without
// confusing comments or strings with SQL. Dollar strings, escape strings and
// Unicode escapes deliberately fail closed rather than being guessed at.
function tokenize(sql) {
    requireSafe(!sql.includes('\0'), 'NUL in SQL refused');
    const tokens = [];
    let i = 0;
    while (i < sql.length) {
        const rest = sql.slice(i);
        const space = /^\s+/.exec(rest);
        if (space) { i += space[0].length; continue; }
        if (rest.startsWith('--')) {
            const end = rest.search(/[\r\n]/);
            i = end < 0 ? sql.length : i + end + 1;
            continue;
        }
        if (rest.startsWith('/*')) {
            let depth = 1;
            i += 2;
            while (i < sql.length && depth) {
                if (sql.startsWith('/*', i)) { depth++; i += 2; }
                else if (sql.startsWith('*/', i)) { depth--; i += 2; }
                else i++;
            }
            requireSafe(depth === 0, 'unterminated SQL comment');
            continue;
        }
        requireSafe(!/^(?:[eEbBxXnN]'|[uU]&["']|\$|\\)/.test(rest),
            'unsupported SQL quoting or client command');
        if (rest[0] === "'" || rest[0] === '"') {
            const quote = rest[0];
            let value = '';
            let closed = false;
            i++;
            while (i < sql.length) {
                const c = sql[i++];
                requireSafe(c !== '\\', 'SQL backslash escapes refused');
                if (c !== quote) { value += c; continue; }
                if (sql[i] === quote) { value += quote; i++; continue; }
                closed = true;
                break;
            }
            requireSafe(closed, 'unterminated SQL quote');
            tokens.push(quote === '"' ? { id: value } : { literal: true });
            continue;
        }
        const word = /^[A-Za-z_][A-Za-z_0-9$]*/.exec(rest);
        if (word) { tokens.push(word[0].toLowerCase()); i += word[0].length; }
        else { tokens.push(rest[0]); i++; }
    }
    return tokens;
}

function identifier(token) {
    return typeof token === 'string' && /^[a-z_][a-z_0-9]*$/.test(token)
        ? token : token?.id;
}

function relation(tokens, start) {
    const first = identifier(tokens[start]);
    requireSafe(typeof first === 'string', 'missing SQL object name');
    if (tokens[start + 1] === '.') {
        const name = identifier(tokens[start + 2]);
        requireSafe(typeof name === 'string', 'missing qualified SQL object name');
        return { schema: first, name, end: start + 3 };
    }
    return { schema: 'public', name: first, end: start + 1 };
}

function isEzil(table) {
    return table.schema === 'public' && /^ezil_[a-z0-9_]+$/.test(table.name);
}

export function validateSql(sql) {
    const statements = [[]];
    for (const token of tokenize(sql)) {
        if (token === ';') statements.push([]);
        else statements.at(-1).push(token);
    }
    const created = new Set();
    const secured = new Set();
    let count = 0;
    for (const statement of statements) {
        if (!statement.length) continue;
        count++;
        // Also disallow subqueries/CTAS, inheritance and transaction escape.
        const forbidden = new Set(['drop', 'truncate', 'do', 'execute', 'call',
            'copy', 'begin', 'commit', 'rollback', 'savepoint', 'grant', 'revoke',
            'inherits', 'partition', 'like', 'select', 'into', 'tablespace']);
        for (let i = 0; i < statement.length; i++) {
            const token = statement[i];
            // SELECT/INSERT/UPDATE/DELETE are allowed only as policy commands
            // or referential actions, never as standalone/nested DML.
            const policyCommand = statement[0] === 'create' && statement[1] === 'policy'
                && statement[i - 1] === 'for';
            const referenceAction = statement[i - 1] === 'on'
                && statement.includes('references') && (token === 'delete' || token === 'update');
            requireSafe(!(forbidden.has(token) || ['insert', 'update', 'delete', 'merge'].includes(token))
                || (policyCommand && ['select', 'insert', 'update', 'delete'].includes(token))
                || referenceAction, 'unsupported or nonadditive SQL');
            if (token === 'references') {
                const target = relation(statement, i + 1);
                requireSafe(isEzil(target) || (target.schema === 'auth' && target.name === 'users'),
                    'foreign key outside EZiL scope');
            }
        }
        let target;
        if (statement[0] === 'create' && statement[1] === 'table') {
            // IF NOT EXISTS can hide an already-existing shared object; reject it.
            target = relation(statement, 2);
            requireSafe(isEzil(target) && statement[target.end] === '(' && statement.at(-1) === ')'
                && !created.has(target.name), 'CREATE TABLE outside supported EZiL scope');
            let depth = 0;
            for (let i = target.end; i < statement.length; i++) {
                if (statement[i] === '(') depth++;
                if (statement[i] === ')') depth--;
                requireSafe(depth > 0 || (depth === 0 && i === statement.length - 1),
                    'unsupported CREATE TABLE suffix');
            }
            requireSafe(depth === 0, 'unbalanced CREATE TABLE');
            created.add(target.name);
        } else if (statement[0] === 'alter' && statement[1] === 'table') {
            target = relation(statement, 2);
            const tail = statement.slice(target.end);
            const enableRls = tail.join(' ') === 'enable row level security';
            const addConstraint = tail[0] === 'add' && tail[1] === 'constraint'
                && identifier(tail[2]) && ['foreign', 'check', 'unique', 'primary'].includes(tail[3]);
            requireSafe(enableRls || addConstraint, 'unsupported ALTER TABLE');
            // Multiple ALTER actions could hide a rename or RLS disable.
            let depth = 0;
            for (const token of tail) {
                if (token === '(') depth++;
                if (token === ')') depth--;
                requireSafe(!(token === ',' && depth === 0), 'multiple ALTER actions refused');
            }
            if (enableRls) secured.add(target.name);
        } else if (statement[0] === 'create'
            && (statement[1] === 'policy' || statement[1] === 'index'
                || (statement[1] === 'unique' && statement[2] === 'index'))) {
            const nameAt = statement[1] === 'unique' ? 3 : 2;
            requireSafe(identifier(statement[nameAt]) && statement[nameAt + 1] === 'on',
                'unsupported index or policy declaration');
            target = relation(statement, nameAt + 2);
        } else {
            throw new Refusal('unsupported SQL statement');
        }
        requireSafe(isEzil(target) && created.has(target.name),
            'DDL must target an EZiL table created earlier in this file');
    }
    requireSafe(count > 0 && created.size > 0, 'empty migration or no new EZiL tables');
    requireSafe([...created].every((name) => secured.has(name)), 'new tables must enable RLS');
}

export async function loadSelection(names, drizzleDir = DRIZZLE_DIR) {
    requireSafe(names.length > 0 && names.every((name) => BASENAME.test(name)),
        'explicit canonical SQL basenames required');
    requireSafe(new Set(names).size === names.length, 'duplicate migration selection');
    const root = resolve(drizzleDir);
    requireSafe(await realpath(root) === root, 'noncanonical migration directory');
    const manifest = JSON.parse(await readCanonical(join(root, 'meta', '_journal.json')));
    requireSafe(manifest.dialect === 'postgresql' && Array.isArray(manifest.entries),
        'invalid migration manifest');
    const order = new Map();
    let lastIndex = -1;
    for (const entry of manifest.entries) {
        requireSafe(entry && typeof entry.tag === 'string' && BASENAME.test(`${entry.tag}.sql`)
            && Number.isInteger(entry.idx) && entry.idx > lastIndex
            && !order.has(`${entry.tag}.sql`), 'invalid migration manifest entry');
        lastIndex = entry.idx;
        order.set(`${entry.tag}.sql`, order.size);
    }
    let previous = -1;
    const selected = [];
    for (const name of names) {
        const index = order.get(name);
        requireSafe(index !== undefined && index > previous, 'selection must follow manifest order');
        previous = index;
        const sql = await readCanonical(join(root, name));
        try { validateSql(sql); }
        catch (error) {
            if (error instanceof Refusal) throw new Refusal(`${name}: ${error.message}`);
            throw error;
        }
        selected.push({ name, sql });
    }
    return selected;
}

export async function run(argv, {
    env = process.env, fetchImpl = globalThis.fetch, log = console.log,
    drizzleDir = DRIZZLE_DIR,
} = {}) {
    try {
        if (argv.length === 1 && argv[0] === '--help') { log(USAGE); return 0; }
        const [mode, ...names] = argv;
        requireSafe(mode === '--dry-run' || mode === '--apply', USAGE);
        const selected = await loadSelection(names, drizzleDir);
        if (mode === '--dry-run') {
            for (const { name } of selected) log(`${name}: dry-run validated`);
            return 0;
        }
        requireSafe(env.GITHUB_ACTIONS === 'true' && env.GITHUB_EVENT_NAME === 'pull_request',
            'apply requires a GitHub Actions pull_request event');
        const token = env.SUPABASE_ACCESS_TOKEN;
        requireSafe(typeof token === 'string' && token.length > 0 && !/\s/.test(token),
            'SUPABASE_ACCESS_TOKEN missing or invalid');
        for (const { name, sql } of selected) {
            log(`${name}: applying`);
            let response;
            try {
                response = await fetchImpl(ENDPOINT, {
                    method: 'POST', redirect: 'error',
                    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ query: 'BEGIN;\n'
                        + "SET LOCAL search_path = public, pg_catalog;\n"
                        + "SET LOCAL lock_timeout = '5s';\n"
                        + "SET LOCAL statement_timeout = '60s';\n"
                        + `${sql}\n;\nCOMMIT;` }),
                    signal: AbortSignal.timeout(90_000),
                });
            } catch {
                log(`${name}: failed (transport; outcome unconfirmed; stopped, no retry)`);
                return 1;
            }
            // Never print or parse API bodies: errors may contain SQL or data.
            if (response.body) await response.body.cancel().catch(() => {});
            if (!response.ok) {
                const status = Number.isInteger(response.status) ? response.status : 'unknown';
                log(`${name}: failed (HTTP ${status}; stopped, no retry)`);
                return 1;
            }
            log(`${name}: applied`);
        }
        return 0;
    } catch (error) {
        log(`refused: ${error instanceof Refusal ? error.message : 'source validation failed'}`);
        return 1;
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = await run(process.argv.slice(2));
}
