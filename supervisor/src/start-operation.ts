import { z } from 'zod';
import { isEntrypoint } from './entrypoint.js';
import { canonicalJson } from './control-protocol.js';
import { acquireHostLock } from './host-lock.js';
import { instanceCredentials, type MetadataRequest } from './aws-host-identity.js';
import { SystemdDelivery, type DeliveryProcess } from './systemd-delivery.js';
import { ControlBootstrapAuthorizationSchema } from './control-bootstrap-contract.js';
import { optionalProtected, replaceProtected } from './mount-operation-store.js';
import { observeSupervisor, stopSupervisor } from './supervisor-start.js';
import { StartRecordsSchema, StartOperationStore, startedReceipt, type StartRecords } from './start-operation-store.js';

const root = '/etc/ezil-supervisor', grantPath = `${root}/control-start-authorization.json`;
export const StartOperationSchema = z.object({ schemaVersion: z.literal(1), action: z.enum(['start', 'observe', 'cancel']), records: StartRecordsSchema }).strict();
type Options = { privateValidation?: boolean; metadataRequest?: MetadataRequest };
export async function assertStartFence(r: StartRecords, store: StartOperationStore) {
    const now = Date.now()/1000, a = r.authorization;
    if (a.issuedAt > now || a.expiresAt <= now || await store.flag('cancelled')
        || (await optionalProtected(`${root}/provisioning.json`))?.toString() !== canonicalJson(r.provisioning)
        || (await optionalProtected(grantPath))?.toString() !== canonicalJson(a)) throw new Error('start_operation_fenced');
}
async function provisionAuthority(r: StartRecords, driver: SystemdDelivery) {
    if ((await optionalProtected(`${root}/provisioning.json`))?.toString() !== canonicalJson(r.provisioning)) throw new Error('start_operation_conflict');
    const a = r.authorization, previous = await optionalProtected(grantPath);
    if (previous?.toString() === canonicalJson(a)) return;
    if (!(await observeSupervisor(AbortSignal.timeout(5000))).stopped) throw new Error('start_operation_conflict');
    if (previous) {
        const old = ControlBootstrapAuthorizationSchema.parse(JSON.parse(previous.toString()));
        if (canonicalJson(old.configuration.scope) !== canonicalJson(a.configuration.scope)
            || old.secretVersionId !== a.secretVersionId || old.controlDomain !== a.controlDomain
            || old.authorizationId === a.authorizationId || old.issuedAt >= a.issuedAt
            || !(await driver.observe(`start-${old.authorizationId}`)).quiescent) throw new Error('start_operation_conflict');
        await new StartOperationStore(old.authorizationId).mark('cancelled');
    }
    await replaceProtected(grantPath, a);
}
async function observation(r: StartRecords, store: StartOperationStore, process: DeliveryProcess) {
    const current = await store.records(), cancelled = await store.flag('cancelled'), receipt = await store.receipt();
    if (current && canonicalJson(current) !== canonicalJson(r)) throw new Error('start_operation_conflict');
    if (receipt && canonicalJson(receipt) !== canonicalJson(startedReceipt(r))) throw new Error('start_receipt_invalid');
    const currentGrant = (await optionalProtected(grantPath))?.toString() === canonicalJson(r.authorization);
    const stopped = !currentGrant || (await observeSupervisor(AbortSignal.timeout(5000))).stopped;
    const status = cancelled ? (process.quiescent && stopped ? 'cancelled' : 'cancelling') : !current ? (process.quiescent ? 'absent' : 'unknown')
        : !process.quiescent ? 'running' : process.failed || await store.flag('failed') ? 'failed' : receipt ? 'succeeded' : 'unknown';
    return { schemaVersion: 1, authorizationId: r.authorization.authorizationId, scope: r.provisioning.scope, status,
        ...(status === 'succeeded' ? { result: receipt } : {}) };
}
/** Fixed IAM-restricted SSM entrypoint. The trusted workflow must reauthorize
 * exact DB work and observe EC2/EBS before sending it. No caller commands,
 * credentials, key values or storage paths; the host never issues a grant. */
export async function manageStartOperation(input: unknown, o: Options = {}) {
    if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('start_operation_requires_root');
    if (!o.privateValidation && o.metadataRequest) throw new Error('start_operation_options_invalid');
    const parsed = StartOperationSchema.safeParse(input); if (!parsed.success) throw new Error('start_operation_invalid');
    const { action, records: r } = parsed.data, a = r.authorization;
    const lock = await acquireHostLock('start-management');
    try {
        await instanceCredentials({ accountId: r.provisioning.accountId, region: r.provisioning.region,
            instanceId: r.provisioning.scope.providerInstanceId }, AbortSignal.timeout(10000), o.metadataRequest);
        const store = new StartOperationStore(a.authorizationId), driver = new SystemdDelivery(undefined, 'start'), key = `start-${a.authorizationId}`;
        const existing = await store.records();
        if (existing && canonicalJson(existing) !== canonicalJson(r)) throw new Error('start_operation_conflict');
        if (action === 'cancel') {
            await store.saveRecords(r); await store.mark('cancelled'); await driver.stop(key);
            // Stale cancellation cannot stop the supervisor owned by a newer
            // grant. The management lock serializes root-grant replacement.
            if ((await optionalProtected(grantPath))?.toString() === canonicalJson(a)) await stopSupervisor();
        } else if (action === 'start' && !await store.flag('cancelled')) {
            if (a.issuedAt > Date.now()/1000 || a.expiresAt <= Date.now()/1000) throw new Error('start_operation_expired');
            await store.saveRecords(r); await provisionAuthority(r, driver); await assertStartFence(r, store);
            if (await store.mark('dispatched')) await driver.start(key);
        }
        return await observation(r, store, await driver.observe(key));
    } catch { throw new Error('start_operation_unavailable'); }
    finally { await lock.release(); }
}
export function parseSsmStartOperation(encoded: string | undefined) {
    if (!encoded || encoded.length > 21848 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('start_operation_invalid');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length > 16384 || bytes.toString('base64') !== encoded) throw new Error('start_operation_invalid');
    try { return StartOperationSchema.parse(JSON.parse(bytes.toString())); } catch { throw new Error('start_operation_invalid'); }
}
if (isEntrypoint(import.meta.url)) void (async () => {
    if (process.argv.length !== 2) throw new Error('start_operation_invalid');
    const input = parseSsmStartOperation(process.env.SSM_Operation); delete process.env.SSM_Operation;
    process.stdout.write(`${JSON.stringify(await manageStartOperation(input))}\n`);
})().catch(() => { process.stderr.write('{"code":"start_operation_failed"}\n'); process.exitCode = 1; });
