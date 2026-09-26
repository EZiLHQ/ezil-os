import { isEntrypoint } from './entrypoint.js';
import { canonicalJson } from './control-protocol.js';
import { bootstrapControlHost } from './control-bootstrap.js';
import { assertStartFence } from './start-operation.js';
import { StartOperationStore, startedReceipt, type StartRecords } from './start-operation-store.js';
import { stopSupervisor } from './supervisor-start.js';

/** Fixed systemd operation; extra checks only deny the receiver authority. */
export async function executeStartOperation(key: string, options: {
    privateValidation?: boolean; receive?: (r: StartRecords, signal: AbortSignal, check: () => Promise<void>) => Promise<unknown>;
} = {}) {
    if (process.platform !== 'linux' || process.getuid?.() !== 0 || !/^start-[a-f0-9-]{36}$/.test(key)
        || (options.receive && !options.privateValidation)) throw new Error('start_execution_invalid');
    const store = new StartOperationStore(key.slice(6)), controller = new AbortController(), cancel = () => controller.abort();
    process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
    let timer: ReturnType<typeof setTimeout> | undefined, begun = false, started = false;
    try {
        const r = await store.records();
        if (!r || !await store.flag('dispatched') || await store.flag('cancelled') || await store.flag('failed') || await store.receipt()) throw new Error();
        const check = async () => { if (controller.signal.aborted) throw new Error(); await assertStartFence(r, store); };
        await check(); if (!await store.mark('begun')) throw new Error(); begun = true;
        timer = setTimeout(cancel, Math.max(1, Math.min(90000, r.authorization.expiresAt*1000-Date.now())));
        await check();
        const receive = options.receive ?? ((records, signal, checkAuthority) => bootstrapControlHost(
            { schemaVersion: 1, authorizationId: records.authorization.authorizationId }, { signal, checkAuthority }));
        const receipt = await receive(r, controller.signal, check); started = true;
        await check(); if (canonicalJson(receipt) !== canonicalJson(startedReceipt(r))) throw new Error();
        await store.saveReceipt(receipt);
    } catch {
        // The receiver stops effects when it throws after its own attempt.
        // A failure after it returned success must also stop the real service.
        if (started) await stopSupervisor();
        if (begun) await store.mark('failed');
        throw new Error('start_execution_failed');
    } finally { clearTimeout(timer); process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel); }
}
if (isEntrypoint(import.meta.url)) void (async () => {
    if (process.argv.length !== 3) throw new Error('start_execution_invalid');
    await executeStartOperation(process.argv[2]!);
})().catch(() => { process.stderr.write('{"code":"start_execution_failed"}\n'); process.exitCode = 1; });
