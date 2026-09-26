import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { canonicalJson } from './control-protocol.js';
import { validateDelivery, validateConfiguration, descriptor } from './configuration-delivery-contract.js';
import { validateControlBootstrap } from './control-bootstrap-contract.js';
import { fetchControlKey, type ControlKeyTransportOptions } from './aws-control-key.js';
import { readHostFile } from './host-config.js';
import { openHostDirectory } from './mounts.js';
import { acquireHostLock } from './host-lock.js';
import { MountOperationStore, mountedReceipt, createProtected, optionalProtected, ensureDurableDirectory } from './mount-operation-store.js';
import { ControlStore } from './control-store.js';
import { observeComputerDataVolume } from './data-mount.js';
import { observeSupervisor, requestSupervisorStart, confirmSupervisor, stopSupervisor } from './supervisor-start.js';
import { isEntrypoint } from './entrypoint.js';

const root = '/etc/ezil-supervisor', state = '/var/lib/ezil-supervisor-starts';
/** An existing key must match exactly. Re-fsync matching bytes and their
 * directory on retry; never repair a partial write or rotate an active key. */
async function installKey(secret: Buffer) {
    const parent = await openHostDirectory(root);
    let file;
    try {
        const path = `/proc/self/fd/${parent.fd}/control.key`;
        let created = false;
        try { file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); created = true; }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
            file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
        if (created) await file.writeFile(secret);
        else {
            const stat = await file.stat(), bytes = Buffer.alloc(33);
            try {
                if (!stat.isFile() || stat.uid !== 0 || stat.mode & 0o077 || stat.nlink !== 1 || stat.size !== 32
                    || (await file.read(bytes, 0, 33, 0)).bytesRead !== 32 || !timingSafeEqual(bytes.subarray(0, 32), secret)) throw new Error();
            } finally { bytes.fill(0); }
        }
        await file.sync(); await parent.sync();
    } finally { await file?.close(); await parent.close(); }
}

/** Dedicated first-start operation, never a reload fallback. The controller
 * must issue control-start-authorization.json after fresh DB/provider checks;
 * this receiver cannot create or refresh authority or generate a key. No unit
 * is enabled at boot. A reused attempt only observes; it never starts twice. */
