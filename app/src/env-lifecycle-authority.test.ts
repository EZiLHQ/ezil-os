import { afterEach, expect, it, vi } from 'vitest';
import { lifecycleDeployment } from '../tests/fixtures/lifecycle';
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.restoreAllMocks();vi.resetModules()});
async function load(flag?:string,secret?:string,deployments?:string) {
    vi.resetModules();vi.stubEnv('SUPABASE_DATABASE_URL','postgresql://localhost/test');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','http://127.0.0.1:54321');vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY','local-fixture');
    vi.stubEnv('EZIL_LIFECYCLE_AUTHORITY_ENABLED',flag);vi.stubEnv('EZIL_LIFECYCLE_AUTHORITY_SECRET',secret);vi.stubEnv('EZIL_LIFECYCLE_DEPLOYMENTS',deployments);
    return (await import('./env')).env;
}
it('defaults lifecycle checks off and keeps deployment and secret settings server-side',async()=>{
    const defaults=await load();expect(defaults.EZIL_LIFECYCLE_AUTHORITY_ENABLED).toBe('false');expect(defaults.EZIL_LIFECYCLE_DEPLOYMENTS).toEqual([]);
    const configured=await load('true','ab'.repeat(32),JSON.stringify([lifecycleDeployment]));expect(configured.EZIL_LIFECYCLE_DEPLOYMENTS).toEqual([lifecycleDeployment]);
    vi.stubGlobal('window',{});const client=await load('true','ab'.repeat(32),JSON.stringify([lifecycleDeployment]));
    expect(client.EZIL_LIFECYCLE_AUTHORITY_ENABLED).toBe('false');expect(client.EZIL_LIFECYCLE_AUTHORITY_SECRET).toBeUndefined();expect(client.EZIL_LIFECYCLE_DEPLOYMENTS).toEqual([]);
});
it('accepts operator shared pins with a deterministic per-writer profile',async()=>{
    const {instanceProfileArn:_profile,...deployment}=lifecycleDeployment;
    const approvals=[{profileMode:'per-writer',deployment}];
    expect((await load('true','ab'.repeat(32),JSON.stringify(approvals))).EZIL_LIFECYCLE_DEPLOYMENTS).toEqual(approvals);
    expect(_profile).toBeTruthy();
});
it('fails closed for missing authority, mutable references or malformed settings without printing their values',async()=>{
    const output=vi.spyOn(console,'error').mockImplementation(()=>{});
    for(const [flag,secret,deployments] of [['true',undefined,undefined],['true','sensitive-sentinel',undefined],
        ['sensitive-sentinel',undefined,undefined],['false',undefined,'sensitive-sentinel'],
        ['true','ab'.repeat(32),JSON.stringify([{...lifecycleDeployment,launchTemplateVersion:'$Latest',extra:'sensitive-sentinel'}])]]){
        await expect(load(flag,secret,deployments)).rejects.toThrow('Invalid server environment variables');
    }
    expect(JSON.stringify(output.mock.calls)).not.toContain('sensitive-sentinel');
});
