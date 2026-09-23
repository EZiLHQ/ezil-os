import { z } from 'zod';
import {
    CapabilitiesSchema, EgressOriginsSchema, EmbeddingSchema, HttpsOriginSchema,
    OciImageSchema, PersistenceSchema, PILOT_LIMITS, SecretReferencesSchema, Sha256DigestSchema,
    checkPilotCompatibility, getManifestDigest, parseContract, uniqueArray, validateAppManifest,
} from './manifest';
import type { AppManifestV1, ContractIssue, ContractResult } from './manifest';

/** Maintainer-authored approval data, separate from publisher requests.
 * Parsing this record does NOT establish administrator authority, ownership,
 * secret access, OS origin ownership, image provenance, or network safety. The future control plane
 * must authenticate/authorize its author and persist the approval separately.
 * No publisher-supplied policy becomes authoritative by passing this schema. */
export const ApprovedAppPolicyV1Schema = z.object({
    schemaVersion: z.literal(1),
    manifestDigest: Sha256DigestSchema,
    allowedOsOrigins: uniqueArray(HttpsOriginSchema, 8).refine((origins) => origins.length > 0),
    embedding: EmbeddingSchema,
    capabilities: CapabilitiesSchema,
    secretBindings: SecretReferencesSchema,
    egressOrigins: EgressOriginsSchema,
    persistence: PersistenceSchema,
    runtime: z.discriminatedUnion('profile', [
        z.object({ profile: z.literal('external'), origin: HttpsOriginSchema }).strict(),
        z.object({
            profile: z.literal('node24-http-v1'),
            // Deployment validation must resolve this against the operator's
            // allowed base images and bind the artifact to a trusted build.
            baseImage: OciImageSchema,
            artifactDigest: Sha256DigestSchema,
            resources: z.object({
                // Allocation is fixed; publishers cannot turn a failed build
                // or a larger requirement into a machine upgrade.
                profile: z.literal('basic'),
                maxRuntimeSeconds: z.number().int().positive().max(PILOT_LIMITS.maxRuntimeSeconds),
            }).strict(),
            lifecycle: z.object({
                idleTimeoutSeconds: z.number().int().positive().max(PILOT_LIMITS.idleTimeoutSeconds),
            }).strict(),
            quotas: z.object({
                instancesPerInstallation: z.literal(1),
                instancesPerUser: z.number().int().positive().max(PILOT_LIMITS.instancesPerUser),
                instancesPerApp: z.number().int().positive().max(PILOT_LIMITS.instancesPerApp),
            }).strict(),
        }).strict(),
    ]),
}).strict().superRefine((policy, ctx) => {
    const reject = (path: string[]) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: 'incompatible_fields' });
    if (policy.runtime.profile === 'external') {
        if (policy.secretBindings.length) reject(['secretBindings']);
        if (policy.egressOrigins.length) reject(['egressOrigins']);
        if (policy.persistence.mode !== 'publisher-managed') reject(['persistence']);
    } else {
        if (policy.persistence.mode === 'publisher-managed') reject(['persistence']);
        if (policy.runtime.lifecycle.idleTimeoutSeconds > policy.runtime.resources.maxRuntimeSeconds) reject(['runtime', 'lifecycle']);
    }
    if (policy.capabilities.includes('storage.objects') !== (policy.persistence.mode === 'objects')) reject(['capabilities']);
    if (policy.persistence.mode === 'objects' && policy.persistence.maxBytes > PILOT_LIMITS.objectBytes) reject(['persistence', 'maxBytes']);
    if (policy.embedding.mode === 'iframe' && policy.capabilities.length
        && !policy.embedding.sandbox.includes('allow-same-origin')) reject(['embedding', 'sandbox']);
});

export type ApprovedAppPolicyV1 = z.infer<typeof ApprovedAppPolicyV1Schema>;
export type ValidatedAppContracts = { manifest: AppManifestV1; policy: ApprovedAppPolicyV1 };

/** Pure contract/pilot validation only. Successful validation is neither an
 * administrator grant nor permission to fetch, build, deploy, or launch.
 * Callers must use these parsed values, not the original untrusted inputs. */
export function validatePolicyAgainstManifest(
    manifestInput: unknown,
    policyInput: unknown,
): ContractResult<ValidatedAppContracts> {
    const manifestResult = validateAppManifest(manifestInput);
    const policyResult = parseContract(ApprovedAppPolicyV1Schema, policyInput);
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
    const subset = (approved: string[], requested: string[], path: string[]) => approved.forEach((value, index) => {
        if (!requested.includes(value)) reject([...path, index], 'authority_exceeds_request');
    });

    const compatibility = checkPilotCompatibility(manifest);
    if (!compatibility.success) append('manifest', compatibility.issues);
    if (policy.manifestDigest !== getManifestDigest(manifest)) reject(['manifestDigest'], 'manifest_mismatch');
    if (policy.runtime.profile !== manifest.runtime.profile) reject(['runtime', 'profile'], 'runtime_mismatch');
    subset(policy.capabilities, manifest.capabilities, ['capabilities']);
    subset(policy.egressOrigins, manifest.egressOrigins, ['egressOrigins']);

    if (manifest.launch.mode === 'web') {
        if (policy.embedding.mode !== manifest.launch.embedding.mode) reject(['embedding', 'mode'], 'embedding_mismatch');
        if (policy.embedding.mode === 'iframe' && manifest.launch.embedding.mode === 'iframe') {
            subset(policy.embedding.sandbox, manifest.launch.embedding.sandbox, ['embedding', 'sandbox']);
        }
    }
    if (policy.runtime.profile === 'external' && manifest.source.kind === 'hosted') {
        if (policy.runtime.origin !== manifest.source.url) reject(['runtime', 'origin'], 'origin_mismatch');
        if (policy.allowedOsOrigins.includes(policy.runtime.origin)) reject(['runtime', 'origin'], 'os_origin_collision');
    }
    if (policy.runtime.profile === 'node24-http-v1' && manifest.resources
        && policy.runtime.resources.maxRuntimeSeconds > manifest.resources.maxRuntimeSeconds) {
        reject(['runtime', 'resources', 'maxRuntimeSeconds'], 'authority_exceeds_request');
    }

    // Every declared secret is required. Bindings may neither add names nor
    // replace references. Whether the author can use a reference is an
    // independent server-side ownership check, not an inference from a UUID.
    policy.secretBindings.forEach((binding, index) => {
        if (!manifest.secrets.some(({ name, ref }) => name === binding.name && ref === binding.ref)) {
            reject(['secretBindings', index], 'secret_binding_mismatch');
        }
    });
    if (manifest.secrets.some(({ name, ref }) => !policy.secretBindings.some((binding) => binding.name === name && binding.ref === ref))) {
        reject(['secretBindings'], 'missing_secret_binding');
    }

    if (policy.persistence.mode !== manifest.persistence.mode) reject(['persistence', 'mode'], 'persistence_mismatch');
    if (policy.persistence.mode === 'objects' && manifest.persistence.mode === 'objects'
        && policy.persistence.maxBytes > manifest.persistence.maxBytes) reject(['persistence', 'maxBytes'], 'authority_exceeds_request');
    if (policy.persistence.mode === 'external-database' && manifest.persistence.mode === 'external-database'
        && policy.persistence.secretRef !== manifest.persistence.secretRef) reject(['persistence', 'secretRef'], 'secret_binding_mismatch');

    return issues.length ? { success: false, issues } : { success: true, data: { manifest, policy } };
}
