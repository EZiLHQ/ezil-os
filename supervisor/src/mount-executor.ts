import { isEntrypoint } from './entrypoint.js';
import { canonicalJson } from './control-protocol.js';
import { MountOperationStore, mountedReceipt, type MountRecords } from './mount-operation-store.js';
import { mountPaths, assertMountFence, type MountHostOptions } from './mount-operation.js';
import { receiveDataMount } from './data-mount-receiver.js';

/** One systemd process group, absolute grant expiry and persistent cancellation.
 * Extra checks only deny; they cannot replace the receiver's own authority,
 * S3, device and initialization-journal checks. */
export async function executeMountOperation(key: string, o: MountHostOptions & {
    receive?: (r: MountRecords, signal: AbortSignal, check: () => Promise<void>) => Promise<unknown>;
} = {}) {
    if (!/^mount-[a-f0-9-]{36}$/.test(key) || (o.receive && !o.privateValidation)) throw new Error('mount_execution_invalid');
    const p = mountPaths(o), store = new MountOperationStore(p.state, key.slice(6));
    const controller = new AbortController(), cancel = () => controller.abort();
    process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
    let timer: ReturnType<typeof setTimeout> | undefined, begun = false;
    try {
        const r = await store.records();
        if (!r || !await store.flag('dispatched') || await store.flag('cancelled') || await store.flag('failed') || await store.receipt()) throw new Error();
        const check = async () => { if (controller.signal.aborted) throw new Error(); await assertMountFence(r, store, o); };
        await check();
        if (!await store.mark('begun')) throw new Error(); begun = true;
        timer = setTimeout(cancel, Math.max(1, r.authorization.expiresAt*1000-Date.now()));
        await check();
        const receipt = await (o.receive ?? ((records, signal, checkAuthority) => receiveDataMount(records.delivery, { signal, checkAuthority })))(r, controller.signal, check);
        await check();
        if (canonicalJson(receipt) !== canonicalJson(mountedReceipt(r))) throw new Error();
        await store.saveReceipt(receipt);
    } catch {
        if (begun) await store.mark('failed');
        throw new Error('mount_execution_failed');
    } finally { clearTimeout(timer); process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel); }
}
if (isEntrypoint(import.meta.url)) {
    void (async () => {
        if (process.argv.length !== 3) throw new Error('mount_execution_invalid');
        await executeMountOperation(process.argv[2]!);
    })().catch(() => { process.stderr.write('{"code":"mount_execution_failed"}\n'); process.exitCode = 1; });
}
