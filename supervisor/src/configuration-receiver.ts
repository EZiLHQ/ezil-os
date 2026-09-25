import { constants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import type { S3ClientConfig } from '@aws-sdk/client-s3';
import { instanceCredentials, type MetadataRequest } from './aws-host-identity.js';
import { descriptor, validateConfiguration, validateDelivery } from './configuration-delivery-contract.js';
import { ensureHostDirectory, readHostFile, installationPreparations } from './host-config.js';
import { prepareHostConfiguration } from './prepare.js';
import { acquireHostLock } from './host-lock.js';
import { fetchConfiguration } from './aws-configuration-source.js';

const exec = promisify(execFile);
const DIRECTORY = '/run/ezil-supervisor';
const ACTIVE = '/etc/ezil-supervisor/config.json';
const PROVISIONING = '/etc/ezil-supervisor/provisioning.json';

export async function requestServiceReload(signal: AbortSignal) {
    // reload never starts an inactive service. No caller-selected unit, PID,
    // shell, restart fallback or application service command is accepted.
    await exec('/usr/bin/systemctl', ['reload', 'ezil-supervisor.service'], {
        env: { PATH: '/usr/bin:/bin', LANG: 'C' }, signal, timeout: 5000, maxBuffer: 4096,
    });
}

export interface ReceiverOptions {
    signal?: AbortSignal;
    /** Local Linux acceptance only. These paths and seams are never SSM data. */
    privateValidation?: boolean; provisioningPath?: string; activePath?: string;
    requestHandler?: S3ClientConfig['requestHandler']; metadataRequest?: MetadataRequest;
    reload?: (signal: AbortSignal) => Promise<void>;
}

/** Trusted root-only receiver. Current control-plane authorization is checked
 * by the workflow before SSM dispatch. Local checks bind the immutable reference
 * to the provisioned writer and actual IMDS identity; preparation additionally
 * admits the data mount and monotonic revision. No operation wakes compute. */
export async function receiveConfiguration(input: unknown, options: ReceiverOptions = {}) {
    if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('configuration_receiver_requires_root');
    if (!options.privateValidation && (options.provisioningPath || options.activePath || options.reload)) {
        throw new Error('configuration_receiver_options_invalid');
    }
    const signal = AbortSignal.any([AbortSignal.timeout(900000), ...(options.signal ? [options.signal] : [])]);
    const check = () => { if (signal.aborted) throw new Error('configuration_delivery_cancelled'); };
    check();
    const lock = await acquireHostLock('delivery');
    let inputFile: string | undefined, credentialsFile: string | undefined;
    const temporaryPaths = new Set<string>();
    let downloaded: Awaited<ReturnType<typeof fetchConfiguration>> | undefined;
    try {
        const provisioningPath = options.provisioningPath ?? PROVISIONING;
        const provisioningBytes = await readHostFile(provisioningPath, 4096);
        const checkFence = async () => {
            check();
            if (!(await readHostFile(provisioningPath, 4096)).equals(provisioningBytes)) throw new Error('configuration_delivery_fenced');
        };
        const { value, host } = validateDelivery(input, JSON.parse(provisioningBytes.toString()));
        const activePath = options.activePath ?? ACTIVE;
        // Even reload validates actual instance identity. It does not download,
        // pull an image or rewrite the prepared configuration.
        if (value.operation === 'reload') {
            await instanceCredentials({ accountId: host.accountId, region: host.region, instanceId: host.scope.providerInstanceId }, signal, options.metadataRequest);
            validateConfiguration(await readHostFile(activePath, 262144), value, host, options.privateValidation);
        } else {
            downloaded = await fetchConfiguration(value, host, signal, options);
            const config = validateConfiguration(downloaded.bytes, value, host, options.privateValidation);
            await ensureHostDirectory(DIRECTORY);
            const writePrivate = async (suffix: string, bytes: Buffer) => {
                const path = `${DIRECTORY}/delivery-${randomUUID()}.${suffix}`;
                const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
                temporaryPaths.add(path);
                try { await file.writeFile(bytes); await file.sync(); }
                finally { await file.close(); }
                return path;
            };
            inputFile = await writePrivate('json', downloaded.bytes);
            if (!config.suspended && installationPreparations(config).some(item => !item.image.startsWith('sha256:'))) {
                const registry = await downloaded.registryCredentials();
                try { credentialsFile = await writePrivate('credentials', registry); }
                finally { registry.fill(0); }
            }
            check();
            // A replaced provisioning record fences an already-started download.
            await checkFence();
            const receipt = await prepareHostConfiguration(inputFile, activePath, {
                privateValidation: options.privateValidation ?? false, signal, ...(credentialsFile ? { credentialsPath: credentialsFile } : {}),
                beforeCommit: checkFence,
            });
            if (receipt.computerId !== value.scope.computerId || receipt.computerGeneration !== value.scope.computerGeneration
                || receipt.configurationRevision !== value.revision || receipt.configurationDigest !== value.digest) throw new Error('configuration_delivery_unconfirmed');
        }
        check();
        await checkFence();
        if (value.operation === 'reload') await (options.reload ?? requestServiceReload)(signal);
        return { schemaVersion: 1, operation: value.operation, configurationId: value.configurationId, scope: value.scope, descriptor: descriptor(value) };
    } catch (error) {
        const code = error instanceof Error && ['configuration_delivery_invalid', 'configuration_content_invalid', 'configuration_revision_conflict',
            'configuration_delivery_cancelled', 'configuration_delivery_fenced', 'configuration_delivery_unconfirmed', 'host_identity_unavailable'].includes(error.message)
            ? error.message : 'configuration_delivery_unavailable';
        throw new Error(code);
    } finally {
        downloaded?.destroy(); downloaded?.bytes.fill(0);
        const cleanup = await Promise.allSettled([...temporaryPaths].map(path => unlink(path)));
        await lock.release();
        if (cleanup.some(result => result.status === 'rejected')) throw new Error('configuration_cleanup_unconfirmed');
    }
}

async function main() {
    if (process.argv.length !== 2) throw new Error('configuration_delivery_invalid');
    const abort = new AbortController(); const cancel = () => abort.abort();
    process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
    const timeout = setTimeout(cancel, 900000);
    try {
        const chunks: Buffer[] = []; let bytes = 0;
        abort.signal.addEventListener('abort', () => process.stdin.destroy(new Error('configuration_delivery_cancelled')), { once: true });
        for await (const chunk of process.stdin) {
            bytes += chunk.length; if (bytes > 8192) throw new Error('configuration_delivery_invalid'); chunks.push(Buffer.from(chunk));
        }
        const receipt = await receiveConfiguration(JSON.parse(Buffer.concat(chunks).toString()), { signal: abort.signal });
        process.stdout.write(`${JSON.stringify(receipt)}\n`);
    } finally { clearTimeout(timeout); process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    void main().catch(() => { process.stderr.write('{"code":"configuration_delivery_failed"}\n'); process.exitCode = 1; });
}
