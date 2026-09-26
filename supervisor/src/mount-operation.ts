import { z } from 'zod';
import { isEntrypoint } from './entrypoint.js';
import { canonicalJson } from './control-protocol.js';
import { acquireHostLock } from './host-lock.js';
import { instanceCredentials, type MetadataRequest } from './aws-host-identity.js';
import { ensureHostDirectory } from './host-config.js';
import { SystemdDelivery, type DeliveryProcess } from './systemd-delivery.js';
import { DataMountAuthorizationSchema } from './data-mount-delivery-contract.js';
import { MountRecordsSchema, MountOperationStore, optionalProtected, createProtected, replaceProtected,
    mountedReceipt, type MountRecords } from './mount-operation-store.js';

export const MountOperationSchema = z.object({ schemaVersion: z.literal(1), action: z.enum(['start', 'observe', 'cancel']), records: MountRecordsSchema }).strict();
export interface MountHostOptions {
    /** Disposable Linux VM acceptance only; the CLI never reads these from environment/input. */
    privateValidation?: boolean; rootDirectory?: string; stateDirectory?: string; unitPrefix?: string; metadataRequest?: MetadataRequest;
}
export function mountPaths(o: MountHostOptions) {
    if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('mount_operation_requires_root');
    if (!o.privateValidation && (o.rootDirectory || o.stateDirectory || o.unitPrefix || o.metadataRequest)) throw new Error('mount_operation_options_invalid');
    const root = o.rootDirectory ?? '/etc/ezil-supervisor';
    return { root, provisioning: `${root}/provisioning.json`, authorization: `${root}/data-mount-authorization.json`,
        state: o.stateDirectory ?? '/var/lib/ezil-mount-deliveries' };
}
export async function assertMountFence(r: MountRecords, store: MountOperationStore, o: MountHostOptions) {
    const p = mountPaths(o), a = r.authorization, now = Date.now()/1000;
    if (a.issuedAt > now || a.expiresAt <= now || await store.flag('cancelled')
        || (await optionalProtected(p.provisioning))?.toString() !== canonicalJson(r.provisioning)
        || (await optionalProtected(p.authorization))?.toString() !== canonicalJson(a)) throw new Error('mount_operation_fenced');
}
async function provisionRoot(r: MountRecords, driver: SystemdDelivery, o: MountHostOptions) {
    const p = mountPaths(o), a = r.authorization;
    await ensureHostDirectory(p.root);
    await createProtected(p.provisioning, r.provisioning);
    const previous = await optionalProtected(p.authorization);
    if (previous?.toString() === canonicalJson(a)) return;
    if (previous) {
        const old = DataMountAuthorizationSchema.parse(JSON.parse(previous.toString()));
        if (canonicalJson(old.scope) !== canonicalJson(a.scope) || old.filesystemUuid !== a.filesystemUuid
            || a.mode !== 'mount' || a.issuedAt <= old.issuedAt || !(await driver.observe(`mount-${old.authorizationId}`)).quiescent) {
            throw new Error('mount_operation_conflict');
        }
        // Fence delayed activations before replacing the active root grant.
        await new MountOperationStore(p.state, old.authorizationId).mark('cancelled');
    }
    await replaceProtected(p.authorization, a);
}
async function observation(r: MountRecords, store: MountOperationStore, process: DeliveryProcess) {
    const current = await store.records(), cancelled = await store.flag('cancelled'), receipt = await store.receipt();
    if (current && canonicalJson(current) !== canonicalJson(r)) throw new Error('mount_operation_conflict');
    if (receipt && canonicalJson(receipt) !== canonicalJson(mountedReceipt(r))) throw new Error('mount_receipt_invalid');
    const status = cancelled ? (process.quiescent ? 'cancelled' : 'cancelling') : !current ? (process.quiescent ? 'absent' : 'unknown')
        : !process.quiescent ? 'running' : process.failed || await store.flag('failed') ? 'failed' : receipt ? 'succeeded' : 'unknown';
    return { schemaVersion: 1, authorizationId: r.authorization.authorizationId, scope: r.authorization.scope, status,
        ...(status === 'succeeded' ? { result: receipt } : {}) };
}

/** Invoked by the fixed, IAM-restricted SSM document only, never an app/browser
 * API. The trusted controller must reauthorize exact records and verify actual
 * EC2/EBS ownership/attachment before dispatch. Host IMDS pins this instance.
 * Cancellation and one dispatch/begin survive lost SSM replies and restarts. */
export async function manageMountOperation(input: unknown, o: MountHostOptions = {}) {
    const p = mountPaths(o), parsed = MountOperationSchema.safeParse(input);
    if (!parsed.success) throw new Error('mount_operation_invalid');
    const { action, records: r } = parsed.data, a = r.authorization;
    const lock = await acquireHostLock('mount-management');
    try {
        await instanceCredentials({ accountId: r.provisioning.accountId, region: r.provisioning.region,
            instanceId: a.scope.providerInstanceId }, AbortSignal.timeout(10000), o.metadataRequest);
        await ensureHostDirectory(p.state);
        const store = new MountOperationStore(p.state, a.authorizationId), driver = new SystemdDelivery(o.unitPrefix, 'mount');
        const existing = await store.records();
        if (existing && canonicalJson(existing) !== canonicalJson(r)) throw new Error('mount_operation_conflict');
        const key = `mount-${a.authorizationId}`;
        if (action === 'cancel') {
            await store.saveRecords(r); await store.mark('cancelled'); await driver.stop(key);
        } else if (action === 'start' && !await store.flag('cancelled')) {
            if (a.issuedAt > Date.now()/1000 || a.expiresAt <= Date.now()/1000) throw new Error('mount_operation_expired');
            await store.saveRecords(r); await provisionRoot(r, driver, o); await assertMountFence(r, store, o);
            if (await store.mark('dispatched')) await driver.start(key);
        }
        return await observation(r, store, await driver.observe(key));
    } catch { throw new Error('mount_operation_unavailable'); }
    finally { await lock.release(); }
}
export function parseSsmMountOperation(encoded: string | undefined) {
    if (!encoded || encoded.length > 21848 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        throw new Error('mount_operation_invalid');
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length > 16384 || bytes.toString('base64') !== encoded) throw new Error('mount_operation_invalid');
    try { return MountOperationSchema.parse(JSON.parse(bytes.toString())); } catch { throw new Error('mount_operation_invalid'); }
}
if (isEntrypoint(import.meta.url)) {
    void (async () => {
        if (process.argv.length !== 2) throw new Error('mount_operation_invalid');
        const input = parseSsmMountOperation(process.env.SSM_Operation); delete process.env.SSM_Operation;
        process.stdout.write(`${JSON.stringify(await manageMountOperation(input))}\n`);
    })().catch(() => { process.stderr.write('{"code":"mount_operation_failed"}\n'); process.exitCode = 1; });
}
