import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { hash, snapshotHash, tokenize, additiveSQL, validate, run, authorize, query, catalogSQL, applySQL, planSQL, eventTriggersSQL } from '../.github/scripts/production-migrations.mjs';

const command = promisify(execFile);
const project = 'btgqfmnzycdecmeyqubx';
const blank = () => ({ version: 1, repository: 'example/repo', project, schemas: ['app'], sources: [], initialCatalog: null, migrations: [], trustedWorkflowRuns: [], reviewedEventTriggers: [] });
const noNetwork = () => { throw new Error('NETWORK MUST NOT RUN'); };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'production-migrations-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.github'));
  await command('git', ['init', '-q'], { cwd: root });
  const manifest = blank();
  const save = () => writeFile(join(root, '.github/production-migrations.json'), JSON.stringify(manifest));
  await save();
  return { root, manifest, save };
}

test('validate is offline and an uncaptured baseline fails apply before network', async t => {
  const { root } = await fixture(t); const logs = [];
  await run(['validate'], { root, request: noNetwork, env: {}, log: s => logs.push(JSON.parse(s)) });
  assert.equal(logs[0].valid, true); assert.match(logs[0].baseline, /apply disabled/);
  await assert.rejects(run(['apply'], { root, request: noNetwork, env: {} }), /baseline required/);
});

test('inventory, source byte checksums, symlinks and malformed manifests fail closed', async t => {
  const { root, manifest, save } = await fixture(t);
  await writeFile(join(root, 'history.sql'), 'DROP TABLE app.never_run;');
  await assert.rejects(validate(root), /inventory/);
  manifest.sources.push({ path: 'history.sql', sha256: hash('DROP TABLE app.never_run;'), kind: 'snapshot' }); await save();
  await validate(root); // Historical snapshots need not pass executable grammar.
  await writeFile(join(root, 'history.sql'), 'DROP TABLE app.changed;');
  await assert.rejects(validate(root), /checksum/);
  await writeFile(join(root, 'history.sql'), 'DROP TABLE app.never_run;');
  const good = structuredClone(manifest);
  for (const mutate of [m => m.version = 2, m => m.extra = true, m => m.schemas = ['ezil_ci'], m => m.sources.push(m.sources[0]), m => m.sources[0].path = '../history.sql', m => m.initialCatalog = { digest: 'fake' }, m => m.migrations = [{ id: 'bad' }], m => m.trustedWorkflowRuns = ['name'], m => m.project = '../bad', m => m.reviewedEventTriggers = [{name:'x',sha256:'bad'}], m => m.reviewedEventTriggers = [{name:'x',sha256:hash('x')},{name:'x',sha256:hash('x')}]]) {
    const invalid = structuredClone(good); mutate(invalid);
    await writeFile(join(root, '.github/production-migrations.json'), JSON.stringify(invalid));
    await assert.rejects(validate(root));
  }
  await save(); await rm(join(root, 'history.sql')); await writeFile(join(root, 'other.txt'), 'DROP TABLE app.never_run;');
  await symlink(join(root, 'other.txt'), join(root, 'history.sql'));
  await assert.rejects(validate(root), /Symlink/);
});

test('plan reports historical and current snapshot digests separately', async t => {
  const { root, manifest, save } = await fixture(t);
  await writeFile(join(root, 'snapshot.sql'), 'SELECT 1;');
  manifest.sources = [{ path: 'snapshot.sql', sha256: hash('SELECT 1;'), kind: 'snapshot' }];
  await save();
  const observations = [];
  const request = async (_url, init) => {
    assert.equal(JSON.parse(init.body).read_only, true);
    return { ok: true, json: async () => [{ digest: hash('disposable catalog'), objects: 1, schemas: 1, applied: 0 }] };
  };
  const options = { root, env: { SUPABASE_ACCESS_TOKEN: 'fixture-only' }, request, log: line => observations.push(JSON.parse(line)) };
  await run(['plan'], options);
  manifest.initialCatalog = observations[0].observedCatalog;
  assert.equal(manifest.initialCatalog.sourceDigest, snapshotHash(manifest));
  await writeFile(join(root, 'snapshot.sql'), 'SELECT 2;');
  manifest.sources[0].sha256 = hash('SELECT 2;'); await save();
  await run(['plan'], options);
  assert.equal(observations[1].observedCatalog.sourceDigest, manifest.initialCatalog.sourceDigest);
  assert.equal(observations[1].currentSourceDigest, snapshotHash(manifest));
  assert.notEqual(observations[1].currentSourceDigest, manifest.initialCatalog.sourceDigest);
});

