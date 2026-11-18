/**
 * One shot, inside the trusted OS operator environment.
 *   node /private/signer.mjs --challenge /private/challenge.json \
 *     --output /private/placement.json --computer-id ... --owner-user-id ... --instance-id ...
 * The expected owner, computer and instance are independent operator pins.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, fstatSync, linkSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { loadAcceptedNativeDeployment, nativePolicyCanonical } from '../src/server/native-session/accepted-policy';
import { signNativeQualificationPlacement } from '../src/server/native-session/qualification-placement';

const argNames = ['challenge', 'output', 'computer-id', 'owner-user-id', 'instance-id'] as const;
const own = (stat: ReturnType<typeof statSync>, mode: number) => stat.uid === process.getuid?.() && (stat.mode & 0o777) === mode;

function privateParent(path: string): string {
    if (!isAbsolute(path) || resolve(path) !== path) throw new Error('invalid private path');
    const dir = dirname(path);
    const stat = statSync(dir);
    if (realpathSync(dir) !== dir || !stat.isDirectory() || !own(stat, 0o700)) throw new Error('invalid private directory');
    return dir;
}

function readChallenge(path: string): string {
    privateParent(path);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || !own(stat, 0o600) || stat.size < 1 || stat.size > 4096) {
            throw new Error('invalid private challenge');
        }
        const bytes = readFileSync(fd);
        if (bytes.length !== stat.size) throw new Error('changed private challenge');
        return new TextDecoder('utf8', { fatal: true }).decode(bytes);
    } finally { closeSync(fd); }
}

function publishProof(path: string, bytes: string): void {
    const dir = privateParent(path);
    const temporary = join(dir, '.qualification-' + randomUUID());
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
        writeFileSync(fd, bytes, 'utf8');
        fsyncSync(fd);
        // An existing proof always remains intact. Link publishes only the fully synced file.
        linkSync(temporary, path);
    } finally {
        try { closeSync(fd); } finally { unlinkSync(temporary); }
    }
    const dirFd = openSync(dir, constants.O_DIRECTORY | constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
}

async function main(): Promise<void> {
    const { tokens, values } = parseArgs({
        strict: true,
        tokens: true,
        options: {
            challenge: { type: 'string' }, output: { type: 'string' }, 'computer-id': { type: 'string' },
            'owner-user-id': { type: 'string' }, 'instance-id': { type: 'string' },
        },
    });
    if (tokens.length !== argNames.length || argNames.some(name => !values[name])) throw new Error('invalid invocation');
    const challenge = readChallenge(values.challenge!);
    privateParent(values.output!);

    // Use the same production configuration as the installed OS app. Values stay in process memory.
    const url = process.env.SUPABASE_DATABASE_URL;
    const controlSecret = process.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET;
    const deploymentState = loadAcceptedNativeDeployment(process.env);
    if (!url || !controlSecret || deploymentState.state !== 'ready') throw new Error('qualification configuration unavailable');

    const client = postgres(url, { max: 1, prepare: false, connect_timeout: 5 });
    try {
        const proof = await drizzle(client).transaction(tx => signNativeQualificationPlacement(challenge, {
            db: tx,
            now: () => new Date(),
            target: { computerId: values['computer-id']!, ownerUserId: values['owner-user-id']!, instanceId: values['instance-id']! },
            controlSecret,
            deployment: deploymentState.deployment,
        }), { accessMode: 'read only', isolationLevel: 'repeatable read' });
        if (Date.parse(proof.receipt.expiresAt) <= Date.now()) throw new Error('qualification expired before publication');
        publishProof(values.output!, nativePolicyCanonical(proof));
        console.log('Native qualification placement proof written.');
    } finally { await client.end({ timeout: 1 }); }
}

main().catch(error => {
    const code = error instanceof Error && /^qualification_[a-z_]+$/.test(error.message) ? ': ' + error.message : '';
    console.error('Native qualification placement signing refused' + code + '.');
    process.exitCode = 1;
});
