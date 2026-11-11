#!/usr/bin/env node
// Release-owner tool: observe the catalog digests that make 0022-0025 EXECUTABLE by the production migration engine.
//
//   DISPOSABLE_DATABASE_URL=postgres://... node app/drizzle/hardening/capture-migration-digests.mjs --i-confirm-disposable [--out candidate.json]
//
// It runs the four reviewed files, in order, against a DISPOSABLE database that carries the TARGET's schema metadata
// (restored from staging, never staging or production itself), and prints the `sources` kind flips and the `migrations[]`
// entries (`id`, `path`, `sha256`, `before`, `after`) to put in `.github/production-migrations.json`. This script writes
// nothing but that output (and `--out`): it never edits the manifest, and merely registering a `snapshot` source applies nothing.
//
// It refuses to run unless the database's catalog digest is the manifest's current expected one (`initialCatalog.digest`, or the
// last applied migration's `after`): if not, the target has drifted from the reviewed baseline, and `plan` must be reconciled
// through review first. `--rehearsal` skips only that check, for a local throwaway database, and labels the output as NOT usable.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import postgres from 'postgres';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const FILES = [
    ['0022-delegation-replay', 'app/drizzle/hardening/0022_delegation_replay.sql'],
    ['0023-agent-sessions', 'app/drizzle/hardening/0023_agent_sessions.sql'],
    ['0024-control-operations', 'app/drizzle/hardening/0024_control_operations.sql'],
    ['0025-editor-controls', 'app/drizzle/hardening/0025_editor_controls.sql'],
];

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : undefined;
const fail = (message, code = 1) => { console.error(`capture-migration-digests: ${message}`); process.exit(code); };

const url = process.env.DISPOSABLE_DATABASE_URL;
if (!url) fail('set DISPOSABLE_DATABASE_URL to a disposable database restored from the target schema metadata');
if (!flag('--i-confirm-disposable')) fail('pass --i-confirm-disposable: this executes the four migration files against that database');
const rehearsal = flag('--rehearsal');

const engine = await import(pathToFileURL(path.join(ROOT, '.github/scripts/production-migrations.mjs')).href);
const manifestPath = path.join(ROOT, '.github/production-migrations.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const applied = new Set(manifest.migrations.map((m) => m.id));
const pending = FILES.filter(([id]) => !applied.has(id));
if (pending.length === 0) fail('all four are already migrations[] entries in the manifest');

const files = pending.map(([id, file]) => {
    const sql = readFileSync(path.join(ROOT, file), 'utf8');
    engine.additiveSQL(sql, manifest.schemas); // the engine's own grammar: refuse a file it would refuse
    return { id, path: file, sql, sha256: engine.hash(sql) };
});

const db = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
try {
    const [target] = await db`SELECT current_database() AS name, inet_server_addr()::text AS host`;
    console.error(`database: ${target.name} @ ${target.host ?? 'local socket'}${rehearsal ? ' (REHEARSAL: digests are NOT production/staging digests)' : ''}`);
    const digest = async () => String((await db.unsafe(`SELECT digest FROM (${engine.catalogSQL(manifest.schemas)}) c`))[0].digest);
    const expected = manifest.migrations.at(-1)?.after ?? manifest.initialCatalog?.digest;
    let before = await digest();
    if (before !== expected && !rehearsal) {
        fail(`catalog digest ${before} is not the manifest's expected ${expected}: the target has drifted from the reviewed baseline. `
            + 'Run `node .github/scripts/production-migrations.mjs plan` and reconcile through review before capturing.', 2);
    }
    const migrations = [];
    for (const file of files) {
        await db.unsafe(file.sql);
        const after = await digest();
        if (after === before) fail(`${file.id} did not change the catalog`);
        migrations.push({ id: file.id, path: file.path, sha256: file.sha256, before, after });
        before = after;
    }
    const result = {
        rehearsal,
        baseline: migrations[0].before,
        sources: migrations.map((m) => ({ path: m.path, sha256: m.sha256, kind: 'migration' })),
        migrations,
    };
    const text = JSON.stringify(result, null, 2);
    if (out) writeFileSync(out, `${text}\n`);
    console.log(text);
    console.error(rehearsal
        ? 'REHEARSAL ONLY: these digests prove the tool, not the target. Do not copy them into the manifest.'
        : 'Copy `sources` (kind flips) and `migrations` into .github/production-migrations.json, then run `validate`.');
} finally {
    await db.end();
}
