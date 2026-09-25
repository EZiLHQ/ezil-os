import { z } from 'zod';
import {
    EgressOriginsSchema, EmbeddingSchema, HttpsOriginSchema, OciImageSchema, SecretReferencesSchema,
    Sha256DigestSchema, parseContract, uniqueArray,
} from './manifest';
import type { ContractIssue, ContractResult } from './manifest';
import {
    ComputerCapabilitiesSchema, checkComputerAppPilotCompatibility,
    getComputerManifestDigest, validateComputerAppManifest,
} from './computer-app-manifest';
import type { ComputerAppManifestV2 } from './computer-app-manifest';

const serviceName = z.string().max(48).regex(/^[a-z][a-z0-9-]*$/);
const approvedService = z.object({
    name: serviceName,
    scope: z.enum(['installation', 'selected-project']),
    processKind: z.enum(['node', 'reticle-daemon-v1', 'oci-entrypoint']),
    internalPort: z.number().int().min(1024).max(65535),
}).strict();
const approvedFolder = z.object({
    folder: z.enum(['Documents', 'Projects', 'Downloads']),
    access: z.enum(['read', 'read-write']),
    scope: z.enum(['whole-folder', 'selected-projects']),
}).strict().superRefine((folder, ctx) => {
    if (folder.scope === 'selected-projects' && folder.folder !== 'Projects') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scope'], message: 'invalid_scope' });
    }
});

/** An administrator-authored grant bound to one immutable manifest. Passing
 * this schema is not proof that its author is an administrator, owns an image,
 * may bind a secret, controls an origin, or has inspected the source. The API
 * must enforce those facts before storing or using the approval. */
export const ApprovedComputerAppPolicyV2Schema = z.object({
    schemaVersion: z.literal(2),
    manifestDigest: Sha256DigestSchema,
    image: z.object({ reference: OciImageSchema, provenanceDigest: Sha256DigestSchema }).strict(),
    allowedOsOrigins: z.array(HttpsOriginSchema).min(1).max(8)
        .refine((origins) => new Set(origins).size === origins.length),
    // Installation origins are derived as i-<installation UUID>.<base host>.
    appOriginBase: HttpsOriginSchema,
    launch: z.discriminatedUnion('mode', [
        z.object({ mode: z.literal('web'), embedding: EmbeddingSchema }).strict(),
        z.object({ mode: z.literal('integration'), adapter: z.literal('reticle-v1') }).strict(),
    ]),
    services: z.array(approvedService).min(1).max(8),
    capabilities: ComputerCapabilitiesSchema,
    secretBindings: SecretReferencesSchema,
    egressOrigins: EgressOriginsSchema,
    mounts: z.object({
        privateDirectories: uniqueArray(serviceName, 16),
        sharedFolders: z.array(approvedFolder).max(3).refine((folders) =>
            new Set(folders.map(({ folder }) => folder)).size === folders.length),
    }).strict(),
    resources: z.object({
        cpuLimit: z.number().finite().positive().max(1),
        memoryLimitMiB: z.number().int().min(128).max(4096),
        ephemeralDiskLimitMiB: z.number().int().positive().max(8192),
        maxRuntimeSeconds: z.number().int().positive().max(28_800),
    }).strict(),
    lifecycle: z.object({ idleTimeoutSeconds: z.number().int().positive().max(600) }).strict(),
    quotas: z.object({ runningAppsPerComputer: z.number().int().min(1).max(2) }).strict(),
    backup: z.discriminatedUnion('mode', [
        z.object({ mode: z.literal('none') }).strict(),
        z.object({ mode: z.literal('daily-snapshot'), retentionDays: z.literal(7) }).strict(),
        z.object({ mode: z.literal('database-adapter'), adapter: z.literal('postgres-v1') }).strict(),
    ]),
}).strict().superRefine((policy, ctx) => {
    const appHost = new URL(policy.appOriginBase).hostname;
    // An installation label is "i-" plus a 36-character UUID and a dot.
    // A syntactically valid base can still exceed DNS's 253-byte hostname
    // limit after that label is prepended.
    if (appHost.length > 253 - 39) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['appOriginBase'], message: 'derived_origin_too_long' });
    }
    if (policy.allowedOsOrigins.some((origin) => {
        const osHost = new URL(origin).hostname;
        return osHost === appHost || osHost.endsWith(`.${appHost}`);
    })) {
        // Every installation's browser origin lives below this base host.
        // None of those origins may gain the OS origin's bridge authority.
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['appOriginBase'], message: 'origin_collision' });
    }
    if (new Set(policy.services.map(({ name }) => name)).size !== policy.services.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['services'], message: 'duplicate_service' });
    }
    if (policy.capabilities.includes('projects.write') && !policy.capabilities.includes('projects.read')) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['capabilities'], message: 'missing_read_capability' });
    }
});

export type ApprovedComputerAppPolicyV2 = z.infer<typeof ApprovedComputerAppPolicyV2Schema>;
export type ValidatedComputerAppContracts = {
    manifest: ComputerAppManifestV2;
    policy: ApprovedComputerAppPolicyV2;
};

/** Cross-check authority against publisher requests. Host paths, EC2/volume
 * identities, host-port leases, and tunnel credentials remain server-generated
 * runtime records, never values accepted from either contract. */
