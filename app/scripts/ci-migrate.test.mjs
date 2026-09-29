import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadSelection, run, validateSql } from './ci-migrate.mjs';

const OLD = ['0000_massive_mole_man.sql', '0001_telemetry.sql', '0002_os_access.sql'];
const NEW = ['0003_ci_first.sql', '0004_ci_second.sql'];
const TEST_TOKEN = 'fake-token-never-send';
const APPLY_ENV = {
    GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', SUPABASE_ACCESS_TOKEN: TEST_TOKEN,
};
const additive = (name = 'ezil_ci_first') => `CREATE TABLE "public"."${name}" (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), label text DEFAULT 'private SQL marker'
);
--> statement-breakpoint
ALTER TABLE "public"."${name}" ENABLE ROW LEVEL SECURITY;
CREATE INDEX "${name}_idx" ON "public"."${name}" (id);
CREATE POLICY "service only" ON "public"."${name}" FOR ALL USING (auth.role() = 'service_role');`;

async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'ezil-ci-migrate-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const drizzleDir = join(root, 'drizzle');
    await mkdir(join(drizzleDir, 'meta'), { recursive: true });
    const entries = [...OLD, ...NEW].map((name, idx) => ({ idx, tag: name.slice(0, -4) }));
    await writeFile(join(drizzleDir, 'meta', '_journal.json'), JSON.stringify({ dialect: 'postgresql', entries }));
    for (const [index, name] of [...OLD, ...NEW].entries()) {
        await writeFile(join(drizzleDir, name), additive(`ezil_ci_${index}`));
    }
    const calls = [];
    const logs = [];
    const options = {
        drizzleDir, env: APPLY_ENV, log: (line) => logs.push(line),
        fetchImpl: async (...args) => {
            calls.push(args);
            return new Response('[]', { status: 200 });
        },
    };
    return { root, drizzleDir, calls, logs, options };
}

test('all real migrations pass source validation when explicitly selected', async () => {
    const selected = await loadSelection(OLD);
    assert.deepEqual(selected.map(({ name }) => name), OLD);
});

test('dry-run neither reads a token nor calls fetch, even inside PR CI', async (t) => {
    const { calls, logs, options } = await fixture(t);
    options.env = { get SUPABASE_ACCESS_TOKEN() { throw new Error('must not read token'); } };
    assert.equal(await run(['--dry-run', NEW[0]], options), 0);
    assert.deepEqual(calls, []);
    assert.deepEqual(logs, [`${NEW[0]}: dry-run validated`]);
});

