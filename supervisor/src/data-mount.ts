import { constants } from 'node:fs';
import { chmod, lstat, open, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { isEntrypoint } from './entrypoint.js';
import { basename, dirname } from 'node:path';
import { ensureHostDirectory, readHostFile } from './host-config.js';
import { openHostDirectory } from './mounts.js';
import { acquireHostLock } from './host-lock.js';
import { DATA_BYTES, DATA_MOUNT, DataMountPlanSchema, decideDataMount, formatIdentity, resolveDataDevice, type BlockDevice } from './data-mount-plan.js';

const fail = (): never => { throw new Error('data_mount_unconfirmed'); };
const journal = '/var/lib/ezil-bootstrap';
const markerPath = `${DATA_MOUNT}/.ezil-volume.json`;
async function optionalJson(path: string): Promise<string | null> {
    try { await lstat(path); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
    return (await readHostFile(path, 4096)).toString();
}
// readHostFile intentionally accepts only controller filenames beginning with
// an alphanumeric character. Keep the hidden volume marker a fixed exception,
// with the same ownership, link, permission and bounded-read protections.
async function readMarker(): Promise<string | null> {
    const parent = await openHostDirectory(DATA_MOUNT);
    try {
        let file;
        try { file = await open(`/proc/self/fd/${parent.fd}/.ezil-volume.json`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
        catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
        try {
            const stat = await file.stat();
            if (!stat.isFile() || stat.uid !== 0 || stat.mode & 0o077 || stat.nlink !== 1 || stat.size > 4096) return fail();
            const bytes = Buffer.alloc(4097);
            let size = 0;
            while (size < bytes.length) {
                const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
                if (!bytesRead) break;
                size += bytesRead;
            }
            if (size > 4096) return fail();
            return bytes.subarray(0, size).toString();
        } finally { await file.close(); }
    } finally { await parent.close(); }
}
/** No shell, inherited credentials, output logging or caller-selected tools.
 * FD 3 pins the verified block device across a bounded command invocation. */
function run(file: string, args: string[], timeout: number, signal: AbortSignal, fd?: number, noSignatureAllowed = false): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(file, args, { env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C' },
            stdio: ['ignore', 'pipe', 'ignore', ...(fd === undefined ? [] : [fd])], signal, timeout, killSignal: 'SIGKILL' });
        const chunks: Buffer[] = []; let size = 0, oversized = false;
        child.stdout!.on('data', (chunk: Buffer) => { size += chunk.length;
            if (size > 1048576) { oversized = true; child.kill('SIGKILL'); } else chunks.push(chunk); });
        child.once('error', () => reject(new Error('data_mount_command_failed')));
        child.once('close', code => {
            if (code === 0 && !oversized) resolve(Buffer.concat(chunks).toString());
            else if (code === 2 && noSignatureAllowed && !oversized) resolve('');
            else reject(new Error('data_mount_command_failed'));
        });
    });
}
async function createDurable(path: string, content: unknown) {
    const parent = await openHostDirectory(dirname(path));
    try {
        const file = await open(`/proc/self/fd/${parent.fd}/${basename(path)}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await file.writeFile(JSON.stringify(content)); await file.sync(); }
        finally { await file.close(); }
        await parent.sync();
    } finally { await parent.close(); }
}
async function pinDevice(d: BlockDevice) {
    const file = await open(d.name, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const stat = await file.stat({ bigint: true }), dev = stat.rdev;
        const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n);
        const minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
        if (!stat.isBlockDevice() || `${major}:${minor}` !== d['maj:min']) return fail();
        return file;
    } catch (e) { await file.close(); throw e; }
}

/** Host-only bootstrap primitive. It never downloads a filesystem, repairs or
 * formats a retained volume, unmounts storage, or starts applications. */
async function reconcileComputerDataVolume(configPath: string, signal: AbortSignal, beforeEffect: (() => Promise<void>) | undefined, observeOnly: boolean) {
    if (process.platform !== 'linux' || process.getuid?.() !== 0) return fail();
    const plan = DataMountPlanSchema.parse(JSON.parse((await readHostFile(configPath, 4096)).toString()));
    if (configPath.startsWith(`${DATA_MOUNT}/`) || configPath.startsWith(`${journal}/`)) return fail();
    const lock = await acquireHostLock('data-mount');
    try {
        if (!observeOnly) await ensureHostDirectory(journal);
        const attemptPath = `${journal}/${plan.volumeId}.json`;
        const inventory = async () => {
            const d = resolveDataDevice(plan, JSON.parse(await run('/usr/bin/lsblk',
                ['--json', '--list', '--bytes', '--paths', '--output', 'NAME,KNAME,TYPE,SIZE,RO,FSTYPE,UUID,PKNAME,SERIAL,MOUNTPOINTS,MAJ:MIN'], 10000, signal)));
            // Low-level probing bypasses the udev/blkid cache after formatting.
            const file = await pinDevice(d);
            try {
                const probed = await run('/usr/sbin/blkid', ['--probe', '--output', 'export', '/proc/self/fd/3'], 10000, signal, file.fd, true);
                const fields = probed.trim().split('\n').filter(Boolean).map(line => line.split('='));
                if (fields.some(parts => parts.length !== 2) || new Set(fields.map(p => p[0])).size !== fields.length) return fail();
                const values = Object.fromEntries(fields);
                if (values.PTTYPE || values.PTUUID) return fail();
                return { ...d, fstype: values.TYPE ?? null, uuid: values.UUID ?? null };
            } finally { await file.close(); }
        };
        const current = async (d: BlockDevice) => {
            const fresh = DataMountPlanSchema.parse(JSON.parse((await readHostFile(configPath, 4096)).toString()));
            if (JSON.stringify(fresh) !== JSON.stringify(plan) || JSON.stringify(await inventory()) !== JSON.stringify(d) || signal.aborted) return fail();
            await beforeEffect?.();
            if (signal.aborted) return fail();
        };
        for (let step = 0; step < 5; step++) {
            const d = await inventory(), mountInfo = await run('/usr/bin/cat', ['/proc/self/mountinfo'], 5000, signal);
            const mounted = mountInfo.split('\n').some(line => line.split(' ')[4] === DATA_MOUNT);
            const attempt = await optionalJson(attemptPath), marker = mounted ? await readMarker() : null;
            const decision = decideDataMount(plan, d, { mountInfo, marker, attempt: attempt === null ? null : JSON.parse(attempt) });
            await current(d);
            if (decision === 'ready') return { state: 'mounted' as const, computerId: plan.computerId, volumeId: plan.volumeId, filesystemUuid: plan.filesystemUuid };
            if (observeOnly) return fail(); // Never mount, format or repair from a readiness check.
            if (decision === 'mark') {
                // Only the exact filesystem UUID from a recorded format attempt
                // may receive a new identity marker. Never adopt another disk.
                const entries = await readdir(DATA_MOUNT);
                if (entries.some(name => name !== 'lost+found')) return fail();
                await chmod(DATA_MOUNT, 0o700);
                await createDurable(markerPath, { schemaVersion: 1, computerId: plan.computerId, volumeId: plan.volumeId });
                continue;
            }
            const device = await pinDevice(d);
            try {
                if (decision === 'initialize') {
                    const signatures = JSON.parse(await run('/usr/sbin/wipefs', ['--no-act', '--json', '/proc/self/fd/3'], 10000, signal, device.fd));
                    if (!Array.isArray(signatures.signatures) || signatures.signatures.length) return fail();
                    // Signatures alone do not prove blank media. Read the full
                    // fixed-size disk; an interrupted scan has made no changes.
                    await run('/usr/bin/cmp', ['--bytes', String(DATA_BYTES), '/proc/self/fd/3', '/dev/zero'], 600000, signal, device.fd);
                    await current(d);
                    // Persist before mkfs. An ambiguous format can be observed
                    // but is never retried, including after process death.
                    await createDurable(attemptPath, formatIdentity(plan));
                    await beforeEffect?.();
                    await run('/usr/sbin/mkfs.ext4', ['-q', '-U', plan.filesystemUuid, '-E', 'lazy_itable_init=0,lazy_journal_init=0', '/proc/self/fd/3'], 120000, signal, device.fd);
                    await device.sync();
                } else {
                    await ensureHostDirectory(DATA_MOUNT);
                    if ((await readdir(DATA_MOUNT)).length) return fail();
                    await run('/usr/bin/mount', ['--no-canonicalize', '--types', 'ext4', '--options', 'rw,nosuid,nodev', '/proc/self/fd/3', DATA_MOUNT], 30000, signal, device.fd);
                }
            } finally { await device.close(); }
        }
        return fail();
    } finally { await lock.release(); }
}

export function mountComputerDataVolume(configPath: string, signal = AbortSignal.timeout(900000), beforeEffect?: () => Promise<void>) {
    return reconcileComputerDataVolume(configPath, signal, beforeEffect, false);
}
/** Read-only device/UUID/marker verification, including descriptor-mounted
 * filesystems whose source cannot be resolved by findmnt/udev. */
export function observeComputerDataVolume(configPath: string, signal = AbortSignal.timeout(30000), check?: () => Promise<void>) {
    return reconcileComputerDataVolume(configPath, signal, check, true);
}

// Node resolves the module URL through symlinks, but argv retains the launch
// path. Deployment paths may be symlinks; never silently exit zero there.
if (isEntrypoint(import.meta.url)) {
    const controller = new AbortController();
    process.once('SIGTERM', () => controller.abort()); process.once('SIGINT', () => controller.abort());
    const args = process.argv.slice(2);
    const run = args.length === 1 ? mountComputerDataVolume(args[0]!, AbortSignal.any([controller.signal, AbortSignal.timeout(900000)])) : Promise.reject();
    void run.then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(() => {
        process.stderr.write('data_mount_unconfirmed\n'); process.exitCode = 1;
    });
}
