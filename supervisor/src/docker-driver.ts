import { constants } from 'node:fs';
import { mkdir, open, readdir, type FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ControlCommandSchema, intentDigest, type ExecutionPlan, type ReconcileCommand } from './control-protocol.js';
import type { StoredIntent } from './control-store.js';
import type { ComputerDriver } from './control-server.js';
import { admitMountedDataVolume, type VolumeIdentity } from './data-volume.js';
import { Docker, DockerError, type DockerContainer } from './docker.js';
import { openHostDirectory, openDataDirectory, stageDataDirectory, releaseDataDirectory, type StagedDirectory } from './mounts.js';
import { createServiceProxy } from './service-proxy.js';

const label = (key: string) => `org.ezil.computer.${key}`;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
type Options = { computerId: string; computerGeneration: number; volume: VolumeIdentity;
    dataRoot: string; stagingRoot: string; memoryBudgetMiB: number; docker?: Docker;
    approvePlan(plan: ExecutionPlan, installationId: string): boolean;
    reserveDeadline(command: ReconcileCommand, proposed: number): number };

async function privateDirectory(root: FileHandle, installationId: string, name: string): Promise<FileHandle> {
    let parent = root;
    try {
        const parts = ['Applications', installationId, name];
        for (const [index, part] of parts.entries()) {
            const path = `/proc/self/fd/${parent.fd}/${part}`;
            let created = false;
            try { await mkdir(path, { mode: 0o700 }); created = true; }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
            const child = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
            if (parent !== root) await parent.close();
            parent = child;
            const last = index === parts.length - 1;
            if (created && last) await child.chown(1000, 1000);
            const stat = await child.stat();
            if (stat.uid !== (last ? 1000 : 0) || stat.mode & 0o077 || stat.dev !== (await root.stat()).dev) {
                throw new Error('unsafe_private_directory');
            }
        }
        return parent;
    } catch {
        if (parent !== root) await parent.close();
        throw new Error('private_directory_unavailable');
    }
}

/** Real Docker execution, with one serialized admission queue per host. The
 * executable host MUST hold an OS-level singleton lock before constructing
 * this driver. Images must already be prepared by a separately approved job;
 * neither reconciliation nor observation pulls or builds an image. */