test('no implicit history replay: only explicitly selected files are posted', async (t) => {
    const { calls, logs, options } = await fixture(t);
    assert.equal(await run(['--apply', NEW[0]], options), 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(logs, [`${NEW[0]}: applying`, `${NEW[0]}: applied`]);
    const [url, request] = calls[0];
    assert.equal(url, 'https://api.supabase.com/v1/projects/btgqfmnzycdecmeyqubx/database/query');
    assert.equal(request.method, 'POST');
    assert.equal(request.redirect, 'error');
    assert.deepEqual(request.headers, {
        Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json',
    });
    assert.ok(request.signal instanceof AbortSignal);
    assert.equal(request.signal.aborted, false);
    const { query } = JSON.parse(request.body);
    assert.match(query, /^BEGIN;\nSET LOCAL search_path = public, pg_catalog;/);
    assert.match(query, /SET LOCAL lock_timeout = '5s';/);
    assert.match(query, /SET LOCAL statement_timeout = '60s';/);
    assert.ok(query.includes(await readFile(join(options.drizzleDir, NEW[0]), 'utf8')));
    assert.match(query, /\n;\nCOMMIT;$/);
    assert.ok(!query.includes('ezil_ci_0'));
    assert.ok(!logs.join('\n').includes(TEST_TOKEN));
    assert.ok(!logs.join('\n').includes('private SQL marker'));
});

test('an old migration runs only when its basename is explicitly selected', async (t) => {
    const { calls, options } = await fixture(t);
    assert.equal(await run(['--apply', OLD[1]], options), 0);
    assert.equal(calls.length, 1);
    assert.match(JSON.parse(calls[0][1].body).query, /ezil_ci_1/);
});

test('requests are sequential and preserve a noncontiguous manifest selection', async (t) => {
    const { logs, options } = await fixture(t);
    let active = false;
    let calls = 0;
    options.fetchImpl = async () => {
        assert.equal(active, false);
        active = true;
        await new Promise((resolve) => setImmediate(resolve));
        active = false;
        calls++;
        return new Response('[]');
    };
    assert.equal(await run(['--apply', OLD[2], NEW[1]], options), 0);
    assert.equal(calls, 2);
    assert.deepEqual(logs, [
        `${OLD[2]}: applying`, `${OLD[2]}: applied`, `${NEW[1]}: applying`, `${NEW[1]}: applied`,
    ]);
});

test('invalid selections fail before fetch and do not echo arbitrary arguments', async (t) => {
    const { calls, logs, options } = await fixture(t);
    const args = [
        [], ['--apply'], ['--dry-run'], ['--all'], [NEW[0]],
        ['--apply', '--dry-run', NEW[0]], ['--apply', NEW[0], NEW[0]],
        ['--apply', NEW[1], NEW[0]], ['--apply', '9999_unknown.sql'],
        ...['../secret.sql', '/tmp/secret.sql', 'app/drizzle/0003_ci_first.sql',
            '..\\secret.sql', '0003_ci_first.sql/../secret.sql', '*.sql',
            '0003_ci_first.SQL', '0003_ci_first.sql\nPRIVATE', '0003_ci_first.sql\0',
            '0003_%2e%2e.sql', '--token=PRIVATE'].map((name) => ['--apply', name]),
    ];
    for (const argv of args) assert.equal(await run(argv, options), 1, JSON.stringify(argv));
    assert.deepEqual(calls, []);
    assert.ok(!logs.join('\n').includes('PRIVATE'));
});

test('apply requires PR CI and a nonempty token, never silently dry-runs', async (t) => {
    const { calls, options } = await fixture(t);
    for (const env of [
        {}, { SUPABASE_ACCESS_TOKEN: TEST_TOKEN },
        { ...APPLY_ENV, GITHUB_EVENT_NAME: 'push' },
        { ...APPLY_ENV, GITHUB_EVENT_NAME: 'pull_request_target' },
        { ...APPLY_ENV, GITHUB_EVENT_NAME: 'workflow_dispatch' },
        { ...APPLY_ENV, GITHUB_ACTIONS: 'false' },
        { ...APPLY_ENV, SUPABASE_ACCESS_TOKEN: undefined },
        { ...APPLY_ENV, SUPABASE_ACCESS_TOKEN: '' },
        { ...APPLY_ENV, SUPABASE_ACCESS_TOKEN: ' \n' },
        { ...APPLY_ENV, SUPABASE_ACCESS_TOKEN: `${TEST_TOKEN}\r\nHeader: leak` },
    ]) assert.equal(await run(['--apply', NEW[0]], { ...options, env }), 1);
    assert.deepEqual(calls, []);
});

test('invalid later SQL prevents any earlier request', async (t) => {
    const { calls, options } = await fixture(t);
    await writeFile(join(options.drizzleDir, NEW[1]), 'DROP TABLE public.legacy;');
    assert.equal(await run(['--apply', ...NEW], options), 1);
    assert.deepEqual(calls, []);
});

test('invalid, duplicated and reordered manifest entries are rejected', async (t) => {
    const { calls, options } = await fixture(t);
    const entry = { idx: 0, tag: NEW[0].slice(0, -4) };
    for (const value of [
        '{broken', 'null', JSON.stringify({ entries: [] }),
        ...[
            [null], [{ idx: 0, tag: '../secret' }], [entry, entry],
            [entry, { idx: 1, tag: entry.tag }], [entry, { idx: 0, tag: '0004_ci_second' }],
        ].map((entries) => JSON.stringify({ dialect: 'postgresql', entries })),
    ]) {
        await writeFile(join(options.drizzleDir, 'meta', '_journal.json'), value);
        assert.equal(await run(['--apply', NEW[0]], options), 1);
    }
    assert.deepEqual(calls, []);
});

test('unlisted, missing, empty, oversized and invalid UTF-8 sources are rejected', async (t) => {
    const { calls, options } = await fixture(t);
    await writeFile(join(options.drizzleDir, '0005_unlisted.sql'), additive());
    assert.equal(await run(['--apply', '0005_unlisted.sql'], options), 1);
    await rm(join(options.drizzleDir, NEW[0]));
    assert.equal(await run(['--apply', NEW[0]], options), 1);
    for (const source of ['', '-- comment only', ' '.repeat(1024 * 1024 + 1), Buffer.from([0xff])]) {
        await writeFile(join(options.drizzleDir, NEW[0]), source);
        assert.equal(await run(['--apply', NEW[0]], options), 1);
    }
    assert.deepEqual(calls, []);
});

test('SQL and manifest symlinks, directory aliases and hard links are refused', async (t) => {
    const { root, drizzleDir, calls, options } = await fixture(t);
    const outside = join(root, 'outside.sql');
    await writeFile(outside, additive());
    const selected = join(drizzleDir, NEW[0]);
    await rm(selected);
    await symlink(outside, selected);
    assert.equal(await run(['--apply', NEW[0]], options), 1);
    await rm(selected);
    await link(outside, selected);
    assert.equal(await run(['--apply', NEW[0]], options), 1);
    await rm(selected);
    await mkdir(selected);
    assert.equal(await run(['--apply', NEW[0]], options), 1);
    const alias = join(root, 'alias');
    await symlink(drizzleDir, alias);
    assert.equal(await run(['--apply', NEW[1]], { ...options, drizzleDir: alias }), 1);
    const manifest = join(drizzleDir, 'meta', '_journal.json');
    const copied = join(root, 'manifest.json');
    await writeFile(copied, await readFile(manifest));
    await rm(manifest);
    await symlink(copied, manifest);
    assert.equal(await run(['--apply', NEW[1]], options), 1);
    assert.deepEqual(calls, []);
});

test('HTTP failures including current 401 stop without leaking bodies or retrying', async (t) => {
    const { options } = await fixture(t);
    for (const status of [401, 403, 429, 500, 302]) {
        const logs = [];
        let calls = 0;
        const result = await run(['--apply', ...NEW], {
            ...options, log: (line) => logs.push(line), fetchImpl: async () => {
                calls++;
                return new Response(`PRIVATE SQL ${TEST_TOKEN}`, { status });
            },
        });
        assert.equal(result, 1);
        assert.equal(calls, 1);
        assert.deepEqual(logs, [
            `${NEW[0]}: applying`, `${NEW[0]}: failed (HTTP ${status}; stopped, no retry)`,
        ]);
    }
});

test('later transport failure reports uncertainty, preserves earlier status, and never retries', async (t) => {
    const { logs, options } = await fixture(t);
    let calls = 0;
    options.fetchImpl = async () => {
        if (++calls === 1) return new Response('[]');
        throw new Error(`PRIVATE SQL ${TEST_TOKEN}`);
    };
    assert.equal(await run(['--apply', ...NEW], options), 1);
    assert.equal(calls, 2);
    assert.deepEqual(logs, [
        `${NEW[0]}: applying`, `${NEW[0]}: applied`, `${NEW[1]}: applying`,
        `${NEW[1]}: failed (transport; outcome unconfirmed; stopped, no retry)`,
    ]);
});

test('SQL tokenizer handles comments, strings and identifier quoting without false commands', () => {
    validateSql(`/* outer /* DROP TABLE x; */ still comment */\n${additive()}
        -- DROP TABLE legacy;\n`);
    validateSql(additive().replace("'private SQL marker'", "'DROP TABLE legacy; -- ''text'' /* string */'"));
    validateSql(additive().replace('"service only"', '"service; ""quoted"" only"'));
    validateSql(`${additive()} ALTER TABLE public.ezil_ci_first ADD CONSTRAINT fk
        FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE SET NULL ON UPDATE CASCADE;`);
    validateSql(additive().replace('FOR ALL', 'FOR SELECT'));
});

test('source scope refuses shared-table mutations, unsupported SQL and parser evasions', () => {
    const bad = [
        'DROP TABLE public.legacy;', 'DELETE FROM ezil_ci_first;', 'TRUNCATE ezil_ci_first;',
        'SELECT 1;', 'BEGIN; COMMIT;', 'DO $$ BEGIN NULL; END $$;', '\\i /tmp/secret.sql',
        'CREATE FUNCTION public.evil() RETURNS void AS $$ $$ LANGUAGE sql;',
        additive('legacy'), additive().replaceAll('"public"', '"auth"'),
        additive().replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS'),
        additive().replace(' ENABLE ROW LEVEL SECURITY', ' DISABLE ROW LEVEL SECURITY'),
        additive().replace(' ENABLE ROW LEVEL SECURITY', ' ENABLE ROW LEVEL SECURITY, RENAME TO legacy'),
        additive().replace('CREATE TABLE', 'CREATE UNLOGGED TABLE'),
        'CREATE TABLE ezil_ci_first (id) AS VALUES (1); ALTER TABLE ezil_ci_first ENABLE ROW LEVEL SECURITY;',
        additive().replace('DEFAULT gen_random_uuid()', 'DEFAULT (SELECT id FROM legacy)'),
        additive().replace('DEFAULT gen_random_uuid()', 'DEFAULT E\'escape\''),
        additive().replace('DEFAULT gen_random_uuid()', 'DEFAULT $$string$$'),
        additive().replace('label text', 'label text REFERENCES public.legacy(id)'),
        additive().replace('label text', 'label text REFERENCES "auth"."secrets"(id)'),
        additive().replace('label text', 'label text REFERENCES "other"."ezil_table"(id)'),
        additive().replace('id uuid PRIMARY KEY', 'LIKE public.legacy, id uuid PRIMARY KEY'),
        additive().replace(');\n--> statement-breakpoint', ') INHERITS (public.legacy);\n--> statement-breakpoint'),
        additive().replace('CREATE INDEX', 'CREATE INDEX CONCURRENTLY'),
        additive().replace('ENABLE ROW LEVEL SECURITY;', 'ADD COLUMN foo int;'),
        additive().replace('ENABLE ROW LEVEL SECURITY;', 'ADD CONSTRAINT chk CHECK (true), DISABLE ROW LEVEL SECURITY;'),
        `${additive()} ALTER TABLE public.legacy ADD CONSTRAINT chk CHECK (true);`,
        `${additive()} CREATE INDEX evil_idx ON public.legacy (id);`,
        `${additive()} CREATE POLICY evil_policy ON public.legacy USING (true);`,
        `${additive()} GRANT ALL ON public.ezil_ci_first TO anon;`,
        `${additive()} -- comment\rDROP TABLE legacy;`,
        `${additive()} /* unterminated`, `${additive()} 'unterminated`, `${additive()}\0`,
        additive().replace('ALTER TABLE "public"."ezil_ci_first" ENABLE ROW LEVEL SECURITY;', ''),
        `ALTER TABLE ezil_ci_first ENABLE ROW LEVEL SECURITY; ${additive()}`,
    ];
    for (const sql of bad) assert.throws(() => validateSql(sql), undefined, sql);
});

test('CLI entry point supports help, no-credential dry-run, and failure return codes', async () => {
    const logs = [];
    const options = { env: {}, log: (line) => logs.push(line),
        fetchImpl: () => assert.fail('unexpected fetch') };
    assert.equal(await run(['--help'], options), 0);
    assert.match(logs.pop(), /^usage: /);
    assert.equal(await run(['--dry-run', OLD[2]], options), 0);
    assert.equal(logs.pop(), `${OLD[2]}: dry-run validated`);
    assert.equal(await run([], options), 1);
    assert.equal(await run(['--apply', OLD[2]], options), 1);
    assert.match(logs.pop(), /apply requires a GitHub Actions pull_request event/);
});