test('strict additive grammar handles comments/quoted identifiers and rejects escapes', () => {
  const accepted = ['CREATE TABLE app.example (id integer NOT NULL, name text);', '/* nested /* ; COMMIT */ comment */ ALTER TABLE "app"."example" ADD COLUMN "odd;name" varchar(80);', 'CREATE INDEX example_index ON app.example(id, "odd;name");', 'CREATE TABLE app.one (id pg_catalog.int8); CREATE TABLE app.two (id uuid)'];
  for (const sql of accepted) assert.equal(additiveSQL(sql, ['app']), sql);
  for (const sql of ['COMMIT;', 'BEGIN;', 'ROLLBACK;', 'DROP TABLE app.x;', 'TRUNCATE app.x;', 'DELETE FROM app.x;', 'INSERT INTO app.x VALUES (1);', 'UPDATE app.x SET id=1;', 'CREATE OR REPLACE VIEW app.x AS SELECT 1;', 'CREATE FUNCTION app.x() RETURNS void AS $$BEGIN COMMIT; END$$ LANGUAGE plpgsql;', 'DO $$BEGIN END$$;', 'CREATE TABLE app.x AS SELECT 1;', 'CREATE TABLE app.x (id integer DEFAULT app.mutate());', 'CREATE TABLE app.x (id app.custom);', 'ALTER TABLE app.x ADD COLUMN id integer; COMMIT;', 'ALTER TABLE app.x ADD COLUMN id integer, DROP COLUMN secret;', 'CREATE INDEX x ON app.x ((app.mutate()));', 'CREATE TABLE public.x(id integer);', 'CREATE TABLE app.x(id integer); \\gexec', 'CREATE TABLE app.x(id integer); /*', 'CREATE TABLE app."broken(id integer);', 'CREATE TABLE app.x(id integer); $tag$COMMIT$tag$', "CREATE TABLE app.x(id text DEFAULT E'\\');COMMIT;--');", 'CREATE TABLE app.x(id integer) INHERITS (app.old);', 'CREATE UNIQUE INDEX x ON app.x(id);']) assert.throws(() => additiveSQL(sql, ['app']), undefined, sql);
  assert.equal(tokenize('-- EOF').length, 0);
});

test('CI rejects PRs, stale main, local runs and untrusted workflow_run; trusts fetched main only', async t => {
  const { root, manifest } = await fixture(t);
  await command('git', ['add', '.'], { cwd: root });
  await command('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root });
  const sha = (await command('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  const eventPath = join(tmpdir(), `production-event-${sha}.json`); t.after(() => rm(eventPath, { force: true }));
  const event = { repository: { full_name: manifest.repository }, ref: 'refs/heads/main', after: sha };
  await writeFile(eventPath, JSON.stringify(event));
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: manifest.repository, GITHUB_SHA: sha, GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: eventPath, GITHUB_TOKEN: 'fixture-only' };
  const request = async url => { assert.equal(url, 'https://api.github.com/repos/example/repo/commits/main'); return { ok: true, json: async () => ({ sha }) }; };
  assert.equal(await authorize(manifest, { env, root, request }), sha);
  for (const override of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REF: 'refs/pull/1/merge' }, { GITHUB_REPOSITORY: 'attacker/repo' }]) await assert.rejects(authorize(manifest, { env: { ...env, ...override }, root, request: noNetwork }));
  await assert.rejects(authorize(manifest, { env, root, request: async () => ({ ok: true, json: async () => ({ sha: '0'.repeat(40) }) }) }), /Stale/);
  await writeFile(join(root, 'tested-images.json'), '{}');
  await writeFile(join(root, 'previous-release.json'), '{}');
  assert.equal(await authorize(manifest, { env, root, request }), sha);
  const tracked = join(root, '.github/production-migrations.json'); const original = await readFile(tracked);
  await writeFile(tracked, '{}');
  await assert.rejects(authorize(manifest, { env, root, request }), /clean tracked/);
  await writeFile(tracked, original);
  await writeFile(join(root, 'untracked.sql'), 'SELECT 1;');
  await assert.rejects(validate(root), /inventory/);
  await assert.rejects(authorize(manifest, { env, root, request }), /untracked SQL/);
  await rm(join(root, 'untracked.sql'));
  assert.equal(await authorize(manifest, { env: { ...env, GITHUB_EVENT_NAME: 'workflow_dispatch' }, root, request }), sha);
  const wr = { ...event, action: 'completed', workflow_run: { conclusion: 'success', head_branch: 'main', event: 'push', head_repository: event.repository, head_sha: sha, workflow_id: 42 } };
  await writeFile(eventPath, JSON.stringify(wr));
  await assert.rejects(authorize(manifest, { env: { ...env, GITHUB_EVENT_NAME: 'workflow_run' }, root, request: noNetwork }), /Untrusted workflow_run/);
  manifest.trustedWorkflowRuns = [42];
  assert.equal(await authorize(manifest, { env: { ...env, GITHUB_EVENT_NAME: 'workflow_run' }, root, request }), sha);
  wr.workflow_run.event = 'pull_request'; await writeFile(eventPath, JSON.stringify(wr));
  await assert.rejects(authorize(manifest, { env: { ...env, GITHUB_EVENT_NAME: 'workflow_run' }, root, request: noNetwork }), /Untrusted/);
});

