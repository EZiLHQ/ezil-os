#!/usr/bin/env bun
/**
 * NULL-lower attestation operator runner (docs/aws-computers/NULL-LOWER-ATTESTATION-RUNBOOK.md); the logic and its pins are
 * runOperator in src/server/lib/compute/aws-lower-attestation-operator.ts. This file only wires the real dependencies.
 * Run with: bun --no-env-file scripts/lower-attestation-operator.ts <status|reserve|command|adopt|abort> --pins <file> \
 *   --deployments <file> --identity-certs <file> [--journal <dir> --apply] [operation options]
 * The database URL comes only from EZIL_ATTEST_DATABASE_URL and AWS access only from the operator's own profile.
 * Never prints database URLs, keys, receipts, markers, or computer, owner or instance identifiers.
 */
import { execFile } from 'node:child_process';
import { closeSync, constants, openSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createLowerAttestationStore } from '../src/server/lib/compute/aws-lower-attestation';
import { OperatorPinsSchema, OperatorRefusal, runOperator } from '../src/server/lib/compute/aws-lower-attestation-operator';
import type { PlacementDb } from '../src/server/lib/compute/placement';

const run = promisify(execFile);
/** The repository this script (and the store and verifier it imports) was loaded from, never the process cwd. */
const CODE_ROOT = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
const exclusive = (path: string) => openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);

async function main(argv: string[]) {
    const url = process.env.EZIL_ATTEST_DATABASE_URL;
    if (!url) throw new OperatorRefusal('database_unavailable');
    const pinsFile = argv[argv.indexOf('--pins') + 1];
    const region = OperatorPinsSchema.shape.region.parse(JSON.parse(readFileSync(pinsFile ?? '', 'utf8')).region);
    const client = postgres(url, { max: 2, prepare: false, onnotice: () => {} });
    try {
        const production = drizzle(client);
        const db: PlacementDb = { execute: q => production.execute(q), transaction: fn => production.transaction(tx => fn(tx)) };
        await runOperator(argv, {
            aws: async args => (await run('aws', [...args, '--region', region, '--output', 'json'], { maxBuffer: 16 << 20 })).stdout,
            codeRoot: CODE_ROOT,
            git: async args => (await run('git', ['-C', CODE_ROOT, ...args], { encoding: 'buffer', maxBuffer: 1 << 20 })).stdout as Buffer,
            readFile: path => readFileSync(path, 'utf8'),
            createJournal: (dir, name) => {
                const fd = exclusive(join(dir, name));
                return { append: line => { writeSync(fd, line + '\n'); }, close: () => closeSync(fd) };
            },
            dbIdentity: async () => {
                const [row] = await client`SELECT current_user::text AS role, (SELECT system_identifier::text FROM pg_control_system()) AS sid`;
                return { role: String(row!.role), systemIdentifier: String(row!.sid) };
            },
            store: createLowerAttestationStore(db),
            writeExclusive: (path, body) => { const fd = exclusive(path); try { writeSync(fd, body); } finally { closeSync(fd); } },
            now: () => new Date(),
            print: line => console.log(line),
        });
    } finally {
        await client.end();
    }
}

main(process.argv.slice(2)).catch(error => {
    // Codes only: a driver or CLI message may carry identifiers.
    console.error(JSON.stringify({ refused: error instanceof OperatorRefusal ? error.code
        : error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'operator_failed' }));
    process.exit(2);
});
