import { dirname, join } from 'node:path';
import { isEntrypoint } from './entrypoint.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { acquireHostLock } from './host-lock.js';
import { ensureHostDirectory, hostAuthority, hostIdentity, readHostConfig, readHostFile } from './host-config.js';
import { ControlStore } from './control-store.js';
import { createControlService } from './control-server.js';
import { DockerComputerDriver } from './docker-driver.js';
import { canonicalJson, type ExecutionPlan } from './control-protocol.js';

const report = (event: string) => { process.stdout.write(`${JSON.stringify({ event })}\n`); };

/** Native Linux host entry point. Configuration and control.key are provisioned
 * by the trusted controller, outside every app mount. No environment credentials,
 * publisher configuration or browser session is used to authorize execution. */
export async function startHost(configPath: string, privateValidation = false) {
    const config = await readHostConfig(configPath, privateValidation);
    const snapshot = (value: typeof config) => ({ revision: value.configurationRevision,
        digest: createHash('sha256').update(canonicalJson(value)).digest('hex') });
    let activeConfiguration = snapshot(config);
    const secretPath = join(dirname(configPath), 'control.key');
    const secret = await readHostFile(secretPath, 32);
    if (secret.length !== 32) throw new Error('host_secret_invalid');
    const lock = await acquireHostLock();
    let store: ControlStore | undefined;
    let driver: DockerComputerDriver | undefined;
    let service: ReturnType<typeof createControlService> | undefined;
    let available = false, stopping = false, reloading = false, configurationValid = false;
    let authority = hostAuthority(config);
    let expiry: Promise<void> | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let reloadWork: Promise<void> | undefined;
    let shutdownWork: Promise<void> | undefined;
    const approve = (plan: ExecutionPlan, id: string) => !stopping && configurationValid && authority(plan, id);
    const shutdown = (): Promise<void> => {
        if (shutdownWork) return shutdownWork;
        stopping = true; available = false;
        if (timer) clearInterval(timer);
        shutdownWork = (async () => {
            try {
                if (service?.server.listening) {
                    const closed = new Promise<void>((resolve, reject) => service!.server.close(error => error ? reject(error) : resolve()));
                    service.server.closeAllConnections();
                    await closed;
                }
                await reloadWork;
                await service?.drain();
                await expiry;
                await driver?.stopAll();
                if (store) for (const intent of store.list()) store.observe(intent.installationId, intent.generation, 'stopped');
            } finally {
                try { await driver?.close(); }
                finally { store?.close(); secret.fill(0); await lock.release(); }
            }
        })();
        return shutdownWork;
    };
    try {
        await ensureHostDirectory(config.stateDirectory);
        await ensureHostDirectory(config.stagingRoot);
        store = new ControlStore(config.stateDirectory, config.computerId, config.computerGeneration);
        driver = new DockerComputerDriver({ computerId: config.computerId, computerGeneration: config.computerGeneration,
            volume: { computerId: config.computerId, volumeId: config.volumeId }, dataRoot: config.dataRoot,
            stagingRoot: config.stagingRoot, memoryBudgetMiB: config.memoryBudgetMiB, approvePlan: approve,
            reserveDeadline: (command, proposed) => store!.reserveRuntimeDeadline(command, proposed) });
        // Construct the driver first so startup rejection still stops owned
        // containers during shutdown. Never enable authority from stale files.
        store.acceptConfiguration(activeConfiguration.revision, activeConfiguration.digest);
        configurationValid = true;
        await driver.recover(store.list());
        service = createControlService({ computerId: config.computerId, computerGeneration: config.computerGeneration,
            secret, store, driver, approvePlan: approve, isAvailable: () => available && configurationValid && !stopping && !reloading,
            configuration: () => activeConfiguration,
            onFailure: report, onSettled: ({ installationId, generation, state }) => {
                process.stdout.write(`${JSON.stringify({ event: 'host_command_settled', installationId, generation, state })}\n`);
            } });
        await new Promise<void>((resolve, reject) => {
            service!.server.once('error', () => reject(new Error('host_listener_unavailable')));
            service!.server.listen(config.controlPort, '127.0.0.1', resolve);
        });
        available = true;
        // One outstanding expiry sweep at a time. Never queue unbounded timer
        // work behind a slow Docker operation or let status reads renew leases.
        timer = setInterval(() => {
            if (expiry || stopping || reloading) return;
            expiry = driver!.expire().then(() => { if (!stopping && !reloading) available = configurationValid; }).catch(() => {
                available = false;
                report('host_expiry_unconfirmed');
            }).finally(() => { expiry = undefined; });
        }, 1000);
        const reload = (): Promise<void> => {
            if (stopping) return Promise.reject(new Error('host_stopping'));
            if (reloadWork) return reloadWork;
            reloading = true; available = false; configurationValid = false; authority = () => false;
            reloadWork = (async () => {
                try {
                    const next = await readHostConfig(configPath, privateValidation);
                    const key = await readHostFile(secretPath, 32);
                    try {
                        if (hostIdentity(next) !== hostIdentity(config) || key.length !== secret.length || !timingSafeEqual(key, secret)) {
                            throw new Error('host_restart_required');
                        }
                    } finally { key.fill(0); }
                    await service!.drain();
                    const accepted = snapshot(next);
                    store!.acceptConfiguration(accepted.revision, accepted.digest);
                    authority = hostAuthority(next);
                    configurationValid = true;
                    await driver!.recover(store!.list());
                    activeConfiguration = accepted;
                    available = true;
                    report('host_configuration_reloaded');
                } catch {
                    configurationValid = false; authority = () => false;
                    await driver!.stopAll();
                    report('host_configuration_reload_failed');
                } finally { reloading = false; reloadWork = undefined; }
            })();
            return reloadWork;
        };
        report(privateValidation ? 'host_ready_private_validation' : 'host_ready');
        return { shutdown, reload };
    } catch (error) {
        await shutdown();
        throw error;
    }
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (!args[0] || args.length > 2 || (args[1] && args[1] !== '--private-validation')) throw new Error('host_arguments_invalid');
    const host = await startHost(args[0], args[1] === '--private-validation');
    let finishing = false;
    const stop = () => {
        if (finishing) return;
        finishing = true;
        const deadline = setTimeout(() => {
            report('host_shutdown_unconfirmed');
            process.exit(1);
        }, 60_000);
        void host.shutdown().then(() => report('host_stopped')).catch(() => {
            process.exitCode = 1;
            report('host_shutdown_unconfirmed');
        }).finally(() => clearTimeout(deadline));
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    process.on('SIGHUP', () => { void host.reload().catch(() => { report('host_reload_unconfirmed'); stop(); }); });
}

if (isEntrypoint(import.meta.url)) {
    void main().catch((error: unknown) => {
        const known = ['host_arguments_invalid', 'host_configuration_invalid', 'host_configuration_unavailable',
            'host_secret_invalid', 'host_file_unavailable', 'host_already_running', 'host_lock_unavailable',
            'production_image_or_origin_required', 'host_listener_unavailable'];
        report(error instanceof Error && known.includes(error.message) ? error.message : 'host_start_failed');
        process.exitCode = 1;
    });
}