test('version tags require exact current main and latest successful approved push CI', async t => {
  const { root, manifest } = await fixture(t);
  manifest.trustedWorkflowRuns = [343124584];
  await command('git', ['add', '.'], { cwd: root });
  await command('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root });
  const sha = (await command('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  await command('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'tag', '-a', 'v1.2.3', '-m', 'release'], { cwd: root });
  const eventPath = join(root, 'event.json');
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/tags/v1.2.3', GITHUB_REPOSITORY: manifest.repository, GITHUB_SHA: sha, GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: eventPath, GITHUB_TOKEN: 'fixture-only' };
  const event = { repository: { full_name: manifest.repository }, ref: env.GITHUB_REF, after: sha };
  await writeFile(eventPath, JSON.stringify(event));
  const good = { workflow_id: 343124584, status: 'completed', conclusion: 'success', event: 'push', head_branch: 'main', head_sha: sha, head_repository: event.repository };
  let runs = [good]; let main = sha; let ok = true;
  const request = async url => {
    if (url.endsWith('/commits/main')) return { ok: true, json: async () => ({ sha: main }) };
    assert.equal(url, 'https://api.github.com/repos/example/repo/actions/workflows/343124584/runs?branch=main&event=push&per_page=1');
    return { ok, status: 403, json: async () => ({ workflow_runs: runs }) };
  };
  assert.equal(await authorize(manifest, { env, root, request }), sha);
  for (const bad of [{ workflow_id: 9 }, { status: 'in_progress' }, { conclusion: 'failure' }, { event: 'pull_request' }, { event: 'workflow_dispatch' }, { head_branch: 'topic' }, { head_sha: '0'.repeat(40) }, { head_repository: { full_name: 'fork/repo' } }]) {
    runs = [{ ...good, ...bad }, good]; // Older success must not mask the latest run.
    await assert.rejects(authorize(manifest, { env, root, request }), /latest successful/);
  }
  runs = []; await assert.rejects(authorize(manifest, { env, root, request }), /latest successful/);
  runs = [good]; main = '0'.repeat(40); await assert.rejects(authorize(manifest, { env, root, request }), /Stale/); main = sha;
  ok = false; await assert.rejects(authorize(manifest, { env, root, request }), /CI lookup failed/); ok = true;
  await assert.rejects(authorize({ ...manifest, trustedWorkflowRuns: [] }, { env, root, request: noNetwork }), /approved CI/);
  for (const override of [{ GITHUB_REF: 'refs/heads/topic' }, { GITHUB_REF: 'refs/tags/release' }, { GITHUB_EVENT_NAME: 'pull_request' }]) await assert.rejects(authorize(manifest, { env: { ...env, ...override }, root, request: noNetwork }));
  await writeFile(eventPath, JSON.stringify({ ...event, deleted: true }));
  await assert.rejects(authorize(manifest, { env, root, request: noNetwork }), /Invalid main\/tag/);
  await writeFile(eventPath, JSON.stringify({ ...event, after: '0'.repeat(40) }));
  await assert.rejects(authorize(manifest, { env: { ...env, GITHUB_SHA: '0'.repeat(40) }, root, request: noNetwork }), /tag SHA/);
});

test('API pins project, passes readonly, suppresses server details and reports ambiguous failures', async () => {
  const env = { SUPABASE_ACCESS_TOKEN: 'fixture-secret' };
  const rows = await query(project, 'SELECT 1', { env, readOnly: true, request: async (url, init) => {
    assert.equal(url, `https://api.supabase.com/v1/projects/${project}/database/query`);
    assert.equal(JSON.parse(init.body).read_only, true); return { ok: true, json: async () => [{ digest: 'fixture' }] };
  } });
  assert.equal(rows.length, 1);
  await assert.rejects(query(project, '', { env, request: async () => ({ ok: false, status: 400, json: () => { throw Error('secret'); } }) }), /HTTP 400/);
  await assert.rejects(query(project, '', { env, request: async () => { throw Error('secret'); } }), /outcome unknown/);
});

// Docker mode uses the cached postgres:16-alpine image only. The fallback uses
// the repository's existing PGlite dev dependency; the engine has no dependency.
async function database(t) {
  if (process.env.PRODUCTION_MIGRATIONS_DOCKER !== '1') {
    const { PGlite } = await import('@electric-sql/pglite');
    const { btree_gist } = await import('@electric-sql/pglite/contrib/btree_gist');
    const db = new PGlite({ extensions: { btree_gist } }); t.after(() => db.close());
    return { exec: sql => db.exec(sql), rows: async sql => (await db.query(sql)).rows, rolledBackRows: async (mutation, sql) => {
      try { return (await db.exec(`BEGIN; ${mutation}; ${sql}; ROLLBACK;`)).flatMap(result => result.rows ?? []); }
      finally { await db.exec('ROLLBACK;'); }
    } };
  }
  const container = `ezil-production-migrations-${process.pid}`;
  await command('docker', ['run', '--pull=never', '--rm', '-d', '--name', container, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:16-alpine']);
  t.after(() => command('docker', ['rm', '-f', container]));
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try { await command('docker', ['exec', container, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-qAt', '-c', 'SELECT 1']); ready = true; break; }
    catch { await new Promise(r => setTimeout(r, 250)); }
  }
  assert.ok(ready, 'Disposable PostgreSQL ready');
  const exec = sql => new Promise((res, rej) => {
    const child = spawn('docker', ['exec', '-i', container, 'psql', '-XqAt', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => error += b); child.on('error', rej);
    child.on('close', code => code ? rej(new Error(error)) : res(output)); child.stdin.end(sql);
  });
  const decode = output => output.trim().split('\n').filter(Boolean).map(s => JSON.parse(s));
  return { exec, rows: async sql => decode(await exec(`SELECT row_to_json(q) FROM (${sql}) q;`)), rolledBackRows: async (mutation, sql) => decode(await exec(`BEGIN; ${mutation}; SELECT row_to_json(q) FROM (${sql}) q; ROLLBACK;`)) };
}

const globalFixture = fixture;

test(`transaction protocol (${process.env.PRODUCTION_MIGRATIONS_DOCKER === '1' ? 'Docker PostgreSQL 16' : 'PGlite PostgreSQL'})`, async t => {
  const db = await database(t);
  const state = async () => (await db.rows(catalogSQL(['app'])))[0];
  const fixture = async () => {
    await db.exec('ROLLBACK; DROP SCHEMA IF EXISTS ezil_ci CASCADE; DROP SCHEMA IF EXISTS app CASCADE; CREATE SCHEMA app; CREATE TABLE app.existing(id integer);');
    const manifest = blank(); manifest.initialCatalog = { ...await state(), capturedAt: new Date().toISOString(), sourceDigest: snapshotHash(manifest) }; delete manifest.initialCatalog.schemas;
    return { manifest, files: new Map() };
  };
  const rejected = async (sql, pattern) => { await assert.rejects(db.exec(sql), pattern); await db.exec('ROLLBACK;'); };
  const addMigration = async (loaded, sql = 'ALTER TABLE app.existing ADD COLUMN note text;') => {
    // Observe the actual after catalog in a disposable database and revert the
    // fixture. This fixture-only DDL is never a production manifest entry.
    const before = (await state()).digest;
    await db.exec(sql); const after = (await state()).digest;
    await db.exec('DROP TABLE app.existing; CREATE TABLE app.existing(id integer);');
    assert.equal((await state()).digest, before);
    const migration = { id: 'test_add_note', path: 'test.sql', sha256: hash(sql), before, after };
    loaded.manifest.migrations.push(migration); loaded.files.set('test.sql', { sql }); return migration;
  };
  await t.test('readonly plan creates nothing; baseline records no historical applications; rerun is stable', async () => {
    const loaded = await fixture(); loaded.manifest.sources = [{ path: 'historical.sql', sha256: hash('DROP SCHEMA app CASCADE'), kind: 'snapshot' }];
    await db.exec(planSQL(loaded.manifest)); assert.equal((await db.rows("SELECT to_regnamespace('ezil_ci')::text AS name"))[0].name, null);
    await db.exec(applySQL(loaded)); await db.exec(applySQL(loaded)); await db.exec(planSQL(loaded.manifest));
    assert.equal((await db.rows('SELECT count(*)::integer n FROM ezil_ci.baselines'))[0].n, 1);
    assert.equal((await db.rows('SELECT count(*)::integer n FROM ezil_ci.journal'))[0].n, 0);
    assert.equal((await state()).digest, loaded.manifest.initialCatalog.digest);
  });
  await t.test('reviewed snapshot edits validate and apply without rewriting historical identity or replay', async () => {
    const loaded = await fixture();
    const local = await globalFixture(t);
    Object.assign(local.manifest, loaded.manifest);
    await writeFile(join(local.root, 'history.sql'), 'DROP SCHEMA app CASCADE;');
    local.manifest.sources = [{ path: 'history.sql', sha256: hash('DROP SCHEMA app CASCADE;'), kind: 'snapshot' }];
    local.manifest.initialCatalog.sourceDigest = snapshotHash(local.manifest); await local.save();
    await db.exec(applySQL(await validate(local.root)));
    const historical = local.manifest.initialCatalog.sourceDigest;
    await writeFile(join(local.root, 'history.sql'), 'DROP SCHEMA app CASCADE; -- reviewed documentation change');
    await assert.rejects(validate(local.root), /checksum/);
    local.manifest.sources[0].sha256 = hash(await readFile(join(local.root, 'history.sql'))); await local.save();
    const reviewed = await validate(local.root);
    assert.notEqual(snapshotHash(reviewed.manifest), historical);
    await db.exec(planSQL(reviewed.manifest)); await db.exec(applySQL(reviewed));
    assert.equal((await db.rows('SELECT snapshots FROM ezil_ci.baselines'))[0].snapshots, historical);
    assert.equal((await db.rows('SELECT count(*)::integer n FROM ezil_ci.journal'))[0].n, 0);
    assert.equal((await state()).digest, loaded.manifest.initialCatalog.digest);
    await db.exec('ALTER TABLE app.existing ADD COLUMN unexplained text;');
    await rejected(planSQL(reviewed.manifest), /Current catalog drift/);
    await rejected(applySQL(reviewed), /Current catalog drift/);
    await db.exec('ALTER TABLE app.existing DROP COLUMN unexplained;');
    // Recreate to remove PostgreSQL's dropped-column metadata from the fixture.
    await db.exec('DROP TABLE app.existing; CREATE TABLE app.existing(id integer);');
    const migration = await addMigration(reviewed);
    await writeFile(join(local.root, migration.path), reviewed.files.get(migration.path).sql);
    reviewed.manifest.sources.push({ path: migration.path, sha256: migration.sha256, kind: 'migration' });
    await writeFile(join(local.root, '.github/production-migrations.json'), JSON.stringify(reviewed.manifest));
    await db.exec(applySQL(await validate(local.root)));
    assert.equal((await db.rows('SELECT snapshots FROM ezil_ci.baselines'))[0].snapshots, historical);
    assert.equal((await db.rows('SELECT count(*)::integer n FROM ezil_ci.journal'))[0].n, 1);
  });
  await t.test('missing baseline table refuses and rolls back private journal setup', async () => {
    const loaded = await fixture(); await db.exec('DROP TABLE app.existing;');
    await rejected(applySQL(loaded), /Initial catalog mismatch/);
    assert.equal((await db.rows("SELECT to_regnamespace('ezil_ci')::text AS name"))[0].name, null);
  });
  await t.test('wrong postcatalog rolls back DDL, baseline registration and journal atomically', async () => {
    const loaded = await fixture(); const m = await addMigration(loaded); m.after = '0'.repeat(64);
    await rejected(applySQL(loaded), /after catalog mismatch/);
    assert.equal((await state()).digest, m.before);
    assert.equal((await db.rows("SELECT to_regnamespace('ezil_ci')::text AS name"))[0].name, null);
  });
  await t.test('successful apply and retry write one entry; manifest/journal checksum drift refuses', async () => {
    const loaded = await fixture(); const m = await addMigration(loaded);
    await db.exec(applySQL(loaded)); await db.exec(applySQL(loaded)); await db.exec(planSQL(loaded.manifest));
    assert.equal((await state()).digest, m.after);
    assert.equal((await db.rows('SELECT count(*)::integer n FROM ezil_ci.journal'))[0].n, 1);
    m.sha256 = '1'.repeat(64); await rejected(applySQL(loaded), /checksum\/order drift/);
  });
  await t.test('out-of-band objects, historical source digest tampering and removed migration IDs refuse', async () => {
    const loaded = await fixture(); await addMigration(loaded); await db.exec(applySQL(loaded));
    await db.exec('CREATE TABLE app.unregistered(id integer);'); await rejected(applySQL(loaded), /Current catalog drift/);
    await rejected(planSQL(loaded.manifest), /Current catalog drift/); await db.exec('DROP TABLE app.unregistered;');
    const sourceDigest = loaded.manifest.initialCatalog.sourceDigest; loaded.manifest.initialCatalog.sourceDigest = 'f'.repeat(64); await rejected(applySQL(loaded), /Baseline registration drift/); loaded.manifest.initialCatalog.sourceDigest = sourceDigest;
    loaded.manifest.sources = []; loaded.manifest.migrations = []; await rejected(applySQL(loaded), /checksum\/order drift/);
  });
  await t.test('baseline project, schema and catalog identity remain immutable', async () => {
    const loaded = await fixture(); await db.exec(applySQL(loaded));
    const original = structuredClone(loaded.manifest);
    for (const mutate of [m => m.project = 'z'.repeat(20), m => m.initialCatalog.digest = 'f'.repeat(64), m => m.schemas = ['app','other']]) {
      await db.exec('CREATE SCHEMA IF NOT EXISTS other;');
      mutate(loaded.manifest);
      await rejected(applySQL(loaded), /Baseline registration drift/);
      await rejected(planSQL(loaded.manifest), /Baseline registration drift/);
      loaded.manifest = structuredClone(original);
    }
    await db.exec('DROP SCHEMA other;');
  });
  await t.test('unsupported catalog classes and overlapping repository ownership refuse', async () => {
    const loaded = await fixture(); await db.exec('CREATE COLLATION app.unreviewed FROM "C";');
    await rejected(planSQL(loaded.manifest), /Unsupported owned catalog/); await db.exec('DROP COLLATION app.unreviewed;');
    await db.exec(applySQL(loaded)); loaded.manifest.repository = 'example/other';
    await rejected(applySQL(loaded), /overlap/);
  });
  await t.test('Works btree_gist catalog baselines with symbolic definitions, membership and OID independence', async () => {
    await fixture();
    await db.exec('CREATE SCHEMA ezil_works; CREATE SCHEMA ezil_universe; CREATE EXTENSION btree_gist SCHEMA ezil_universe;');
    const manifest = { ...blank(), schemas: ['ezil_works', 'ezil_universe'] };
    const observe = async () => (await db.rows(catalogSQL(manifest.schemas)))[0];
    try {
      const types = await db.rows("SELECT typname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='ezil_universe' AND t.typtype='b' AND t.typelem=0 ORDER BY typname");
      assert.deepEqual(types.map(t => t.typname), ['gbtreekey16','gbtreekey2','gbtreekey32','gbtreekey4','gbtreekey8','gbtreekey_var']);
      const initial = await observe();
      manifest.initialCatalog = { digest: initial.digest, objects: initial.objects, capturedAt: new Date().toISOString(), sourceDigest: snapshotHash(manifest) };
      const loaded = { manifest, files: new Map() };
      await db.exec(planSQL(manifest)); await db.exec(applySQL(loaded)); await db.exec(applySQL(loaded));
      assert.equal((await db.rows('SELECT count(*)::integer n FROM ezil_ci.journal'))[0].n, 0);
      // The same extension recreated under different OIDs must retain its digest.
      await db.exec('DROP EXTENSION btree_gist; CREATE EXTENSION btree_gist SCHEMA ezil_universe;');
      assert.equal((await observe()).digest, initial.digest);
      await db.exec(planSQL(manifest));
      // Temporary catalog edits isolate definition fields from dependency identity changes.
      const mutations = [
        "UPDATE pg_operator SET oprcanmerge=NOT oprcanmerge WHERE oprnamespace='ezil_universe'::regnamespace",
        "UPDATE pg_opclass SET opcdefault=NOT opcdefault WHERE opcnamespace='ezil_universe'::regnamespace",
        "UPDATE pg_opfamily SET opfmethod=(SELECT oid FROM pg_am WHERE amname='btree') WHERE opfnamespace='ezil_universe'::regnamespace",
        "UPDATE pg_amop SET amopstrategy=amopstrategy+100 WHERE amopfamily IN (SELECT oid FROM pg_opfamily WHERE opfnamespace='ezil_universe'::regnamespace)",
        "UPDATE pg_amproc SET amproc='pg_catalog.int4in(cstring)'::regprocedure WHERE amprocfamily IN (SELECT oid FROM pg_opfamily WHERE opfnamespace='ezil_universe'::regnamespace)",
        ...['typinput','typoutput','typreceive','typsend','typmodin','typmodout','typanalyze','typsubscript'].map(field => `UPDATE pg_type SET ${field}='pg_catalog.int4in(cstring)'::regprocedure WHERE typnamespace='ezil_universe'::regnamespace AND typname='gbtreekey4'`),
        "ALTER EXTENSION btree_gist DROP TYPE ezil_universe.gbtreekey4"
      ];
      for (const mutation of mutations) {
        const changed = (await db.rolledBackRows(mutation, catalogSQL(manifest.schemas)))[0];
        assert.notEqual(changed.digest, initial.digest, mutation);
        assert.equal((await observe()).digest, initial.digest);
      }
      await db.exec('ALTER OPERATOR FAMILY ezil_universe.gist_int4_ops USING gist RENAME TO changed_family;');
      await rejected(planSQL(manifest), /Current catalog drift/);
      await rejected(applySQL(loaded), /Current catalog drift/);
      await db.exec('ALTER OPERATOR FAMILY ezil_universe.changed_family USING gist RENAME TO gist_int4_ops;');
      await db.exec('CREATE COLLATION ezil_universe.unreviewed FROM "C";');
      await rejected(planSQL(manifest), /Unsupported owned catalog/);
      await db.exec('DROP COLLATION ezil_universe.unreviewed;');
      await db.exec(planSQL(manifest));
    } finally {
      await db.exec('ROLLBACK; DROP SCHEMA ezil_ci CASCADE; DROP EXTENSION btree_gist; DROP SCHEMA ezil_works CASCADE; DROP SCHEMA ezil_universe CASCADE;');
    }
  });
  await t.test('journal shape corruption refuses and application rows do not affect catalog', async () => {
    const loaded = await fixture(); await db.exec('INSERT INTO app.existing VALUES (123);');
    assert.equal((await state()).digest, loaded.manifest.initialCatalog.digest);
    await db.exec(applySQL(loaded)); await db.exec('ALTER TABLE ezil_ci.journal ADD COLUMN surprise text;');
    await rejected(applySQL(loaded), /shape drift/);
  });
  await t.test('quoted delimiters stay inert across multiple statements and failed batches roll back', async () => {
    const loaded = await fixture();
    const sql = `/* backslash \\ and quote ' stay comments */ CREATE TABLE app."semi';COMMIT;--" (id integer); ALTER TABLE app.existing ADD COLUMN "quote'" text;`;
    const before = (await state()).digest;
    await db.exec(sql); const after = (await state()).digest;
    await db.exec(`DROP TABLE app."semi';COMMIT;--"; DROP TABLE app.existing; CREATE TABLE app.existing(id integer);`);
    loaded.manifest.migrations = [{ id: 'quoted', path: 'quoted.sql', sha256: hash(sql), before, after }]; loaded.files.set('quoted.sql', { sql });
    await db.exec(`SET standard_conforming_strings=off; ${applySQL(loaded)}`);
    assert.equal((await state()).digest, after);
    await db.exec('SET standard_conforming_strings=on;');
    // First statement succeeds, second fails; neither DDL nor its journal row
    // survives, and the already-committed first migration remains intact.
    const bad = 'CREATE TABLE app.partial(id integer); ALTER TABLE app.missing ADD COLUMN id integer;';
    loaded.manifest.migrations.push({ id: 'bad_batch', path: 'bad.sql', sha256: hash(bad), before: after, after: 'f'.repeat(64) }); loaded.files.set('bad.sql', { sql: bad });
    await rejected(applySQL(loaded), /missing/);
    assert.equal((await state()).digest, after);
    assert.equal((await db.rows('SELECT count(*)::integer n FROM ezil_ci.journal'))[0].n, 1);
  });
  await t.test('missing owned schemas and active event triggers refuse before creating journal', async () => {
    const loaded = await fixture(); await db.exec('DROP SCHEMA app CASCADE;');
    await rejected(applySQL(loaded), /Missing owned baseline schema/);
    assert.equal((await db.rows("SELECT to_regnamespace('ezil_ci')::text AS name"))[0].name, null);
    await db.exec(`CREATE SCHEMA app; CREATE TABLE app.existing(id integer); CREATE FUNCTION public.production_test_event() RETURNS event_trigger LANGUAGE plpgsql AS $$BEGIN END$$; CREATE EVENT TRIGGER production_test_event ON ddl_command_start EXECUTE FUNCTION public.production_test_event();`);
    try {
      await rejected(applySQL(loaded), /Active event triggers/);
      assert.equal((await db.rows("SELECT to_regnamespace('ezil_ci')::text AS name"))[0].name, null);
    } finally { await db.exec('DROP EVENT TRIGGER production_test_event; DROP FUNCTION public.production_test_event();'); }
  });
  await t.test('reviewed DDL hooks permit baseline registration but changes, additions and removals refuse', async () => {
    const loaded = await fixture();
    await db.exec(`CREATE FUNCTION public.production_test_event() RETURNS event_trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$BEGIN END$$; CREATE EVENT TRIGGER production_test_event ON ddl_command_end EXECUTE FUNCTION public.production_test_event();`);
    try {
      loaded.manifest.reviewedEventTriggers = (await db.rows(eventTriggersSQL()))[0].triggers;
      assert.equal(loaded.manifest.reviewedEventTriggers.length, 1);
      await db.exec(planSQL(loaded.manifest));
      assert.equal((await db.rows("SELECT to_regnamespace('ezil_ci')::text AS name"))[0].name, null);
      await db.exec(applySQL(loaded)); await db.exec(applySQL(loaded));
      assert.equal((await state()).digest, loaded.manifest.initialCatalog.digest);
      assert.equal((await db.rows('SELECT count(*)::integer n FROM ezil_ci.journal'))[0].n, 0);
      const mutations = [
        'ALTER EVENT TRIGGER production_test_event ENABLE ALWAYS',
        'ALTER EVENT TRIGGER production_test_event DISABLE',
        'CREATE EVENT TRIGGER unexpected ON ddl_command_end EXECUTE FUNCTION public.production_test_event()',
        'ALTER FUNCTION public.production_test_event() SECURITY DEFINER',
        'ALTER FUNCTION public.production_test_event() SET search_path=public',
        'REVOKE EXECUTE ON FUNCTION public.production_test_event() FROM PUBLIC',
        `CREATE OR REPLACE FUNCTION public.production_test_event() RETURNS event_trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$BEGIN PERFORM 1; END$$`
      ];
      for (const mutation of mutations) {
        const observed = (await db.rolledBackRows(mutation, eventTriggersSQL()))[0].triggers;
        assert.notDeepEqual(observed, loaded.manifest.reviewedEventTriggers, mutation);
      }
      await db.exec('ALTER FUNCTION public.production_test_event() SECURITY DEFINER;');
      await rejected(planSQL(loaded.manifest), /event triggers differ/);
      await rejected(applySQL(loaded), /event triggers differ/);
      await db.exec('ALTER FUNCTION public.production_test_event() SECURITY INVOKER;');
      await db.exec('CREATE EVENT TRIGGER unexpected ON ddl_command_end EXECUTE FUNCTION public.production_test_event();');
      await rejected(applySQL(loaded), /event triggers differ/);
      await db.exec('DROP EVENT TRIGGER unexpected; ALTER EVENT TRIGGER production_test_event DISABLE;');
      await rejected(applySQL(loaded), /event triggers differ/);
    } finally {
      await db.exec('DROP EVENT TRIGGER IF EXISTS unexpected; DROP EVENT TRIGGER production_test_event; DROP FUNCTION public.production_test_event();');
    }
  });
  if (process.env.PRODUCTION_MIGRATIONS_DOCKER === '1') {
    await t.test('concurrent retries share transaction advisory lock and apply once', async () => {
      const loaded = await fixture(); await addMigration(loaded);
      await Promise.all([db.exec(applySQL(loaded)), db.exec(applySQL(loaded))]);
      assert.equal((await db.rows('SELECT count(*)::integer n FROM ezil_ci.journal'))[0].n, 1);
    });
  }
});
