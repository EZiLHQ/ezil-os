import { z } from 'zod';
import { isEntrypoint } from './entrypoint.js';
import { ControlStore, deliveryKey, type StoredDelivery } from './control-store.js';
import { DeliverySchema, descriptor, validateDelivery, ProvisioningSchema, type Delivery } from './configuration-delivery-contract.js';
import { ensureHostDirectory, readHostFile } from './host-config.js';
import { acquireHostLock } from './host-lock.js';
import { SystemdDelivery, type DeliveryProcess } from './systemd-delivery.js';

const PROVISIONING = '/etc/ezil-supervisor/provisioning.json';
const STATE = '/var/lib/ezil-supervisor';
export const DeliveryOperationSchema = z.discriminatedUnion('action', [
    z.object({ schemaVersion: z.literal(1), action: z.literal('start'), delivery: DeliverySchema,
        deadline: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(),
    z.object({ schemaVersion: z.literal(1), action: z.enum(['observe', 'cancel']), delivery: DeliverySchema }).strict(),
]);
export interface DeliveryHostOptions {
    /** Root-only Linux acceptance seams, never exposed by the CLI or SSM. */
    privateValidation?: boolean; provisioningPath?: string; stateDirectory?: string; unitPrefix?: string;
}
export async function openDeliveryHost(options: DeliveryHostOptions = {}) {
    if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('delivery_requires_root');
    if (!options.privateValidation && (options.provisioningPath || options.stateDirectory || options.unitPrefix)) throw new Error('delivery_options_invalid');
    const provisioningPath = options.provisioningPath ?? PROVISIONING;
    const bytes = await readHostFile(provisioningPath, 4096);
    const host = ProvisioningSchema.parse(JSON.parse(bytes.toString()));
    const directory = options.stateDirectory ?? STATE;
    await ensureHostDirectory(directory);
    return { host, store: new ControlStore(directory, host.scope.computerId, host.scope.computerGeneration),
        driver: new SystemdDelivery(options.unitPrefix),
        checkFence: async () => { if (!(await readHostFile(provisioningPath, 4096)).equals(bytes)) throw new Error('delivery_fenced'); } };
}
export function deliveryObservation(value: Delivery, current: StoredDelivery | undefined, process: DeliveryProcess) {
    const status = !current ? (process.quiescent ? 'absent' : 'unknown')
        : current.cancelled ? (process.quiescent ? 'cancelled' : 'cancelling')
            : !process.quiescent ? 'running' : current.outcome === 'succeeded' && !process.failed ? 'succeeded'
                : current.outcome === 'failed' || process.failed ? 'failed' : 'unknown';
    return { schemaVersion: 1, configurationId: value.configurationId, scope: value.scope, operation: value.operation, status,
        ...(status === 'succeeded' ? { result: { schemaVersion: 1, operation: value.operation, configurationId: value.configurationId,
            scope: value.scope, descriptor: descriptor(value) } } : {}) };
}

/** The controller must recheck DB and actual EC2/EBS authority before calling
 * this fixed root operation. A local receipt is not loaded-app acceptance. */
export async function manageDelivery(input: unknown, options: DeliveryHostOptions = {}) {
    const parsed = DeliveryOperationSchema.safeParse(input);
    if (!parsed.success) throw new Error('delivery_operation_invalid');
    const request = parsed.data;
    const lock = await acquireHostLock('delivery-management');
    try {
        const { host, store, driver, checkFence } = await openDeliveryHost(options);
        try {
            const { value } = validateDelivery(request.delivery, host); const key = deliveryKey(value);
            await checkFence();
            if (request.action === 'cancel') {
                store.cancelDelivery(value); // fsynced before stop, including cancellation before dispatch
                await driver.stop(key);
            } else if (request.action === 'start' && store.dispatchDelivery(value, request.deadline)) {
                await driver.start(key); // a lost response never refunds the dispatch allowance
            }
            const state = await driver.observe(key);
            await checkFence();
            return deliveryObservation(value, store.delivery(value), state);
        } finally { store.close(); }
    } catch { throw new Error('delivery_operation_unavailable'); }
    finally { await lock.release(); }
}

/** The custom SSM document uses ENV_VAR interpolation only; no JSON or caller
 * command is interpolated into shell. Old agents without it fail closed. */
export function parseSsmDeliveryOperation(encoded: string | undefined): unknown {
    if (!encoded || encoded.length > 12288 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        throw new Error('delivery_operation_invalid');
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length > 8192 || bytes.toString('base64') !== encoded) throw new Error('delivery_operation_invalid');
    try { const input: unknown = JSON.parse(bytes.toString()); return DeliveryOperationSchema.parse(input); }
    catch { throw new Error('delivery_operation_invalid'); }
}
if (isEntrypoint(import.meta.url)) {
    void (async () => {
        if (process.argv.length !== 2) throw new Error('delivery_operation_invalid');
        const input = parseSsmDeliveryOperation(process.env.SSM_Operation);
        delete process.env.SSM_Operation;
        process.stdout.write(`${JSON.stringify(await manageDelivery(input))}\n`);
    })().catch(() => { process.stderr.write('{"code":"delivery_operation_failed"}\n'); process.exitCode = 1; });
}
