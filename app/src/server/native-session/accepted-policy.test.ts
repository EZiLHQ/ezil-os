import { acceptedDeploymentFixture as fixture } from './accepted-policy.test-support';
import { describe, expect, it } from 'vitest';
import { loadAcceptedNativeDeployment, nativePolicyCanonical as canonical, nativeDeploymentSha256 as sha,
    NATIVE_ACCEPTED_PROFILE as profile } from './accepted-policy';
const policyId = '11111111-1111-4111-8111-111111111111';
describe('trusted native deployment policy producer', () => {
    it('pairs the descriptor and consent audience with the exact configured OS origin', () => {
        const main = fixture(undefined, 'https://os.ezil.work');
        const stage = fixture();
        expect(loadAcceptedNativeDeployment(main.env)).toMatchObject({ state: 'ready', deployment: { gatewayOrigin: 'https://ai.ezil.work' } });
        expect(loadAcceptedNativeDeployment({ ...stage.env, EZIL_NATIVE_SESSIONS_ORIGIN: 'https://os.ezil.work',
            EZIL_NATIVE_AUTHORIZATION_AUDIENCE: 'https://ai.ezil.work' })).toMatchObject({ state: 'blocked' });
        expect(loadAcceptedNativeDeployment({ ...main.env, EZIL_NATIVE_AUTHORIZATION_AUDIENCE: 'https://ai-staging.ezil.work' }))
            .toMatchObject({ state: 'blocked' });
        expect(loadAcceptedNativeDeployment({ ...main.env, EZIL_NATIVE_SESSIONS_ORIGIN: 'https://foreign.example.test' }))
            .toMatchObject({ state: 'blocked' });
    });

    it('defaults off and blocks partial pins without any descriptor or runtime TOFU', () => {
        expect(loadAcceptedNativeDeployment({})).toEqual({ state: 'off' });
        expect(loadAcceptedNativeDeployment({ EZIL_NATIVE_RUNTIME_MANIFEST_SHA256: 'a'.repeat(64) })).toMatchObject({ state: 'blocked' });
    });
    it('derives Core policy digest from canonical reviewed policy bytes, distinct from Host profile hash', () => {
        const f = fixture(), result = loadAcceptedNativeDeployment(f.env);
        expect(result).toMatchObject({ state: 'ready', deployment: { policyId, profileId: profile.profileId, corePolicyDigest: sha(f.policy) } });
        if (result.state === 'ready') expect(result.deployment.hostPolicyDigest).toBe('sha256:669f2e04be8d8183727f1e750f4b9fe1bad3bd1b991babbbd549debc5a305e3e');
    });
    it('rejects changed artifact, policy UUID, descriptor bytes or descriptor pin', () => {
        for (const patch of [{ EZIL_NATIVE_RUNTIME_MANIFEST_SHA256: 'b'.repeat(64) }, { EZIL_NATIVE_AUTHORIZATION_POLICY_ID: '22222222-2222-4222-8222-222222222222' },
            { EZIL_NATIVE_DEPLOYMENT_DESCRIPTOR: fixture().env.EZIL_NATIVE_DEPLOYMENT_DESCRIPTOR + ' ' }, { EZIL_NATIVE_DEPLOYMENT_DESCRIPTOR_SHA256: 'c'.repeat(64) }]) {
            expect(loadAcceptedNativeDeployment({ ...fixture().env, ...patch })).toMatchObject({ state: 'blocked' });
        }
    });
    it('blocks profile/tool/limit/origin drift even when a new deployment hash is supplied', () => {
        for (const field of ['hostProfileBytes', 'corePolicyBytes'] as const) {
            const f = fixture();const value = JSON.parse(f.descriptor[field]) as Record<string, unknown>;value.tools = ['Read'];
            const raw = JSON.stringify({ ...f.descriptor, [field]: canonical(value) });
            expect(loadAcceptedNativeDeployment({ ...f.env, EZIL_NATIVE_DEPLOYMENT_DESCRIPTOR: raw, EZIL_NATIVE_DEPLOYMENT_DESCRIPTOR_SHA256: sha(raw) })).toMatchObject({ state: 'blocked' });
        }
    });
    it('refuses noncanonical policy bytes, unknown fields, and an unlisted CLI artifact', () => {
        for (const patch of [{ corePolicyBytes: JSON.stringify(JSON.parse(fixture().policy), null, 2) }, { untrusted: true }]) {
            const f = fixture(), raw = JSON.stringify({ ...f.descriptor, ...patch });
            expect(loadAcceptedNativeDeployment({ ...f.env, EZIL_NATIVE_DEPLOYMENT_DESCRIPTOR: raw, EZIL_NATIVE_DEPLOYMENT_DESCRIPTOR_SHA256: sha(raw) })).toMatchObject({ state: 'blocked' });
        }
        const f = fixture(), a = JSON.parse(f.descriptor.artifactManifestBytes) as { entrypoints: { cli: string } };a.entrypoints.cli = 'missing';
        const artifact = canonical(a), raw = JSON.stringify({ ...f.descriptor, artifactManifestBytes: artifact });
        expect(loadAcceptedNativeDeployment({ ...f.env, EZIL_NATIVE_DEPLOYMENT_DESCRIPTOR: raw, EZIL_NATIVE_DEPLOYMENT_DESCRIPTOR_SHA256: sha(raw), EZIL_NATIVE_RUNTIME_MANIFEST_SHA256: sha(artifact) })).toMatchObject({ state: 'blocked' });
    });
    it('blocks missing Host TLS trust rather than admitting a null compiled-policy pin', () => {
        const f = fixture();const policy = JSON.parse(f.policy) as Record<string, unknown>;policy.caPem = null;policy.spkiSha256 = null;
        const raw = JSON.stringify({ ...f.descriptor, corePolicyBytes: canonical(policy) });
        expect(loadAcceptedNativeDeployment({ ...f.env, EZIL_NATIVE_DEPLOYMENT_DESCRIPTOR: raw,
            EZIL_NATIVE_DEPLOYMENT_DESCRIPTOR_SHA256: sha(raw) })).toMatchObject({ state: 'blocked' });
    });

    it('requires the explicitly reviewed policy revision in both descriptor and Host profile bytes', () => {
        for (const revision of [undefined, 'unreviewed-revision']) {
            const f = fixture(), raw = JSON.stringify({ ...f.descriptor, policyRevision: revision });
            expect(loadAcceptedNativeDeployment({ ...f.env, EZIL_NATIVE_DEPLOYMENT_DESCRIPTOR: raw,
                EZIL_NATIVE_DEPLOYMENT_DESCRIPTOR_SHA256: sha(raw) })).toMatchObject({ state: 'blocked' });
        }
        const f = fixture(), h = JSON.parse(f.descriptor.hostProfileBytes) as Record<string, unknown>;delete h.policyRevision;
        const raw = JSON.stringify({ ...f.descriptor, hostProfileBytes: canonical(h) });
        expect(loadAcceptedNativeDeployment({ ...f.env, EZIL_NATIVE_DEPLOYMENT_DESCRIPTOR: raw,
            EZIL_NATIVE_DEPLOYMENT_DESCRIPTOR_SHA256: sha(raw) })).toMatchObject({ state: 'blocked' });
    });

});