export async function bootstrapControlHost(input: unknown, options: ControlKeyTransportOptions & {
    signal?: AbortSignal; privateValidation?: boolean;
} = {}) {
    if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('control_bootstrap_requires_root');
    if (!options.privateValidation && (options.metadataRequest || options.requestHandler)) throw new Error('control_bootstrap_options_invalid');
    const locks: Awaited<ReturnType<typeof acquireHostLock>>[] = [];
    let secret: Buffer | undefined, store: ControlStore | undefined, ownsAttempt = false, installedKey = false;
    try {
        // Serialize with configuration writes and mount grant replacement. Do
        // not hold the host lock: the actual service must acquire it itself.
        for (const purpose of ['delivery', 'preparation', 'mount-management'] as const) locks.push(await acquireHostLock(purpose));
        const provisioned = await readHostFile(`${root}/provisioning.json`, 4096);
        const authorized = await readHostFile(`${root}/control-start-authorization.json`, 8192);
        const { host, authority: a } = validateControlBootstrap(input, JSON.parse(provisioned.toString()), JSON.parse(authorized.toString()));
        const signal = AbortSignal.any([AbortSignal.timeout(Math.min(90000, a.expiresAt * 1000 - Date.now())), ...(options.signal ? [options.signal] : [])]);
        const { value } = validateDelivery(a.configuration, host);
        const configured = await readHostFile(`${root}/config.json`, 262144);
        const config = validateConfiguration(configured, value, host);
        const mounts = new MountOperationStore('/var/lib/ezil-mount-deliveries', a.mountAuthorizationId), records = await mounts.records();
        if (!records || canonicalJson(records.provisioning) !== canonicalJson(host)) throw new Error();
        const plan = { schemaVersion: 1, computerId: host.scope.computerId, volumeId: host.scope.dataVolumeId,
            filesystemUuid: records.authorization.filesystemUuid, mode: 'mount' };
        store = new ControlStore(config.stateDirectory, config.computerId, config.computerGeneration);
        const check = async () => {
            if (signal.aborted || a.expiresAt * 1000 <= Date.now()
                || !(await readHostFile(`${root}/provisioning.json`, 4096)).equals(provisioned)
                || !(await readHostFile(`${root}/control-start-authorization.json`, 8192)).equals(authorized)
                || !(await readHostFile(`${root}/config.json`, 262144)).equals(configured)
                || canonicalJson(JSON.parse((await readHostFile(`${root}/data-volume.json`, 4096)).toString())) !== canonicalJson(plan)
                || canonicalJson(JSON.parse((await readHostFile(`${root}/data-mount-authorization.json`, 4096)).toString())) !== canonicalJson(records.authorization)
                || await mounts.flag('cancelled') || await mounts.flag('failed')
                || canonicalJson(await mounts.receipt()) !== canonicalJson(mountedReceipt(records))) throw new Error();
            const prepared = store!.delivery(value);
            if (!prepared || prepared.cancelled || prepared.outcome !== 'succeeded') throw new Error();
            if (installedKey) {
                const current = await readHostFile(`${root}/control.key`, 32);
                try { if (!secret || current.length !== 32 || !timingSafeEqual(current, secret)) throw new Error(); }
                finally { current.fill(0); }
            }
        };
        const mounted = async () => {
            await observeComputerDataVolume(`${root}/data-volume.json`, signal, check);
        };
        await check(); await mounted();
        await ensureDurableDirectory(state);
        const attempt = `${state}/${a.authorizationId}.json`, previous = await optionalProtected(attempt);
        if (previous && previous.toString() !== canonicalJson(a)) throw new Error();
        if (!previous && !(await observeSupervisor(signal)).stopped) throw new Error();
        secret = await fetchControlKey(host, a, signal, options);
        await check(); await installKey(secret); installedKey = true; await check(); await mounted();
        // Persist intent before the side effect. A crash/lost reply never
        // refunds the attempt. Recovery requires a new approved authorization
        // if the first attempt did not leave an observable running supervisor.
        if (previous) { ownsAttempt = true; if ((await observeSupervisor(signal)).stopped) throw new Error(); }
        else { await createProtected(attempt, a); ownsAttempt = true; await check(); await requestSupervisorStart(signal); }
        await confirmSupervisor(value, secret, signal, check); await mounted(); await check();
        return { schemaVersion: 1, authorizationId: a.authorizationId, scope: host.scope, state: 'started', descriptor: descriptor(value) };
    } catch {
        if (ownsAttempt) {
            try { await stopSupervisor(); } catch { throw new Error('supervisor_stop_unconfirmed'); }
        }
        throw new Error('control_bootstrap_unconfirmed');
    } finally {
        secret?.fill(0);
        try { store?.close(); } finally { for (const lock of locks.reverse()) await lock.release(); }
    }
}

if (isEntrypoint(import.meta.url)) void (async () => {
    if (process.argv.length !== 2) throw new Error();
    const abort = new AbortController(), cancel = () => abort.abort();
    process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
    const timer = setTimeout(cancel, 90000);
    const interrupted = () => process.stdin.destroy(new Error('control_bootstrap_cancelled'));
    abort.signal.addEventListener('abort', interrupted, { once: true });
    try {
        let size = 0; const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) { size += chunk.length; if (size > 512) throw new Error(); chunks.push(Buffer.from(chunk)); }
        process.stdout.write(`${JSON.stringify(await bootstrapControlHost(JSON.parse(Buffer.concat(chunks).toString()), { signal: abort.signal }))}\n`);
    } finally { clearTimeout(timer); abort.signal.removeEventListener('abort', interrupted); process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel); }
})().catch(error => { process.stderr.write(JSON.stringify({ code: error instanceof Error && error.message === 'supervisor_stop_unconfirmed'
    ? 'supervisor_stop_unconfirmed' : 'control_bootstrap_unconfirmed' }) + '\n'); process.exitCode = 1; });
