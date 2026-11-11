#!/usr/bin/env node
// Source-only registration: no database connection and no cloud writes.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hash, additiveSQL, validate } from '../../../.github/scripts/production-migrations.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const NAMES = ['0022_delegation_replay', '0023_agent_sessions', '0024_control_operations', '0025_editor_controls'];
const check = (condition, message) => { if (!condition) throw new Error(message); };

export async function prepareManifest(root, capture) {
    const { manifest } = await validate(root);
    check(capture?.rehearsal === false, 'Only reviewed non-rehearsal observations can register migrations');
    check(Array.isArray(capture.migrations) && capture.migrations.length === 4, 'Require the complete four-migration chain');
    let previous = manifest.migrations.at(-1)?.after ?? manifest.initialCatalog?.digest;
    check(capture.baseline === previous, 'Observation baseline differs from the current manifest');
    const result = structuredClone(manifest);
    for (const [index, name] of NAMES.entries()) {
        const file = `app/drizzle/hardening/${name}.sql`;
        const id = name.replaceAll('_', '-');
        const row = capture.migrations[index];
        const sql = await readFile(resolve(root, file), 'utf8');
        const digest = hash(sql);
        check(row?.id === id && row.path === file && row.sha256 === digest, 'Observation does not match reviewed SQL');
        check(row.before === previous && /^[a-f0-9]{64}$/.test(row.after) && row.after !== row.before, 'Invalid observed catalog chain');
        check(!result.migrations.some(m => m.id === id || m.path === file), 'Migration already registered');
        const source = result.sources.find(s => s.path === file);
        check(source?.kind === 'snapshot' && source.sha256 === digest, 'Source is not the reviewed snapshot');
        additiveSQL(sql, result.schemas);
        source.kind = 'migration';
        // Copy only the engine fields: never accept verifyOnly from observation input.
        result.migrations.push({ id, path: file, sha256: digest, before: row.before, after: row.after });
        previous = row.after;
    }
    return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try {
        const [input, output, review] = process.argv.slice(2);
        check(input && output && review === '--reviewed-observations' && process.argv.length === 5,
            'Usage: prepare-migration-manifest.mjs capture.json output.json --reviewed-observations');
        check(resolve(output) !== resolve(ROOT, '.github/production-migrations.json'), 'Write a review candidate, not the active manifest');
        const candidate = await prepareManifest(ROOT, JSON.parse(await readFile(input, 'utf8')));
        await writeFile(output, `${JSON.stringify(candidate, null, 2)}\n`, { flag: 'wx' });
        console.log('Prepared executable manifest candidate; no database or cloud changes. Coordinator review required before promotion.');
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
