import { afterEach, expect, it, vi } from 'vitest';
import { lifecycleDeployment as deployment } from '../tests/fixtures/lifecycle';

const key = 'ab'.repeat(32), policy = { accountId: deployment.accountId, region: deployment.region, namespace: deployment.namespace,
    controlDomain: 'control.example.com', kmsKeyArn: deployment.dataKeyArn };
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); });
async function load(flag?: string, secret?: string, configured?: string, deployments?: string) {
    vi.resetModules(); vi.stubEnv('SUPABASE_DATABASE_URL', 'postgresql://localhost/test');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321'); vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'local-fixture');
    vi.stubEnv('EZIL_START_AUTHORITY_ENABLED', flag); vi.stubEnv('EZIL_START_AUTHORITY_SECRET', secret);
    vi.stubEnv('EZIL_START_CONTROL_KEY_POLICY', configured); vi.stubEnv('EZIL_LIFECYCLE_DEPLOYMENTS', deployments);
    return (await import('./env')).env;
}
it('defaults off and excludes startup keys and policy from client exports', async () => {
    const defaults = await load(); expect(defaults.EZIL_START_AUTHORITY_ENABLED).toBe('false');
    expect(defaults.EZIL_START_AUTHORITY_SECRET).toBeUndefined(); expect(defaults.EZIL_START_CONTROL_KEY_POLICY).toBeNull();
    const configured = await load('true', key, JSON.stringify(policy), JSON.stringify([deployment]));
    expect(configured.EZIL_START_AUTHORITY_ENABLED).toBe('true'); expect(configured.EZIL_START_CONTROL_KEY_POLICY).toEqual(policy);
    vi.stubGlobal('window', {}); const client = await load('true', key, JSON.stringify(policy), JSON.stringify([deployment]));
    expect(client.EZIL_START_AUTHORITY_ENABLED).toBe('false'); expect(client.EZIL_START_AUTHORITY_SECRET).toBeUndefined();
    expect(client.EZIL_START_CONTROL_KEY_POLICY).toBeNull();
});
it('rejects missing settings, malformed values and mismatched deployment without exposing them', async () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const args of [['true'], ['PRIVATE_VALUE'], ['true', 'PRIVATE_VALUE'], ['true', key],
        ['true', key, 'PRIVATE_VALUE'], ['true', key, JSON.stringify({ ...policy, credential: 'PRIVATE_VALUE' })],
        ['true', key, JSON.stringify(policy), '[]'], ['true', key, JSON.stringify({ ...policy, namespace: 'other' }), JSON.stringify([deployment])]]) {
        const [flag, secret, configured, deployments] = args;
        await expect(load(flag, secret, configured, deployments)).rejects.toThrow('Invalid server environment variables');
    }
    expect(JSON.stringify(output.mock.calls)).not.toContain('PRIVATE_VALUE'); expect(JSON.stringify(output.mock.calls)).not.toContain(key);
});
it('requires a separate startup signing key from other internal workflow keys', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const name of ['EZIL_LIFECYCLE_AUTHORITY_SECRET', 'EZIL_CONFIGURATION_AUTHORITY_SECRET', 'EZIL_MOUNT_AUTHORITY_SECRET']) {
        vi.stubEnv(name, key);
        await expect(load('true', key, JSON.stringify(policy), JSON.stringify([deployment]))).rejects.toThrow('Invalid server environment variables');
        vi.stubEnv(name, undefined);
    }
});
it('accepts approved per-writer deployment policy', async () => {
    const shared = Object.fromEntries(Object.entries(deployment).filter(([key]) => key !== 'instanceProfileArn'));
    const configured = await load('true', key, JSON.stringify(policy), JSON.stringify([{ profileMode: 'per-writer', deployment: shared }]));
    expect(configured.EZIL_START_AUTHORITY_ENABLED).toBe('true');
});
