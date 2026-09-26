import { afterEach, expect, it, vi } from 'vitest';
import { lifecycleDeployment } from '../tests/fixtures/lifecycle';
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.restoreAllMocks();vi.resetModules()});
async function load(flag?:string,secret?:string,deployments?:string) {
    vi.resetModules();vi.stubEnv('SUPABASE_DATABASE_URL','postgresql://localhost/test');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','http://127.0.0.1:54321');vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY','local-fixture');
    vi.stubEnv('EZIL_MOUNT_AUTHORITY_ENABLED',flag);vi.stubEnv('EZIL_MOUNT_AUTHORITY_SECRET',secret);vi.stubEnv('EZIL_LIFECYCLE_DEPLOYMENTS',deployments);
    return (await import('./env')).env;
}
it('defaults mount checks off and never exports the key to the browser',async()=>{
    const defaults=await load();expect(defaults.EZIL_MOUNT_AUTHORITY_ENABLED).toBe('false');expect(defaults.EZIL_MOUNT_AUTHORITY_SECRET).toBeUndefined();
    const configured=await load('true','ab'.repeat(32),JSON.stringify([lifecycleDeployment]));expect(configured.EZIL_MOUNT_AUTHORITY_ENABLED).toBe('true');
    vi.stubGlobal('window',{});const client=await load('true','ab'.repeat(32),JSON.stringify([lifecycleDeployment]));
    expect(client.EZIL_MOUNT_AUTHORITY_ENABLED).toBe('false');expect(client.EZIL_MOUNT_AUTHORITY_SECRET).toBeUndefined();
});
it('fails closed for missing keys/deployments and redacts malformed values',async()=>{
    const output=vi.spyOn(console,'error').mockImplementation(()=>{});
    for(const [flag,secret,deployments] of [['true',undefined,undefined],['true','PRIVATE_VALUE',undefined],
        ['PRIVATE_VALUE',undefined,undefined],['true','ab'.repeat(32),'[]']]){
        await expect(load(flag,secret,deployments)).rejects.toThrow('Invalid server environment variables');
    }
    expect(JSON.stringify(output.mock.calls)).not.toContain('PRIVATE_VALUE');
});
it('requires a separate mount key from lifecycle/configuration workflow keys',async()=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});
    for(const name of ['EZIL_LIFECYCLE_AUTHORITY_SECRET','EZIL_CONFIGURATION_AUTHORITY_SECRET']) {
        vi.stubEnv(name,'ab'.repeat(32));
        await expect(load('true','ab'.repeat(32),JSON.stringify([lifecycleDeployment]))).rejects.toThrow('Invalid server environment variables');
        vi.stubEnv(name,undefined);
    }
});
