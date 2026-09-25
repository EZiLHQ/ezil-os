import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { basename, dirname, isAbsolute, normalize } from 'node:path';
import { z } from 'zod';
import { canonicalJson, ExecutionPlanSchema, type ExecutionPlan } from './control-protocol.js';
import { openHostDirectory } from './mounts.js';

const path = z.string().max(256).refine(value => isAbsolute(value) && normalize(value) === value
    && value !== '/' && !value.endsWith('/') && value.slice(1).split('/').every(part => /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(part)));
export const HostConfigSchema = z.object({
    schemaVersion: z.literal(1), computerId: z.string().uuid(),
    computerGeneration: z.number().int().min(1).max(2_147_483_647),
    volumeId: z.string().regex(/^vol-[a-f0-9]{8}(?:[a-f0-9]{9})?$/),
    dataRoot: path, stateDirectory: path, stagingRoot: path,
    controlPort: z.number().int().min(1024).max(65535),
    memoryBudgetMiB: z.number().int().min(128).max(4096),
    suspended: z.boolean(),
    approvedInstallations: z.array(z.object({ installationId: z.string().uuid(), plan: ExecutionPlanSchema }).strict()).max(128),
}).strict().superRefine((value, context) => {
    const overlap = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
    if (overlap(value.dataRoot, value.stateDirectory) || overlap(value.dataRoot, value.stagingRoot)
        || overlap(value.stateDirectory, value.stagingRoot) || overlap(value.dataRoot, '/run/ezil-supervisor')) {
        context.addIssue({ code: 'custom', path: ['dataRoot'], message: 'overlapping_host_directories' });
    }
    const ids = value.approvedInstallations.map(item => item.installationId);
    if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', path: ['approvedInstallations'], message: 'duplicate_installation' });
    if (value.approvedInstallations.some(item => item.plan.services.some(service => service.hostPort === value.controlPort))) {
        context.addIssue({ code: 'custom', path: ['controlPort'], message: 'control_port_conflict' });
    }
});
export type HostConfig = z.infer<typeof HostConfigSchema>;

/** Pure syntax/compatibility checks. This file must be written by the trusted
 * controller from approved records; publisher manifests do not grant authority. */
export function parseHostConfig(value: unknown, privateValidation = false): HostConfig {
    const parsed = HostConfigSchema.safeParse(value);
    if (!parsed.success) throw new Error('host_configuration_invalid');
    const config = parsed.data;
    if (!privateValidation && config.approvedInstallations.some(({ plan }) =>
        !/^[0-9]{12}\.dkr\.ecr\.us-east-1\.amazonaws\.com\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(plan.image)
        || plan.allowedOrigins.some(origin => !origin.startsWith('https://')))) {
        throw new Error('production_image_or_origin_required');
    }
    return config;
}

/** Root-owned ancestors, no symlinks, bounded regular bytes, and no raw error
 * messages. O_NONBLOCK prevents a misplaced FIFO from hanging before fstat. */
export async function readHostFile(path: string, limit: number): Promise<Buffer> {
    const name = basename(path);
    if (!/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(name)) throw new Error('host_file_unavailable');
    const parent = await openHostDirectory(dirname(path));
    try {
        const file = await open(`/proc/self/fd/${parent.fd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            const stat = await file.stat();
            if (!stat.isFile() || stat.uid !== 0 || stat.mode & 0o077 || stat.nlink !== 1 || stat.size > limit) {
                throw new Error('host_file_unavailable');
            }
            const bytes = Buffer.alloc(limit + 1);
            let size = 0;
            while (size < bytes.length) {
                const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
                if (!bytesRead) break;
                size += bytesRead;
            }
            if (size > limit) throw new Error('host_file_unavailable');
            return bytes.subarray(0, size);
        } finally { await file.close(); }
    } catch { throw new Error('host_file_unavailable'); }
    finally { await parent.close(); }
}

export async function readHostConfig(path: string, privateValidation = false): Promise<HostConfig> {
    let value: unknown;
    try { value = JSON.parse((await readHostFile(path, 262144)).toString()); }
    catch { throw new Error('host_configuration_unavailable'); }
    const config = parseHostConfig(value, privateValidation);
    const directory = dirname(path);
    if (directory === config.dataRoot || directory.startsWith(`${config.dataRoot}/`)) throw new Error('host_configuration_invalid');
    return config;
}

export async function ensureHostDirectory(path: string): Promise<void> {
    const parent = await openHostDirectory(dirname(path));
    try {
        const name = basename(path);
        if (!/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(name)) throw new Error('unsafe_host_directory');
        try { await mkdir(`/proc/self/fd/${parent.fd}/${name}`, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        const dir = await openHostDirectory(path);
        try { if ((await dir.stat()).mode & 0o077) throw new Error('unsafe_host_directory'); }
        finally { await dir.close(); }
    } finally { await parent.close(); }
}

export function hostAuthority(config: HostConfig) {
    const plans = new Map(config.approvedInstallations.map(item => [item.installationId, canonicalJson(item.plan)]));
    return (plan: ExecutionPlan, installationId: string): boolean => !config.suspended
        && plans.get(installationId) === canonicalJson(plan);
}

export function hostIdentity(config: HostConfig): string {
    const { approvedInstallations: _plans, suspended: _suspended, ...identity } = config;
    return canonicalJson(identity);
}