export function validateComputerPolicyAgainstManifest(
    manifestInput: unknown,
    policyInput: unknown,
): ContractResult<ValidatedComputerAppContracts> {
    const manifestResult = validateComputerAppManifest(manifestInput);
    const policyResult = parseContract(ApprovedComputerAppPolicyV2Schema, policyInput);
    const issues: ContractIssue[] = [];
    const append = (prefix: string, incoming: ContractIssue[]) => {
        issues.push(...incoming.map(({ path, code }) => ({ path: [prefix, ...path], code })));
    };
    if (!manifestResult.success) append('manifest', manifestResult.issues);
    if (!policyResult.success) append('policy', policyResult.issues);
    if (!manifestResult.success || !policyResult.success) return { success: false, issues };

    const manifest = manifestResult.data;
    const policy = policyResult.data;
    const reject = (path: (string | number)[], code: string) => issues.push({ path: ['policy', ...path], code });
    const subset = (approved: string[], requested: string[], path: string[]) => approved.forEach((item, index) => {
        if (!requested.includes(item)) reject([...path, index], 'authority_exceeds_request');
    });

    const compatibility = checkComputerAppPilotCompatibility(manifest);
    if (!compatibility.success) append('manifest', compatibility.issues);
    if (policy.manifestDigest !== getComputerManifestDigest(manifest)) reject(['manifestDigest'], 'manifest_mismatch');
    if (manifest.source.kind === 'oci' && policy.image.reference !== manifest.source.image) {
        reject(['image', 'reference'], 'source_image_mismatch');
    }
    if (policy.launch.mode !== manifest.launch.mode) {
        reject(['launch', 'mode'], 'launch_mode_mismatch');
    } else if (policy.launch.mode === 'web' && manifest.launch.mode === 'web') {
        if (policy.launch.embedding.mode !== manifest.launch.embedding.mode) {
            reject(['launch', 'embedding', 'mode'], 'embedding_mode_mismatch');
        } else if (policy.launch.embedding.mode === 'iframe' && manifest.launch.embedding.mode === 'iframe') {
            subset(policy.launch.embedding.sandbox, manifest.launch.embedding.sandbox, ['launch', 'embedding', 'sandbox']);
            if (policy.capabilities.length && !policy.launch.embedding.sandbox.includes('allow-same-origin')) {
                reject(['launch', 'embedding', 'sandbox'], 'capabilities_require_same_origin');
            }
            if (policy.capabilities.length && !manifest.launch.embedding.sandbox.includes('allow-same-origin')) {
                issues.push({ path: ['manifest', 'launch', 'embedding', 'sandbox'], code: 'capabilities_require_same_origin' });
            }
        }
        if (policy.launch.embedding.mode === 'external' && policy.capabilities.length) {
            reject(['capabilities'], 'external_window_has_no_bridge');
        }
    }

    subset(policy.capabilities, manifest.capabilities, ['capabilities']);
    subset(policy.egressOrigins, manifest.egressOrigins, ['egressOrigins']);
    for (const [index, service] of policy.services.entries()) {
        if (!manifest.services.some((requested) => requested.name === service.name
            && requested.internalPort === service.internalPort && requested.scope === service.scope
            && requested.process.kind === service.processKind)) {
            reject(['services', index], 'service_mismatch');
        }
    }
    if (policy.services.length !== manifest.services.length) reject(['services'], 'missing_service');

    for (const [index, binding] of policy.secretBindings.entries()) {
        if (!manifest.secrets.some(({ name, ref }) => name === binding.name && ref === binding.ref)) {
            reject(['secretBindings', index], 'secret_binding_mismatch');
        }
    }
    if (policy.secretBindings.length !== manifest.secrets.length) reject(['secretBindings'], 'missing_secret_binding');

    if (manifest.persistence.mode === 'ephemeral') {
        if (policy.mounts.privateDirectories.length || policy.mounts.sharedFolders.length) reject(['mounts'], 'unexpected_mount');
        if (policy.backup.mode !== 'none') reject(['backup'], 'backup_mismatch');
    } else {
        const requestedPrivate = manifest.persistence.privateDirectories.map(({ name }) => name);
        if (policy.mounts.privateDirectories.length !== requestedPrivate.length
            || policy.mounts.privateDirectories.some((item) => !requestedPrivate.includes(item))) {
            reject(['mounts', 'privateDirectories'], 'private_mount_mismatch');
        }
        for (const [index, approved] of policy.mounts.sharedFolders.entries()) {
            const request = manifest.persistence.sharedFolders.find(({ folder }) => folder === approved.folder);
            if (!request || (approved.access === 'read-write' && request.access === 'read')
                || (approved.scope === 'whole-folder' && request.scope === 'selected-projects')) {
                reject(['mounts', 'sharedFolders', index], 'folder_authority_exceeds_request');
            }
        }
        if (policy.backup.mode !== manifest.persistence.backup.mode) reject(['backup'], 'backup_mismatch');
    }
    if (manifest.launch.mode === 'integration') {
        if (!policy.capabilities.includes('projects.read') || !policy.capabilities.includes('projects.write')) {
            reject(['capabilities'], 'integration_requires_approved_project_capabilities');
        }
        if (!policy.mounts.sharedFolders.some(({ folder, access, scope }) =>
            folder === 'Projects' && access === 'read-write' && scope === 'selected-projects')) {
            reject(['mounts', 'sharedFolders'], 'integration_requires_approved_projects');
        }
    }

    if (policy.resources.cpuLimit < manifest.resources.cpu
        || policy.resources.memoryLimitMiB < manifest.resources.memoryMiB
        || policy.resources.ephemeralDiskLimitMiB < manifest.resources.ephemeralDiskMiB) {
        reject(['resources'], 'requirements_not_met');
    }
    if (policy.resources.maxRuntimeSeconds > manifest.resources.maxRuntimeSeconds) {
        reject(['resources', 'maxRuntimeSeconds'], 'authority_exceeds_request');
    }

    return issues.length ? { success: false, issues } : { success: true, data: { manifest, policy } };
}
