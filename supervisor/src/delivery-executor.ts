import { isEntrypoint } from './entrypoint.js';
import { canonicalJson } from './control-protocol.js';
import { validateDelivery, descriptor, type Delivery } from './configuration-delivery-contract.js';
import { receiveConfiguration } from './configuration-receiver.js';
import { openDeliveryHost, type DeliveryHostOptions } from './delivery-operation.js';

/** systemd owns the process group and an independent 15-minute ceiling. The
 * persisted deadline also bounds queued work and survives process restart. */
export async function executeDelivery(key: string, options: DeliveryHostOptions & {
    receive?: (value: Delivery, signal: AbortSignal) => Promise<unknown>;
} = {}) {
    if (options.receive && !options.privateValidation) throw new Error('delivery_options_invalid');
    const { host, store, checkFence } = await openDeliveryHost(options);
    const abort = new AbortController(); const cancel = () => abort.abort();
    process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let value: Delivery | undefined;
    let begun = false;
    try {
        const current = store.deliveryByKey(key);
        if (!current?.dispatched || current.cancelled || current.outcome !== 'pending'
            || current.deadline <= Date.now() || current.deadline > Date.now() + 900000) throw new Error('delivery_execution_denied');
        value = validateDelivery(current.delivery, host).value;
        if (!store.beginDelivery(value)) throw new Error('delivery_execution_denied');
        begun = true;
        timer = setTimeout(cancel, Math.max(1, current.deadline - Date.now()));
        await checkFence();
        if (abort.signal.aborted || store.delivery(value)?.cancelled) throw new Error('delivery_execution_denied');
        const result = await (options.receive ?? ((input, signal) => receiveConfiguration(input, { signal })))(value, abort.signal);
        await checkFence();
        if (abort.signal.aborted || canonicalJson(result) !== canonicalJson({ schemaVersion: 1, operation: value.operation,
            configurationId: value.configurationId, scope: value.scope, descriptor: descriptor(value) })) throw new Error('delivery_execution_unconfirmed');
        store.finishDelivery(value, true);
    } catch {
        if (value && begun) store.finishDelivery(value, false);
        throw new Error('delivery_execution_failed');
    } finally {
        clearTimeout(timer); process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel); store.close();
    }
}
if (isEntrypoint(import.meta.url)) {
    void (async () => {
        if (process.argv.length !== 3) throw new Error('delivery_execution_invalid');
        await executeDelivery(process.argv[2]!);
    })().catch(() => { process.stderr.write('{"code":"delivery_execution_failed"}\n'); process.exitCode = 1; });
}
