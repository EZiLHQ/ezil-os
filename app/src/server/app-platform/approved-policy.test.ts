import { describe, expect, it } from 'vitest';
import { ApprovedAppPolicyV1Schema, validatePolicyAgainstManifest } from './approved-policy';
import { AppManifestV1Schema, getManifestDigest } from './manifest';

const APP = '11111111-1111-4111-8111-111111111111';
const PUBLISHER = '22222222-2222-4222-8222-222222222222';
const SECRET = '33333333-3333-4333-8333-333333333333';
const OTHER_SECRET = '44444444-4444-4444-8444-444444444444';
const DIGEST = `sha256:${'a'.repeat(64)}`;

function node(overrides: Record<string, unknown> = {}) {
    return {
        schemaVersion: 1, appId: APP, publisherId: PUBLISHER, name: 'Notes', slug: 'notes', version: '1.0.0',
        source: { kind: 'github', url: 'https://github.com/partner/notes', commitSha: 'a'.repeat(40) },
        launch: { mode: 'web', path: '/', embedding: { mode: 'iframe', sandbox: ['allow-scripts', 'allow-forms', 'allow-same-origin'] } },
        runtime: { profile: 'node24-http-v1', entrypoint: 'dist/server.mjs', port: 8080, health: { path: '/health', status: 200 } },
        build: { recipe: 'npm-ci-v1', script: 'build' },
        capabilities: ['context.read', 'storage.objects'], secrets: [{ name: 'APP_TOKEN', ref: SECRET }],
        egressOrigins: ['https://api.partner.example.com'],
        resources: { cpu: 0.25, memoryMiB: 1024, diskMiB: 4096, maxRuntimeSeconds: 3600 },
        persistence: { mode: 'objects', maxBytes: 1_048_576 }, ...overrides,
    };
}

function policy(manifest: unknown = node()) {
    return {
        schemaVersion: 1, manifestDigest: getManifestDigest(AppManifestV1Schema.parse(manifest)),
        allowedOsOrigins: ['https://os.example.com'],
        embedding: { mode: 'iframe', sandbox: ['allow-scripts', 'allow-forms', 'allow-same-origin'] },
        capabilities: ['context.read', 'storage.objects'], secretBindings: [{ name: 'APP_TOKEN', ref: SECRET }],
        egressOrigins: ['https://api.partner.example.com'], persistence: { mode: 'objects', maxBytes: 1_048_576 },
        runtime: {
            profile: 'node24-http-v1', baseImage: `registry.example.com/ezil/node@${DIGEST}`, artifactDigest: DIGEST,
            resources: { profile: 'basic', maxRuntimeSeconds: 3600 }, lifecycle: { idleTimeoutSeconds: 600 },
            quotas: { instancesPerInstallation: 1, instancesPerUser: 2, instancesPerApp: 5 },
        },
    };
}

function hosted() {
    return node({
        source: { kind: 'hosted', url: 'https://notes.partner.example.com' }, runtime: { profile: 'external' },
        build: undefined, resources: undefined, capabilities: [], secrets: [], egressOrigins: [],
        persistence: { mode: 'publisher-managed' },
    });
}

function hostedPolicy() {
    return {
        ...policy(hosted()), runtime: { profile: 'external', origin: 'https://notes.partner.example.com' },
        capabilities: [], secretBindings: [], egressOrigins: [], persistence: { mode: 'publisher-managed' },
    };
}

function expectIssue(manifest: unknown, approval: unknown, path: (string | number)[], code?: string) {
    const result = validatePolicyAgainstManifest(manifest, approval);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path, ...(code ? { code } : {}) }),
    ]));
}

