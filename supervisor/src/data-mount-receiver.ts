import { constants } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname } from 'node:path';
import { canonicalJson } from './control-protocol.js';
import { ensureHostDirectory, readHostFile } from './host-config.js';
import { openHostDirectory } from './mounts.js';
import { acquireHostLock } from './host-lock.js';
import { fetchConfiguration } from './aws-configuration-source.js';
import { DataMountPlanSchema } from './data-mount-plan.js';
import { mountComputerDataVolume } from './data-mount.js';
import { validateDataMountDelivery, validateDeliveredMountPlan } from './data-mount-delivery-contract.js';
import { isEntrypoint } from './entrypoint.js';

const PROVISIONING = '/etc/ezil-supervisor/provisioning.json';
const AUTHORIZATION = '/etc/ezil-supervisor/data-mount-authorization.json';
const PLAN = '/etc/ezil-supervisor/data-volume.json';
const DIRECTORY = '/run/ezil-supervisor';

async function writeExclusive(path: string, bytes: Buffer, created?: () => void) {
    const parent = await openHostDirectory(dirname(path));
    try {
        const file = await open(`/proc/self/fd/${parent.fd}/${basename(path)}`,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        created?.();
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
        await parent.sync();
    } finally { await parent.close(); }
}

/** Prepares storage before configuration/image preparation. Invoked only by
 * trusted root provisioning, never by an app or an HTTP endpoint. SSM IAM and
 * control-plane authorization remain necessary; the receiver cannot issue its
 * own independent provisioning or initialization authority. */
export async function receiveDataMount(input: unknown, options: {
    signal?: AbortSignal;
    /** Test-only transport seams; no CLI flag or environment enables them. */
    requestHandler?: NonNullable<Parameters<typeof fetchConfiguration>[3]>['requestHandler'];
    metadataRequest?: NonNullable<NonNullable<Parameters<typeof fetchConfiguration>[3]>['metadataRequest']>;
} = {}) {
    if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('data_mount_receiver_requires_root');
    const lock = await acquireHostLock('data-mount-delivery');
    let temporary: string | undefined;
    let downloaded: Awaited<ReturnType<typeof fetchConfiguration>> | undefined;
    try {
        const provisioning = await readHostFile(PROVISIONING, 4096), authorization = await readHostFile(AUTHORIZATION, 4096);
        const { value, host, authority } = validateDataMountDelivery(input, JSON.parse(provisioning.toString()), JSON.parse(authorization.toString()));
        const signal = AbortSignal.any([AbortSignal.timeout(Math.max(1, authority.expiresAt * 1000 - Date.now())),
            ...(options.signal ? [options.signal] : [])]);
        let storedPlan: Buffer | undefined;
        const checkAuthority = async () => {
            if (signal.aborted || authority.expiresAt * 1000 <= Date.now()) throw new Error('data_mount_delivery_cancelled');
            if (!(await readHostFile(PROVISIONING, 4096)).equals(provisioning)
                || !(await readHostFile(AUTHORIZATION, 4096)).equals(authorization)
                || (storedPlan && !(await readHostFile(PLAN, 4096)).equals(storedPlan))) throw new Error('data_mount_delivery_fenced');
        };
        await checkAuthority();
        // This fetch verifies IMDSv2 instance identity, exact S3 version, owner,
        // size, checksum and KMS key. Registry credentials are never requested.
        downloaded = await fetchConfiguration(value, host, signal, options);
        const plan = validateDeliveredMountPlan(downloaded.bytes, value, authority);
        await checkAuthority();
        const retained = { ...plan, mode: 'mount' as const };
        let exists = false;
        try { await lstat(PLAN); exists = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (exists) {
            storedPlan = await readHostFile(PLAN, 4096);
            const prior = DataMountPlanSchema.parse(JSON.parse(storedPlan.toString()));
            if (canonicalJson(prior) !== canonicalJson(retained)) throw new Error('data_mount_plan_conflict');
        } else {
            // Boot can only mount, including after a crash during first-use
            // delivery. Never persist format authority for a future reboot.
            await writeExclusive(PLAN, Buffer.from(canonicalJson(retained)));
            storedPlan = await readHostFile(PLAN, 4096);
        }
        await ensureHostDirectory(DIRECTORY);
        const candidate = `${DIRECTORY}/data-mount-${randomUUID()}.json`;
        await writeExclusive(candidate, downloaded.bytes, () => { temporary = candidate; });
        await checkAuthority();
        const result = await mountComputerDataVolume(candidate, signal, checkAuthority);
        await checkAuthority();
        return { schemaVersion: 1 as const, authorizationId: value.authorizationId, scope: value.scope, digest: value.digest, ...result };
    } catch (error) {
        const allowed = ['data_mount_delivery_invalid', 'data_mount_content_invalid', 'data_mount_delivery_cancelled',
            'data_mount_delivery_fenced', 'data_mount_plan_conflict', 'data_mount_unconfirmed'];
        throw new Error(error instanceof Error && allowed.includes(error.message) ? error.message : 'data_mount_delivery_unavailable');
    } finally {
        downloaded?.destroy(); downloaded?.bytes.fill(0);
        try { if (temporary) await unlink(temporary); }
        catch { throw new Error('data_mount_cleanup_unconfirmed'); }
        finally { await lock.release(); }
    }
}

async function main() {
    if (process.argv.length !== 2) throw new Error('data_mount_delivery_invalid');
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
    const timeout = setTimeout(cancel, 900000);
    const abort = () => process.stdin.destroy(new Error('data_mount_delivery_cancelled'));
    controller.signal.addEventListener('abort', abort, { once: true });
    try {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of process.stdin) {
            size += chunk.length; if (size > 8192) throw new Error('data_mount_delivery_invalid'); chunks.push(Buffer.from(chunk));
        }
        const result = await receiveDataMount(JSON.parse(Buffer.concat(chunks).toString()), { signal: controller.signal });
        process.stdout.write(`${JSON.stringify(result)}\n`);
    } finally {
        clearTimeout(timeout); controller.signal.removeEventListener('abort', abort);
        process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel);
    }
}
if (isEntrypoint(import.meta.url)) void main().catch(() => {
    process.stderr.write('{"code":"data_mount_delivery_failed"}\n'); process.exitCode = 1;
});
