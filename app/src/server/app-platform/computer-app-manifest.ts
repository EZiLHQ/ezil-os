import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
    EgressOriginsSchema, EmbeddingSchema, GithubRepositorySchema, HealthSchema, HttpPathSchema,
    OciImageSchema, RelativePathSchema, SecretReferenceSchema, SecretReferencesSchema,
    Sha256DigestSchema, UuidSchema, parseContract, uniqueArray,
} from './manifest';
import type { ContractIssue, ContractResult } from './manifest';

const name = z.string().min(1).max(80).refine((value) => value.trim().length > 0
    && [...value].every((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && (code < 127 || code > 159);
    }));
const slug = z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const version = z.string().max(64).regex(/^[a-z0-9][a-z0-9.+_-]*$/i);
const serviceName = z.string().max(48).regex(/^[a-z][a-z0-9-]*$/);
const port = z.number().int().min(1024).max(65535);
const envName = SecretReferenceSchema.shape.name;
const nodeEntrypoint = RelativePathSchema.refine((value) => /\.(?:js|mjs|cjs)$/.test(value) && !value.startsWith('-'));
const argvItem = z.string().min(1).max(256).refine((value) =>
    [...value].every((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && (code < 127 || code > 159);
    }));

function containerPath(root: 'data' | 'workspace') {
    return z.string().max(240).refine((value) => value.startsWith(`/${root}/`)
        && value.split('/').slice(2).every((part) => part !== '.' && part !== '..'
            && /^[a-z0-9._-]+$/i.test(part)));
}

const service = z.object({
    name: serviceName,
    protocol: z.literal('http'),
    // Reticle's daemon is selected-project-scoped; opening its integration
    // window must not start or connect every project on the computer.
    scope: z.enum(['installation', 'selected-project']),
    // Every named service has a process. The trusted Reticle adapter calls the
    // upstream foreground daemon API; its `serve` CLI detaches and cannot be a
    // reliable container entrypoint. There is no publisher-supplied shell.
    process: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('node'), entrypoint: nodeEntrypoint, args: z.array(argvItem).max(16).default([]) }).strict(),
        z.object({ kind: z.literal('reticle-daemon-v1') }).strict(),
        z.object({ kind: z.literal('oci-entrypoint') }).strict(),
    ]),
    internalPort: port,
    // A preference, not a lease. The supervisor may assign 20000-29999.
    preferredHostPort: port.optional(),
    health: HealthSchema,
    dependsOn: uniqueArray(serviceName, 4).default([]),
}).strict();

const privateDirectory = z.object({
    name: serviceName,
    containerPath: containerPath('data'),
}).strict();

const sharedFolder = z.object({
    folder: z.enum(['Documents', 'Projects', 'Downloads']),
    access: z.enum(['read', 'read-write']),
    scope: z.enum(['whole-folder', 'selected-projects']),
    containerPath: containerPath('workspace'),
}).strict().superRefine((request, ctx) => {
    if (request.scope === 'selected-projects' && request.folder !== 'Projects') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scope'], message: 'invalid_scope' });
    }
});

const configurationField = z.object({
    name: envName,
    kind: z.enum(['text', 'url', 'boolean', 'integer']),
    required: z.boolean(),
}).strict();

const computerCapability = z.enum(['projects.read', 'projects.write', 'runs.read', 'mcp.invoke']);
export const ComputerCapabilitiesSchema = uniqueArray(computerCapability, 4).default([]);

const build = z.discriminatedUnion('recipe', [
    z.object({
        recipe: z.literal('npm-ci-v1'),
        script: z.literal('build').optional(),
    }).strict(),
    z.object({
        recipe: z.literal('pnpm-workspace-v1'),
        workspace: RelativePathSchema,
        pnpmVersion: z.string().max(50).regex(/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/)
            .refine((value) => value.split('.').every((part) => Number.isSafeInteger(Number(part)))),
        lockfileDigest: Sha256DigestSchema,
        script: z.literal('build').optional(),
    }).strict(),
]);

const persistence = z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('ephemeral') }).strict(),
    z.object({
        mode: z.literal('computer-volume'),
        privateDirectories: z.array(privateDirectory).max(16),
        sharedFolders: z.array(sharedFolder).max(3),
        backup: z.discriminatedUnion('mode', [
            z.object({ mode: z.literal('daily-snapshot') }).strict(),
            // Recognized but not a pilot backup adapter.
            z.object({ mode: z.literal('database-adapter'), adapter: z.literal('postgres-v1') }).strict(),
        ]),
    }).strict(),
]);

