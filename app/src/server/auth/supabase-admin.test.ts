import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const sdk = vi.hoisted(() => ({ createClient: vi.fn((_url: string, _key: string, _options?: Record<string, unknown>) => ({})) }));
vi.mock('@supabase/supabase-js', () => sdk);
import { createAdminClient } from './supabase-admin';
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('server-only Supabase admin', () => {
    it('uses the existing service role env name and never persists its session', () => {
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://supabase.example');
        vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role');
        createAdminClient();
        expect(sdk.createClient).toHaveBeenCalledWith('https://supabase.example', 'test-service-role', { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
    });
    it.each(['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'])('fails closed without %s', key => {
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://supabase.example');
        vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role');
        vi.stubEnv(key, '');
        expect(() => createAdminClient()).toThrow('session_failed');
        expect(sdk.createClient).not.toHaveBeenCalled();
    });
    it('bounds bootstrap provider calls while preserving caller cancellation and runtime fetch extensions', async () => {
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://supabase.example');
        vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role');
        const fetchMock = Object.assign(vi.fn().mockResolvedValue(Response.json({})), { preconnect: vi.fn() });
        vi.stubGlobal('fetch', fetchMock);
        createAdminClient({ timeoutMs: 5_000 });
        const options = sdk.createClient.mock.calls[0]![2] as { global: { fetch: typeof fetch & { preconnect: unknown } } };
        const abort = new AbortController();
        await options.global.fetch('https://supabase.example/auth/v1/admin/users', { signal: abort.signal });
        const signal = fetchMock.mock.calls[0]![1].signal as AbortSignal;
        expect(signal.aborted).toBe(false);
        abort.abort();
        expect(signal.aborted).toBe(true);
        expect(options.global.fetch.preconnect).toBe(fetchMock.preconnect);
    });
});