export class DockerComputerDriver implements ComputerDriver {
    private readonly docker: Docker;
    private queue: Promise<unknown> = Promise.resolve();
    private readonly stages = new Map<string, StagedDirectory[]>();
    private readonly proxies = new Map<string, Awaited<ReturnType<typeof createServiceProxy>>>();
    constructor(private readonly options: Options) {
        if (!uuid.test(options.computerId) || options.volume.computerId !== options.computerId
            || !Number.isInteger(options.computerGeneration) || options.computerGeneration < 1
            || !Number.isInteger(options.memoryBudgetMiB) || options.memoryBudgetMiB < 128
            || options.memoryBudgetMiB > 4096) throw new Error('invalid_driver_configuration');
        this.docker = options.docker ?? new Docker();
    }
    private serial<T>(work: () => Promise<T>): Promise<T> {
        const result = this.queue.then(work);
        this.queue = result.catch(() => undefined);
        return result;
    }
    private owns(container: DockerContainer, installationId?: string): boolean {
        const labels = container.Config.Labels;
        return labels[label('id')] === this.options.computerId
            && labels[label('generation')] === String(this.options.computerGeneration)
            && uuid.test(labels[label('installation')] ?? '')
            && (!installationId || labels[label('installation')] === installationId);
    }
    private async inspect(id: string): Promise<DockerContainer | undefined> {
        try { return await this.docker.call('GET', `/containers/${encodeURIComponent(id)}/json`); }
        catch (error) { if (error instanceof DockerError && error.status === 404) return undefined; throw error; }
    }
    private async containers(requireGeneration = false): Promise<DockerContainer[]> {
        const filters = encodeURIComponent(JSON.stringify({ label: [`${label('id')}=${this.options.computerId}`] }));
        const rows = await this.docker.call<{ Id: string }[]>('GET', `/containers/json?all=true&filters=${filters}`);
        const containers: DockerContainer[] = [];
        for (const row of rows) {
            const value = await this.inspect(row.Id);
            if (value && requireGeneration && !this.owns(value)
                && (value.State.Running || value.State.Status === 'restarting')) {
                throw new Error('computer_generation_conflict');
            }
            if (value && this.owns(value)) containers.push(value);
        }
        return containers;
    }
    async observe(installationId: string): Promise<{ state: StoredIntent['observed'] }> {
        if (!uuid.test(installationId)) throw new Error('invalid_installation');
        const containers = (await this.containers()).filter(item => this.owns(item, installationId));
        if (!containers.length || containers.every(item => !item.State.Running && item.State.Status !== 'restarting')) {
            return { state: 'stopped' };
        }
        return { state: containers.length === 1 && containers[0]!.State.Running ? 'running' : 'unknown' };
    }
    private async stop(container: DockerContainer): Promise<void> {
        if (!this.owns(container)) throw new Error('container_ownership_mismatch');
        if (container.State.Running || container.State.Status === 'restarting') {
            try { await this.docker.call('POST', `/containers/${container.Id}/stop?t=10`); }
            catch (error) { if (!(error instanceof DockerError && error.status === 304)) throw error; }
        }
        const after = await this.inspect(container.Id);
        if (after && (after.State.Running || !['exited', 'created', 'dead'].includes(after.State.Status))) {
            throw new Error('container_stop_unconfirmed');
        }
    }
    private async remove(installationId: string): Promise<void> {
        await this.closeProxy(installationId);
        const containers = (await this.containers()).filter(item => this.owns(item, installationId));
        for (const container of containers) {
            await this.stop(container);
            await this.docker.call('DELETE', `/containers/${container.Id}`);
            if (await this.inspect(container.Id)) throw new Error('container_removal_unconfirmed');
        }
        for (const stage of [...(this.stages.get(installationId) ?? [])].reverse()) await stage.release();
        this.stages.delete(installationId);
        // The staging namespace is root-owned. Only this installation's exact
        // server-generated slot grammar is eligible, including abandoned binds
        // from a crash before Docker created its container. No source data is
        // traversed or deleted, and Docker observation must have succeeded first.
        const root = await openHostDirectory(this.options.stagingRoot);
        try {
            const pattern = new RegExp(`^${installationId}-[1-9][0-9]{0,9}-[a-f0-9-]{36}-[0-9]{1,2}$`);
            for (const slot of await readdir(`/proc/self/fd/${root.fd}`)) {
                if (pattern.test(slot)) await releaseDataDirectory(this.options.stagingRoot, slot);
            }
        } finally { await root.close(); }
    }
    private async closeProxy(installationId: string): Promise<void> {
        await this.proxies.get(installationId)?.close();
        this.proxies.delete(installationId);
    }
    /** Disconnect routing during host shutdown without inventing new intent. */
    async close(): Promise<void> {
        await this.queue;
        for (const id of this.proxies.keys()) await this.closeProxy(id);
    }
    private async route(container: DockerContainer, plan: ExecutionPlan, current: () => boolean): Promise<void> {
        const id = container.Config.Labels[label('installation')]!;
        if (this.proxies.has(id)) return;
        const networks = Object.values(container.NetworkSettings.Networks);
        const network = await this.docker.call<{ Internal: boolean; Labels: Record<string, string> }>('GET',
            `/networks/${networks[0]?.NetworkID}`);
        if (networks.length !== 1 || !network.Internal || network.Labels[label('installation')] !== id
            || network.Labels[label('id')] !== this.options.computerId
            || network.Labels[label('generation')] !== String(this.options.computerGeneration)) throw new Error('invalid_service_network');
        const service = plan.services[0]!;
        const expiry = Number(container.Config.Labels[label('expires')]);
        const proxy = await createServiceProxy(service.hostPort, networks[0]!.IPAddress, service.internalPort,
            () => current() && Date.now() < expiry);
        this.proxies.set(id, proxy);
    }
    private names(installationId: string) {
        const name = `ezil-${this.options.computerId}-${this.options.computerGeneration}-${installationId}`;
        return { container: name, network: `${name}-net` };
    }
    private async network(installationId: string): Promise<string> {
        const { network: name } = this.names(installationId);
        try {
            const found = await this.docker.call<{ Id: string; Internal: boolean; Driver: string;
                Labels: Record<string, string> }>('GET', `/networks/${name}`);
            if (!found.Internal || found.Driver !== 'bridge'
                || found.Labels[label('id')] !== this.options.computerId
                || found.Labels[label('generation')] !== String(this.options.computerGeneration)
                || found.Labels[label('installation')] !== installationId) throw new Error('network_ownership_mismatch');
            return found.Id;
        } catch (error) { if (!(error instanceof DockerError && error.status === 404)) throw error; }
        return (await this.docker.call<{ Id: string }>('POST', '/networks/create', {
            Name: name, Driver: 'bridge', Internal: true, EnableIPv6: false,
            Labels: { [label('id')]: this.options.computerId, [label('generation')]: String(this.options.computerGeneration),
                [label('installation')]: installationId },
        })).Id;
    }
    private async admit(plan: ExecutionPlan, installationId: string): Promise<string> {
        if (!this.options.approvePlan(plan, installationId)) throw new Error('execution_plan_not_approved');
        if (plan.services.length !== 1 || plan.services[0]!.dependsOn.length) throw new Error('unsupported_service_layout');
        const admission = await admitMountedDataVolume(this.options.dataRoot, this.options.volume);
        if (!admission.ok) throw new Error(admission.code);
        const image = await this.docker.call<{ Id: string; Os: string; Architecture: string;
            RepoDigests: string[]; Config: { Volumes?: Record<string, unknown>; OnBuild?: unknown[] } }>(
            'GET', `/images/${encodeURIComponent(plan.image)}/json`);
        if (image.Os !== 'linux' || image.Architecture !== 'amd64'
            || Object.keys(image.Config.Volumes ?? {}).length || image.Config.OnBuild?.length
            || (plan.image.startsWith('sha256:') ? image.Id !== plan.image : !image.RepoDigests?.includes(plan.image))) {
            throw new Error('unsupported_runtime_image');
        }
        return image.Id;
    }
    private async health(plan: ExecutionPlan, tokenPath: string | undefined, current: () => boolean): Promise<void> {
        const service = plan.services[0]!;
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline && current()) {
            try {
                const headers: Record<string, string> = {};
                if (tokenPath) {
                    const file = await open(tokenPath, constants.O_RDONLY | constants.O_NOFOLLOW);
                    try {
                        const stat = await file.stat();
                        if (!stat.isFile() || stat.size > 44 || stat.mode & 0o077) throw new Error('invalid_token');
                        const bytes = Buffer.alloc(45);
                        const { bytesRead } = await file.read(bytes, 0, 45, 0);
                        const token = bytes.subarray(0, bytesRead).toString().trim();
                        if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('invalid_token');
                        headers.Authorization = `Bearer ${token}`;
                    } finally { await file.close(); }
                }
                const response = await fetch(`http://127.0.0.1:${service.hostPort}${service.health.path}`, {
                    headers, redirect: 'error', signal: AbortSignal.timeout(1000),
                });
                await response.body?.cancel();
                if (response.status === service.health.status && current()) return;
            } catch { /* Bounded retry; never expose tokens or upstream errors. */ }
            await delay(200);
        }
        throw new Error('service_health_unconfirmed');
    }
    reconcile(intent: StoredIntent, isCurrent: () => boolean): Promise<StoredIntent['observed']> {
        return this.serial(async () => {
            const command = ControlCommandSchema.parse(intent.command);
            if (command.operation !== 'reconcile' || command.computerId !== this.options.computerId
                || command.computerGeneration !== this.options.computerGeneration
                || command.installationId !== intent.installationId || command.generation !== intent.generation
                || command.desired !== intent.desired) throw new Error('invalid_driver_intent');
            if (!isCurrent()) return 'unknown';
            if (intent.desired === 'stopped') { await this.remove(intent.installationId); return 'stopped'; }
            const plan = command.plan;
            const current = () => isCurrent() && this.options.approvePlan(plan, intent.installationId);
            const image = await this.admit(plan, intent.installationId);
            if (!current()) return 'unknown';
            const existing = (await this.containers(true)).filter(item => this.owns(item, intent.installationId));
            const same = existing.length === 1 && existing[0]!.Config.Labels[label('intent')] === intentDigest(command);
            const observedExpiry = same ? Number(existing[0]!.Config.Labels[label('expires')]) : undefined;
            if (observedExpiry !== undefined && (!Number.isSafeInteger(observedExpiry) || observedExpiry <= 0)) {
                await this.stop(existing[0]!);
                throw new Error('runtime_deadline_invalid');
            }
            const expires = this.options.reserveDeadline(command,
                Math.min(observedExpiry ?? Infinity, Date.now() + plan.resources.maxRuntimeSeconds * 1000));
            if (!Number.isSafeInteger(expires) || expires <= Date.now()) {
                for (const container of existing) await this.stop(container);
                throw new Error('runtime_deadline_reached');
            }
            if (same) {
                // A process restart reattaches to an already running container;
                // a stopped container is recreated, never restarted via old FDs.
                if (existing[0]!.State.Running && existing[0]!.Image === image && observedExpiry === expires && current()) {
                    try {
                        let token: string | undefined;
                        const process = plan.services[0]!.process;
                        if (process.kind === 'reticle-daemon-v1') {
                            const destination = plan.privateDirectories.find(item => item.name === process.privateDirectory)!.containerPath;
                            const mount = existing[0]!.Mounts.find(item => item.Destination === destination);
                            const prefix = `${this.options.stagingRoot}/${intent.installationId}-`;
                            if (!mount?.Source.startsWith(prefix) || mount.Source.slice(prefix.length).includes('/')) {
                                throw new Error('invalid_private_mount');
                            }
                            token = `${mount.Source}/pairing-token`;
                        }
                        await this.route(existing[0]!, plan, current);
                        await this.health(plan, token, () => current() && Date.now() < expires);
                        return 'running';
                    } catch {
                        await this.remove(intent.installationId);
                        throw new Error('service_health_unconfirmed');
                    }
                }
            }
            await this.remove(intent.installationId);
            const others = await this.containers(true);
            const active = others.filter(item => item.State.Running || item.State.Status === 'created' || item.State.Status === 'restarting');
            if (active.length >= 2 || active.some(item => item.HostConfig.Memory <= 0)
                || active.reduce((sum, item) => sum + item.HostConfig.Memory, 0) + plan.resources.memoryMiB * 1048576
                    > this.options.memoryBudgetMiB * 1048576) throw new Error('computer_capacity_exceeded');
            const leased = new Set(others.map(item => Number(item.Config.Labels[label('host-port')])));
            if (plan.services.some(service => leased.has(service.hostPort))) throw new Error('host_port_in_use');
            if (!current()) return 'unknown';
            const root = await openHostDirectory(this.options.dataRoot);
            const stages: StagedDirectory[] = [];
            this.stages.set(intent.installationId, stages);
            const mounts: { Type: string; Source: string; Target: string; ReadOnly: boolean;
                BindOptions: { Propagation: string; NonRecursive: boolean } }[] = [];
            const attempt = `${intent.installationId}-${intent.generation}-${randomUUID()}`;
            let tokenPath: string | undefined;
            try {
                const bind = async (source: FileHandle, destination: string, readOnly: boolean) => {
                    try {
                        const stage = await stageDataDirectory(source, this.options.stagingRoot, `${attempt}-${stages.length}`, readOnly);
                        stages.push(stage);
                        mounts.push({ Type: 'bind', Source: stage.source, Target: destination, ReadOnly: readOnly,
                            BindOptions: { Propagation: 'rprivate', NonRecursive: true } });
                        return stage.source;
                    } finally { await source.close(); }
                };
                const service = plan.services[0]!;
                for (const grant of plan.projectGrants) {
                    await bind(await openDataDirectory(root, ['Projects', grant.projectId]), grant.containerPath, grant.access === 'read');
                }
                for (const dir of plan.privateDirectories) {
                    const staged = await bind(await privateDirectory(root, intent.installationId, dir.name), dir.containerPath, false);
                    if (service.process.kind === 'reticle-daemon-v1' && dir.name === service.process.privateDirectory) {
                        tokenPath = `${staged}/pairing-token`;
                    }
                }
                if (!current()) throw new Error('superseded_command');
                const network = await this.network(intent.installationId);
                const env = ['NODE_ENV=production', 'RETICLE_TELEMETRY=0', 'DO_NOT_TRACK=1', `PORT=${service.internalPort}`];
                let entrypoint: string[];
                let workingDir = '/opt/app';
                if (service.process.kind === 'reticle-daemon-v1') {
                    const process = service.process;
                    workingDir = plan.projectGrants.find(item => item.projectId === process.projectId)!.containerPath;
                    const privatePath = plan.privateDirectories.find(item => item.name === process.privateDirectory)!.containerPath;
                    env.push(`EZIL_RETICLE_PROJECT_PATH=${workingDir}`, `EZIL_RETICLE_PRIVATE_PATH=${privatePath}`,
                        `EZIL_RETICLE_ALLOWED_ORIGINS=${JSON.stringify(plan.allowedOrigins)}`);
                    entrypoint = ['/usr/local/bin/node', '/opt/ezil/reticle-adapter.js'];
                } else entrypoint = ['/usr/local/bin/node', `/opt/app/${service.process.entrypoint}`, ...service.process.args];
                const port = `${service.internalPort}/tcp`;
                const created = await this.docker.call<{ Id: string }>('POST', `/containers/create?name=${this.names(intent.installationId).container}`, {
                    Image: image, User: '1000:1000', Entrypoint: entrypoint, Cmd: [], WorkingDir: workingDir, Env: env,
                    Healthcheck: { Test: ['NONE'] }, StopTimeout: 10, ExposedPorts: { [port]: {} },
                    Labels: { [label('id')]: this.options.computerId, [label('generation')]: String(this.options.computerGeneration),
                        [label('installation')]: intent.installationId, [label('intent')]: intentDigest(command),
                        [label('expires')]: String(expires), [label('host-port')]: String(service.hostPort) },
                    HostConfig: { NetworkMode: network, ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
                        Privileged: false, Init: true, PidsLimit: 256, Memory: plan.resources.memoryMiB * 1048576,
                        MemorySwap: plan.resources.memoryMiB * 1048576, NanoCpus: Math.floor(plan.resources.cpu * 1e9),
                        RestartPolicy: { Name: 'no' }, Mounts: mounts,
                        Tmpfs: { '/tmp': `rw,noexec,nosuid,nodev,size=${plan.resources.temporaryMiB}m,mode=1777` },
                        LogConfig: { Type: 'local', Config: { 'max-size': '1m', 'max-file': '2' } } },
                });
                if (!current()) throw new Error('superseded_command');
                await this.docker.call('POST', `/containers/${created.Id}/start`);
                const started = await this.inspect(created.Id);
                if (!started?.State.Running) throw new Error('start_unconfirmed');
                await this.route(started, plan, current);
                await this.health(plan, tokenPath, () => current() && Date.now() < expires);
                const after = await this.inspect(created.Id);
                if (!current() || !after?.State.Running || after.Image !== image || Date.now() >= expires) throw new Error('start_unconfirmed');
                return 'running';
            } catch {
                // Includes create/start timeouts: re-observe labelled resources
                // before releasing mounts; a failed observation leaves anchors.
                await this.remove(intent.installationId);
                throw new Error('application_start_failed');
            } finally { await root.close(); }
        });
    }
    /** Host bootstrap must run this periodically, including after recovery.
     * Expired containers remain stopped as deadline tombstones until a newer
     * signed generation replaces them. Status/retries cannot renew a lease. */
    expire(): Promise<void> {
        return this.serial(async () => {
            for (const container of await this.containers()) {
                const deadline = Number(container.Config.Labels[label('expires')]);
                if (!Number.isSafeInteger(deadline) || deadline <= Date.now()) {
                    await this.closeProxy(container.Config.Labels[label('installation')]!);
                    await this.stop(container);
                }
            }
        });
    }
    /** Recovery may stop unapproved/unknown intent; it never starts containers
     * or reconnects a browser route. Fresh signed control is required for that. */
    recover(intents: StoredIntent[]): Promise<void> {
        return this.serial(async () => {
            const mounted = await admitMountedDataVolume(this.options.dataRoot, this.options.volume);
            for (const container of await this.containers()) {
                const id = container.Config.Labels[label('installation')]!;
                const intent = intents.find(item => item.installationId === id);
                const expires = Number(container.Config.Labels[label('expires')]);
                const authorized = mounted.ok && intent && intent.desired === 'running'
                    && intentDigest(intent.command) === container.Config.Labels[label('intent')]
                    && this.options.approvePlan(intent.command.plan, id)
                    && Number.isSafeInteger(expires) && expires > 0;
                if (!authorized || this.options.reserveDeadline(intent.command, expires) !== expires || expires <= Date.now()) {
                    await this.closeProxy(id);
                    await this.stop(container);
                }
            }
        });
    }
    /** Host shutdown retains data, images and deadline records. Report success
     * only after Docker confirms every owned container stopped. */
    stopAll(): Promise<void> {
        return this.serial(async () => {
            let failed = false;
            for (const id of this.proxies.keys()) await this.closeProxy(id);
            for (const container of await this.containers()) {
                try { await this.stop(container); } catch { failed = true; }
            }
            if (failed) throw new Error('host_shutdown_unconfirmed');
        });
    }
}
