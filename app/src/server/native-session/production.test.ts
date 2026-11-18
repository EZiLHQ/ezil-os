import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acceptedDeploymentFixture } from './accepted-policy.test-support';
import { createProductionNativeAiPort, createProductionNativeHostTransport, createProductionNativeConsentReader } from './production';
import { productionNativeConsentDeps } from '@/server/native-auth/consent';
import { productionNativeRuntimeDeps } from './runtime-http';
const db = { execute: vi.fn(), transaction: vi.fn() } as never;
afterEach(() => { vi.unstubAllEnvs();vi.unstubAllGlobals(); });
const env = () => ({ ...acceptedDeploymentFixture().env, EZIL_NATIVE_HOST_TRANSPORT: '1',
    CLOUDFLARE_GUACAMOLE_WORKER_URL: 'https://worker.fixture.test', CLOUDFLARE_GUACAMOLE_HMAC_SECRET: 'fixture-hmac-only' });
describe('actual production native dependency graph', () => {
    it('blocks missing trusted deployment inputs without constructing authority or making network calls', async () => {
        const request = vi.fn();const host = createProductionNativeHostTransport({}, request);
        expect(host.available).toBe(false);expect(createProductionNativeAiPort(db, {})).toBeNull();
        expect(createProductionNativeConsentReader({})).toBeNull();expect(request).not.toHaveBeenCalled();
    });
    it('production consent and runtime factories construct real host transport, real task resolver and real AI port when pinned', () => {
        for (const [k, v] of Object.entries(env())) vi.stubEnv(k, v);
        const consent = productionNativeConsentDeps(db, vi.fn());const runtime = productionNativeRuntimeDeps(db, vi.fn());
        expect(consent.hostTransport.available).toBe(true);expect(consent.hostTransport.supportsKind('create')).toBe(true);
        expect(consent.taskResolver).not.toBeNull();expect(runtime.aiPort).not.toBeNull();expect(runtime.host.available).toBe(true);
        expect(createProductionNativeConsentReader(process.env)).not.toBeNull();expect(consent.hostTransport.supportsKind('renew')).toBe(false);
    });
    it('actual readiness factory refuses a mismatched installed manifest and accepts only its trusted pin', async () => {
        const pins = env();let manifest = 'b'.repeat(64);
        const request = vi.fn(async (url: unknown) => {
            const encoded = String(url).split('/native-readiness/')[1]!;
            const bytes = Buffer.from(encoded, 'base64url').toString('utf8');const q = JSON.parse(bytes) as { nonce: string; expiresAt: string };
            return Response.json({ ok: true, kind: 'ready', nonce: q.nonce, expiresAt: q.expiresAt,
                hostEpoch: 'a'.repeat(32), manifestSha256: manifest, targetDigest: createHash('sha256').update(bytes).digest('hex') });
        }) as unknown as typeof fetch;
        const host = createProductionNativeHostTransport(pins, request);
        const target = { kind: 'create' as const, profileId: 'ezil-native-claude-v1' as const,
            ownerUserId: '11111111-1111-4111-8111-111111111111', computerId: '22222222-2222-4222-8222-222222222222',
            placement: { generation: '1', leaseEpoch: '1', instanceId: 'i-0123456789abcdef0', fenceToken: '33333333-3333-4333-8333-333333333333' } };
        expect(await host.checkReadiness(target)).toEqual({ kind: 'unknown' });
        manifest = pins.EZIL_NATIVE_RUNTIME_MANIFEST_SHA256;expect(await host.checkReadiness(target)).toEqual({ kind: 'ready' });
    });
});