describe('maintainer-approved application policy v1', () => {
    it('validates hosted and Node contracts and returns parsed values', () => {
        expect(validatePolicyAgainstManifest(hosted(), hostedPolicy()).success).toBe(true);
        const result = validatePolicyAgainstManifest(node(), policy());
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.manifest.runtime).toMatchObject({ args: [] });
            expect(result.data.policy.embedding).toEqual({
                mode: 'iframe', sandbox: ['allow-scripts', 'allow-forms', 'allow-same-origin'],
            });
        }
    });

    it('allows narrower capabilities, egress, storage and runtime limits', () => {
        const approval = policy();
        approval.capabilities = ['storage.objects'];
        approval.egressOrigins = [];
        approval.persistence.maxBytes = 512;
        approval.runtime.resources.maxRuntimeSeconds = 1800;
        expect(validatePolicyAgainstManifest(node(), approval).success).toBe(true);
    });

    it.each([
        { appId: PUBLISHER }, { publisherId: APP }, { version: '1.0.1' },
        { source: { ...node().source, commitSha: 'b'.repeat(40) } },
        { source: { ...node().source, subdirectory: 'packages/app' } },
        { launch: { ...node().launch, path: '/admin' } },
        { runtime: { ...node().runtime, entrypoint: 'other.js' } },
        { runtime: { ...node().runtime, args: ['--unsafe'] } },
        { runtime: { ...node().runtime, health: { path: '/ready', status: 204 } } },
        { build: { recipe: 'npm-ci-v1' } },
    ])('does not reuse approval after manifest change %#', (change) => {
        expectIssue(node(change), policy(), ['policy', 'manifestDigest'], 'manifest_mismatch');
    });

    it('accepts equivalent normalized source input without changing the approval binding', () => {
        const manifest = node({ source: { ...node().source, url: 'https://GitHub.com/PARTNER/notes.git/', commitSha: 'A'.repeat(40) } });
        expect(validatePolicyAgainstManifest(manifest, policy()).success).toBe(true);
    });

    it.each([
        ['capabilities', ['window.close']], ['egressOrigins', ['https://other.example.com']],
    ])('rejects authority beyond the requested %s', (field, extra) => {
        const approval = policy();
        const requested = field === 'capabilities' ? approval.capabilities : approval.egressOrigins;
        expectIssue(node(), { ...approval, [field]: [...requested, ...extra] },
            ['policy', field, requested.length], 'authority_exceeds_request');
    });

    it('cannot widen iframe sandbox tokens or change the embedding mode', () => {
        expectIssue(node(), { ...policy(), embedding: {
            mode: 'iframe', sandbox: ['allow-scripts', 'allow-same-origin', 'allow-popups'],
        } }, ['policy', 'embedding', 'sandbox', 2], 'authority_exceeds_request');
        expectIssue(node(), { ...policy(), embedding: { mode: 'external' } }, ['policy', 'embedding', 'mode'], 'embedding_mismatch');
    });

    it('does not grant a bridge to an opaque iframe origin', () => {
        expectIssue(node(), { ...policy(), embedding: { mode: 'iframe', sandbox: ['allow-scripts'] } }, ['policy', 'embedding', 'sandbox']);
    });

    it('does not infer iframe permissions from omitted approval fields', () => {
        expectIssue(node(), { ...policy(), embedding: { mode: 'iframe' } }, ['policy', 'embedding', 'sandbox']);
    });

    it('requires the hosted origin to match and differ from every OS origin', () => {
        expectIssue(hosted(), { ...hostedPolicy(), runtime: { profile: 'external', origin: 'https://other.example.com' } },
            ['policy', 'runtime', 'origin'], 'origin_mismatch');
        expectIssue(hosted(), { ...hostedPolicy(), allowedOsOrigins: ['https://notes.partner.example.com/'] },
            ['policy', 'runtime', 'origin'], 'os_origin_collision');
    });

    it.each([
        { origins: [] }, { origins: ['https://os.example.com', 'https://OS.example.com/'] }, { origins: ['https://127.0.0.1'] },
    ])('rejects invalid OS origin sets %#', ({ origins }) => {
        expect(validatePolicyAgainstManifest(node(), { ...policy(), allowedOsOrigins: origins }).success).toBe(false);
    });

    it.each([
        ['changed ref', [{ name: 'APP_TOKEN', ref: OTHER_SECRET }]],
        ['changed name', [{ name: 'OTHER_TOKEN', ref: SECRET }]],
        ['missing binding', []], ['extra binding', [{ name: 'APP_TOKEN', ref: SECRET }, { name: 'OTHER_TOKEN', ref: SECRET }]],
    ])('requires exact secret references: %s', (_name, secretBindings) => {
        expect(validatePolicyAgainstManifest(node(), { ...policy(), secretBindings }).success).toBe(false);
    });

    it('does not allow hosted applications to request secret injection or runtime resources', () => {
        expectIssue(hosted(), { ...hostedPolicy(), secretBindings: [{ name: 'APP_TOKEN', ref: SECRET }] }, ['policy', 'secretBindings']);
        expectIssue(hosted(), { ...hostedPolicy(), runtime: { ...hostedPolicy().runtime, resources: {} } }, ['policy', 'runtime']);
    });

    it('requires matching runtime and persistence profiles', () => {
        expectIssue(node(), hostedPolicy(), ['policy', 'runtime', 'profile'], 'runtime_mismatch');
        expectIssue(node(), { ...policy(), capabilities: [], persistence: { mode: 'ephemeral' } },
            ['policy', 'persistence', 'mode'], 'persistence_mismatch');
        expectIssue(node(), { ...policy(), persistence: { mode: 'objects', maxBytes: 2_097_152 } },
            ['policy', 'persistence', 'maxBytes'], 'authority_exceeds_request');
    });

    it('allows an explicitly bound external database contract without proving database isolation', () => {
        const manifest = node({ capabilities: [], persistence: { mode: 'external-database', secretRef: SECRET } });
        const approval = { ...policy(manifest), capabilities: [], persistence: { mode: 'external-database', secretRef: SECRET } };
        expect(validatePolicyAgainstManifest(manifest, approval).success).toBe(true);
        expectIssue(manifest, { ...approval, persistence: { mode: 'external-database', secretRef: OTHER_SECRET } },
            ['policy', 'persistence', 'secretRef'], 'secret_binding_mismatch');
        expectIssue(manifest, { ...approval, secretBindings: [] }, ['policy', 'secretBindings'], 'missing_secret_binding');
    });

    it.each([
        ['baseImage', 'registry.example.com/ezil/node:latest'], ['artifactDigest', 'sha256:abc'],
    ])('requires immutable %s pins', (field, value) => {
        expectIssue(node(), { ...policy(), runtime: { ...policy().runtime, [field]: value } }, ['policy', 'runtime', field]);
    });

    it.each([
        { resources: { profile: 'standard-3', maxRuntimeSeconds: 3600 } },
        { resources: { profile: 'basic', maxRuntimeSeconds: 28_801 } },
        { quotas: { instancesPerInstallation: 2, instancesPerUser: 2, instancesPerApp: 5 } },
        { quotas: { instancesPerInstallation: 1, instancesPerUser: 3, instancesPerApp: 5 } },
        { quotas: { instancesPerInstallation: 1, instancesPerUser: 2, instancesPerApp: 6 } },
        { lifecycle: { idleTimeoutSeconds: 601 } },
    ])('enforces pilot ceilings %#', (limits) => {
        expect(validatePolicyAgainstManifest(node(), { ...policy(), runtime: { ...policy().runtime, ...limits } }).success).toBe(false);
    });

    it('cannot approve larger requirements or longer runtime than requested', () => {
        const larger = node({ resources: { ...node().resources, cpu: 0.5 } });
        expectIssue(larger, policy(larger), ['manifest', 'resources', 'cpu'], 'unsupported_resources');
        const shorter = node({ resources: { ...node().resources, maxRuntimeSeconds: 1800 } });
        expectIssue(shorter, policy(shorter), ['policy', 'runtime', 'resources', 'maxRuntimeSeconds'], 'authority_exceeds_request');
    });

    it('recognition of OCI and service submissions never creates a pilot approval', () => {
        const service = node({ launch: { mode: 'service' } });
        expectIssue(service, policy(service), ['manifest', 'launch', 'mode'], 'unsupported_launch');
        const oci = node({
            source: { kind: 'oci', image: `registry.example.com/partner/app@${DIGEST}` }, build: undefined,
            runtime: { profile: 'oci-linux-amd64', port: 8080, health: { path: '/', status: 200 } },
        });
        expectIssue(oci, policy(oci), ['manifest', 'source', 'kind'], 'unsupported_source');
    });

    it('rejects unknown versions and nested approval fields', () => {
        expect(ApprovedAppPolicyV1Schema.safeParse({ ...policy(), schemaVersion: 2 }).success).toBe(false);
        expectIssue(node(), { ...policy(), runtime: { ...policy().runtime, resources: { ...policy().runtime.resources, cpu: 4 } } },
            ['policy', 'runtime', 'resources']);
    });

    it('returns only paths and codes, without rejected values, secret text or unknown keys', () => {
        const secret = 'do-not-echo-this-private-key';
        const result = validatePolicyAgainstManifest({ ...node(), schemaVersion: secret }, {
            ...policy(), [secret]: secret, secretBindings: [{ name: secret, ref: secret, value: secret }],
        });
        expect(result.success).toBe(false);
        expect(JSON.stringify(result)).not.toContain(secret);
        if (!result.success) {
            expect(result.issues.some(({ path }) => path[0] === 'manifest')).toBe(true);
            expect(result.issues.some(({ path }) => path[0] === 'policy')).toBe(true);
            for (const issue of result.issues) expect(Object.keys(issue).sort()).toEqual(['code', 'path']);
        }
    });
});
