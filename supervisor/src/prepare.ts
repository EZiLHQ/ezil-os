import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname } from 'node:path';
import { isEntrypoint } from './entrypoint.js';
import { z } from 'zod';
import { Docker, DockerError } from './docker.js';
import { admitMountedDataVolume } from './data-volume.js';
import { canonicalJson } from './control-protocol.js';
import { readHostConfig, readHostFile, hostIdentity, installationPreparations, type HostConfig } from './host-config.js';
import { acquireHostLock } from './host-lock.js';
import { openHostDirectory } from './mounts.js';
import { privateDirectory } from './installation-data.js';
import { inspectRuntimeImage } from './runtime-image.js';

const credentialsSchema = z.array(z.object({
    registry: z.string().regex(/^[0-9]{12}\.dkr\.ecr\.us-east-1\.amazonaws\.com$/),
    token: z.string().min(1).max(16384).regex(/^[^\x00-\x20\x7f]+$/),
}).strict()).max(8);
const digest = (config: HostConfig) => createHash('sha256').update(canonicalJson(config)).digest('hex');
export interface PreparationReceipt {
    computerId: string; computerGeneration: number; configurationRevision: number;
    configurationDigest: string; preparedImages: { reference: string; contentId: string }[];
}

/** Root-only installation path. Desired configuration is already authorized,
 * transferred by trusted provisioning as a protected file, never by the app.
 * Preparing does not execute image code, modify projects, create containers,
 * start compute, reload a host or claim serving readiness. */
