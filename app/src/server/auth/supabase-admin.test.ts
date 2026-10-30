import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const sdk = vi.hoisted(() => ({ createClient: vi.fn(() => ({})) }));
vi.mock('@supabase/supabase-js', () => sdk);
import { createAdminClient } from './supabase-admin';
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

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
});
