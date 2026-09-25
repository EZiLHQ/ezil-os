import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); });
async function load(flag?: string, secret?: string) {
    vi.resetModules();
    vi.stubEnv('SUPABASE_DATABASE_URL', 'postgresql://localhost/test');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'local-fixture');
    vi.stubEnv('EZIL_CONFIGURATION_AUTHORITY_ENABLED', flag);
    vi.stubEnv('EZIL_CONFIGURATION_AUTHORITY_SECRET', secret);
    return (await import('./env')).env;
}
it('defaults workflow checks off and keeps the key server-only', async () => {
    expect((await load()).EZIL_CONFIGURATION_AUTHORITY_ENABLED).toBe('false');
    expect((await load('true', 'ab'.repeat(32))).EZIL_CONFIGURATION_AUTHORITY_ENABLED).toBe('true');
    vi.stubGlobal('window', {});
    const client = await load('true', 'ab'.repeat(32));
    expect(client.EZIL_CONFIGURATION_AUTHORITY_ENABLED).toBe('false');
    expect(client.EZIL_CONFIGURATION_AUTHORITY_SECRET).toBeUndefined();
});
it('fails boot on missing or malformed configuration using names, never values', async () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const [flag, key] of [['true', undefined], ['true', 'sensitive-key-sentinel'], ['sensitive-flag-sentinel', undefined]]) {
        await expect(load(flag, key)).rejects.toThrow('Invalid server environment variables');
    }
    const text = JSON.stringify(output.mock.calls);
    expect(text).toContain('EZIL_CONFIGURATION_AUTHORITY_SECRET');
    expect(text).toContain('EZIL_CONFIGURATION_AUTHORITY_ENABLED');
    expect(text).not.toContain('sensitive-key-sentinel'); expect(text).not.toContain('sensitive-flag-sentinel');
});