export async function prepareHostConfiguration(inputPath: string, activePath: string,
    options: { credentialsPath?: string; privateValidation?: boolean; signal?: AbortSignal; docker?: Docker;
        beforeCommit?: () => Promise<void> } = {}): Promise<PreparationReceipt> {
    const signal = AbortSignal.any([AbortSignal.timeout(900_000), ...(options.signal ? [options.signal] : [])]);
    const checkCancelled = () => { if (signal.aborted) throw new Error('preparation_cancelled'); };
    checkCancelled();
    const desired = await readHostConfig(inputPath, options.privateValidation);
    const lock = await acquireHostLock('preparation');
    let parent;
    try { parent = await openHostDirectory(dirname(activePath)); }
    catch (error) { await lock.release(); throw error; }
    const name = basename(activePath);
    const temporary = `.prepare-${randomUUID()}`;
    const temporaryPath = `/proc/self/fd/${parent.fd}/${temporary}`;
    let temporaryCreated = false;
    try {
        if (!/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(name)
            || dirname(activePath) === desired.dataRoot || dirname(activePath).startsWith(`${desired.dataRoot}/`)) {
            throw new Error('host_configuration_invalid');
        }
        // Missing is allowed on initial setup. Any other read/file error fails
        // closed; malformed, linked or permissive files are never overwritten.
        let existing = false;
        try {
            const file = await open(`/proc/self/fd/${parent.fd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            await file.close(); existing = true;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('host_configuration_unavailable'); }
        if (existing) {
            const current = await readHostConfig(activePath, options.privateValidation);
            if (hostIdentity(current) !== hostIdentity(desired)) throw new Error('host_restart_required');
            if (desired.configurationRevision < current.configurationRevision
                || (desired.configurationRevision === current.configurationRevision && digest(desired) !== digest(current))) {
                throw new Error('configuration_revision_conflict');
            }
        }
        const preparedImages: PreparationReceipt['preparedImages'] = [];
        const docker = options.docker ?? new Docker();
        if (!desired.suspended) {
            const admission = await admitMountedDataVolume(desired.dataRoot, { computerId: desired.computerId, volumeId: desired.volumeId });
            if (!admission.ok) throw new Error(admission.code);
            // Complete structural admission before downloading anything.
            const ports = new Set<number>();
            for (const { plan } of desired.approvedInstallations) {
                if (plan.services.length !== 1 || plan.services[0]!.dependsOn.length) throw new Error('unsupported_service_layout');
                if (plan.resources.memoryMiB > desired.memoryBudgetMiB) throw new Error('unsupported_memory_requirement');
                const port = plan.services[0]!.hostPort;
                if (ports.has(port)) throw new Error('installation_port_conflict');
                ports.add(port);
            }
            const preparations = installationPreparations(desired);
            for (const reference of new Set(preparations.map(item => item.image))) {
                checkCancelled();
                let contentId: string;
                try { contentId = await inspectRuntimeImage(docker, reference); }
                catch (error) {
                    if (!(error instanceof DockerError && error.status === 404) || reference.startsWith('sha256:')) throw error;
                    let credentials: { registry: string; token: string } | undefined;
                    if (!options.privateValidation || options.credentialsPath) {
                        if (!options.credentialsPath) throw new Error('registry_credentials_required');
                        let parsed: unknown;
                        try { parsed = JSON.parse((await readHostFile(options.credentialsPath, 150000)).toString()); }
                        catch { throw new Error('registry_credentials_invalid'); }
                        const result = credentialsSchema.safeParse(parsed);
                        if (!result.success) throw new Error('registry_credentials_invalid');
                        credentials = result.data.find(item => item.registry === reference.split('/')[0]);
                        if (!credentials) throw new Error('registry_credentials_required');
                    }
                    await docker.pullImage(reference, credentials, signal);
                    checkCancelled();
                    contentId = await inspectRuntimeImage(docker, reference);
                }
                preparedImages.push({ reference, contentId });
            }
            checkCancelled();
            const root = await openHostDirectory(desired.dataRoot);
            try {
                for (const { installationId, privateDirectories } of preparations) {
                    for (const directory of privateDirectories) {
                        checkCancelled();
                        const handle = await privateDirectory(root, installationId, directory.name);
                        await handle.sync(); await handle.close();
                    }
                }
                await root.sync();
            } finally { await root.close(); }
            // A changed mount after preparation must not activate approvals.
            const verified = await admitMountedDataVolume(desired.dataRoot, { computerId: desired.computerId, volumeId: desired.volumeId });
            if (!verified.ok) throw new Error(verified.code);
        }
        checkCancelled();
        const file = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        temporaryCreated = true;
        try { await file.writeFile(canonicalJson(desired)); await file.sync(); }
        finally { await file.close(); }
        checkCancelled();
        await options.beforeCommit?.();
        checkCancelled();
        await rename(temporaryPath, `/proc/self/fd/${parent.fd}/${name}`);
        temporaryCreated = false;
        try { await parent.sync(); }
        catch { throw new Error('preparation_commit_unconfirmed'); }
        return { computerId: desired.computerId, computerGeneration: desired.computerGeneration,
            configurationRevision: desired.configurationRevision, configurationDigest: digest(desired), preparedImages };
    } finally {
        try { if (temporaryCreated) await unlink(temporaryPath); }
        finally { await parent.close(); await lock.release(); }
    }
}

async function main() {
    const args = process.argv.slice(2);
    const privateValidation = args.includes('--private-validation');
    const paths = args.filter(arg => arg !== '--private-validation');
    if (paths.length < 2 || paths.length > 3 || args.filter(arg => arg === '--private-validation').length > 1) {
        throw new Error('preparation_arguments_invalid');
    }
    const abort = new AbortController();
    const cancel = () => abort.abort();
    process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
    try {
        const result = await prepareHostConfiguration(paths[0]!, paths[1]!, {
            ...(paths[2] ? { credentialsPath: paths[2] } : {}), privateValidation, signal: abort.signal });
        process.stdout.write(`${JSON.stringify({ event: 'host_prepared', computerId: result.computerId,
            computerGeneration: result.computerGeneration, configurationRevision: result.configurationRevision,
            configurationDigest: result.configurationDigest })}\n`);
    } finally { process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel); }
}
if (isEntrypoint(import.meta.url)) {
    void main().catch((error: unknown) => {
        const codes = ['preparation_arguments_invalid', 'preparation_cancelled', 'preparation_commit_unconfirmed',
            'configuration_revision_conflict', 'host_restart_required', 'preparation_already_running',
            'registry_credentials_required', 'registry_credentials_invalid', 'unsupported_runtime_image',
            'unsupported_service_layout', 'unsupported_memory_requirement', 'installation_port_conflict',
            'data_marker_invalid', 'data_mount_missing', 'data_volume_mismatch'];
        const code = error instanceof Error && codes.includes(error.message) ? error.message : 'preparation_unavailable';
        process.stderr.write(`${JSON.stringify({ event: 'host_preparation_failed', code })}\n`);
        process.exitCode = 1;
    });
}