/** Publisher declarations are requests, never deployment authority. Host disk
 * roots, EC2 IDs, assigned host ports and tunnel credentials are server-derived
 * and deliberately absent. This contract cannot establish ownership or source
 * provenance; the control plane must authorize and inspect them separately. */
export const ComputerAppManifestV2Schema = z.object({
    schemaVersion: z.literal(2),
    appId: UuidSchema,
    publisherId: UuidSchema,
    name,
    slug,
    version,
    source: z.discriminatedUnion('kind', [
        z.object({
            kind: z.literal('github'),
            url: GithubRepositorySchema,
            commitSha: z.string().length(40).regex(/^[a-f0-9]{40}$/i).transform((value) => value.toLowerCase()),
            subdirectory: RelativePathSchema.optional(),
        }).strict(),
        z.object({ kind: z.literal('oci'), image: OciImageSchema }).strict(),
    ]),
    runtime: z.discriminatedUnion('profile', [
        z.object({ profile: z.literal('node24-computer-v1'), architecture: z.literal('linux/amd64') }).strict(),
        z.object({ profile: z.literal('oci-linux-amd64'), architecture: z.literal('linux/amd64') }).strict(),
    ]),
    build: build.optional(),
    services: z.array(service).min(1).max(8),
    launch: z.discriminatedUnion('mode', [
        z.object({ mode: z.literal('web'), service: serviceName, path: HttpPathSchema, embedding: EmbeddingSchema }).strict(),
        z.object({ mode: z.literal('integration'), adapter: z.literal('reticle-v1'), service: serviceName }).strict(),
    ]),
    configuration: z.array(configurationField).max(24).default([]),
    capabilities: ComputerCapabilitiesSchema,
    secrets: SecretReferencesSchema,
    egressOrigins: EgressOriginsSchema,
    resources: z.object({
        cpu: z.number().finite().positive().max(2),
        memoryMiB: z.number().int().min(128).max(8192),
        ephemeralDiskMiB: z.number().int().positive().max(30_720),
        maxRuntimeSeconds: z.number().int().positive().max(86_400),
    }).strict(),
    persistence,
    update: z.discriminatedUnion('strategy', [
        z.object({ strategy: z.literal('compatible'), stateVersion: version }).strict(),
        z.object({ strategy: z.literal('migration-adapter'), stateVersion: version, adapter: z.literal('postgres-v1') }).strict(),
    ]),
}).strict().superRefine((manifest, ctx) => {
    const reject = (path: (string | number)[], code: string) =>
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: code });
    if (manifest.source.kind === 'github') {
        if (manifest.runtime.profile !== 'node24-computer-v1') reject(['runtime', 'profile'], 'source_runtime_mismatch');
        if (!manifest.build) reject(['build'], 'build_required');
    } else {
        if (manifest.runtime.profile !== 'oci-linux-amd64') reject(['runtime', 'profile'], 'source_runtime_mismatch');
        if (manifest.build) reject(['build'], 'build_not_allowed');
    }

    const indexes = new Map(manifest.services.map((item, index) => [item.name, index]));
    if (indexes.size !== manifest.services.length) reject(['services'], 'duplicate_service');
    manifest.services.forEach((item, index) => {
        if (manifest.source.kind === 'github' && item.process.kind === 'oci-entrypoint') {
            reject(['services', index, 'process'], 'source_process_mismatch');
        }
        if (manifest.source.kind === 'oci' && item.process.kind !== 'oci-entrypoint') {
            reject(['services', index, 'process'], 'source_process_mismatch');
        }
        if (item.process.kind === 'reticle-daemon-v1'
            && (manifest.source.kind !== 'github'
                || manifest.source.url !== 'https://github.com/reticlehq/reticle'
                || manifest.source.subdirectory !== undefined
                || manifest.launch.mode !== 'integration'
                || manifest.launch.service !== item.name)) {
            reject(['services', index, 'process'], 'unsupported_adapter_use');
        }
    });
    if (!indexes.has(manifest.launch.service)) reject(['launch', 'service'], 'unknown_service');
    if (manifest.launch.mode === 'web'
        && manifest.services[indexes.get(manifest.launch.service) ?? -1]?.scope !== 'installation') {
        reject(['launch', 'service'], 'web_service_must_be_installation_scoped');
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (serviceIndex: number): boolean => {
        const current = manifest.services[serviceIndex]!;
        if (visiting.has(current.name)) return true;
        if (visited.has(current.name)) return false;
        visiting.add(current.name);
        for (const [index, dependency] of current.dependsOn.entries()) {
            const depIndex = indexes.get(dependency);
            if (depIndex === undefined) reject(['services', serviceIndex, 'dependsOn', index], 'unknown_service');
            else {
                // A computer-wide process has no selected project with which
                // to start a project-scoped dependency. The reverse direction
                // is safe: a project service may use a computer-wide service.
                if (current.scope === 'installation' && manifest.services[depIndex]!.scope === 'selected-project') {
                    reject(['services', serviceIndex, 'dependsOn', index], 'dependency_scope_mismatch');
                }
                if (visit(depIndex)) reject(['services', serviceIndex, 'dependsOn', index], 'dependency_cycle');
            }
        }
        visiting.delete(current.name);
        visited.add(current.name);
        return false;
    };
    manifest.services.forEach((_item, index) => visit(index));

    const unique = <T>(items: T[], key: (item: T) => string, path: string) => {
        if (new Set(items.map(key)).size !== items.length) reject([path], 'duplicate_value');
    };
    unique(manifest.configuration, (item) => item.name, 'configuration');
    const secretNames = new Set(manifest.secrets.map(({ name }) => name));
    manifest.configuration.forEach(({ name }, index) => {
        if (secretNames.has(name)) reject(['configuration', index, 'name'], 'secret_configuration_collision');
    });
    if (manifest.persistence.mode === 'computer-volume') {
        unique(manifest.persistence.privateDirectories, (item) => item.name, 'persistence');
        unique(manifest.persistence.privateDirectories, (item) => item.containerPath, 'persistence');
        unique(manifest.persistence.sharedFolders, (item) => item.folder, 'persistence');
        unique(manifest.persistence.sharedFolders, (item) => item.containerPath, 'persistence');
    }
});

export type ComputerAppManifestV2 = z.infer<typeof ComputerAppManifestV2Schema>;
export type ComputerAppPilotProfile = 'node-web' | 'reticle-integration';

export function validateComputerAppManifest(input: unknown): ContractResult<ComputerAppManifestV2> {
    return parseContract(ComputerAppManifestV2Schema, input);
}

/** Syntax/profile screening only. Build, licensing, actual service readiness,
 * backup consistency and browser integration are separate release gates. */
export function checkComputerAppPilotCompatibility(manifest: ComputerAppManifestV2): ContractResult<ComputerAppPilotProfile> {
    const issues: ContractIssue[] = [];
    const reject = (path: (string | number)[], code: string) => issues.push({ path, code });
    if (manifest.source.kind === 'oci') reject(['source', 'kind'], 'unsupported_source');
    if (manifest.services.length > 4) reject(['services'], 'unsupported_service_count');
    if (manifest.resources.cpu > 1 || manifest.resources.memoryMiB > 4096
        || manifest.resources.ephemeralDiskMiB > 8192 || manifest.resources.maxRuntimeSeconds > 28_800) {
        reject(['resources'], 'unsupported_resources');
    }
    if (manifest.persistence.mode === 'computer-volume' && manifest.persistence.backup.mode !== 'daily-snapshot') {
        reject(['persistence', 'backup'], 'unsupported_backup');
    }
    if (manifest.update.strategy !== 'compatible') reject(['update', 'strategy'], 'unsupported_update');
    if (manifest.launch.mode === 'integration') {
        if (manifest.source.kind !== 'github'
            || manifest.source.url !== 'https://github.com/reticlehq/reticle'
            || manifest.source.subdirectory !== undefined
            || manifest.build?.recipe !== 'pnpm-workspace-v1'
            || manifest.build.workspace !== 'server') {
            reject(['launch', 'adapter'], 'unsupported_integration_source');
        }
        const launchedService = manifest.services.find(({ name }) => name === manifest.launch.service);
        if (launchedService?.scope !== 'selected-project' || launchedService.process.kind !== 'reticle-daemon-v1') {
            reject(['launch', 'service'], 'integration_requires_project_service');
        }
        if (manifest.persistence.mode !== 'computer-volume'
            || !manifest.persistence.sharedFolders.some(({ folder, access, scope }) =>
                folder === 'Projects' && access === 'read-write' && scope === 'selected-projects')) {
            reject(['persistence'], 'integration_requires_selected_projects');
        }
        if (!manifest.capabilities.includes('projects.read') || !manifest.capabilities.includes('projects.write')) {
            reject(['capabilities'], 'integration_requires_project_capabilities');
        }
    }
    return issues.length ? { success: false, issues } : {
        success: true, data: manifest.launch.mode === 'integration' ? 'reticle-integration' : 'node-web',
    };
}

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        const object = value as Record<string, unknown>;
        return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

export function getComputerManifestDigest(manifest: ComputerAppManifestV2): string {
    return `sha256:${createHash('sha256').update(canonicalJson(manifest)).digest('hex')}`;
}
