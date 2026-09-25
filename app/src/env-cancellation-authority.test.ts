import { afterEach,expect,it,vi } from 'vitest';
import { lifecycleDeployment } from '../tests/fixtures/lifecycle';
const workflows={ [lifecycleDeployment.stateMachineVersionArn]:'arn:aws:states:us-east-1:123456789012:stateMachine:ezil-cancel:1' };
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.restoreAllMocks();vi.resetModules()});
async function load(flag?:string,secret?:string,map?:string,deployments?:string){
    vi.resetModules();vi.stubEnv('SUPABASE_DATABASE_URL','postgresql://localhost/test');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','http://127.0.0.1:54321');vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY','local-fixture');
    vi.stubEnv('EZIL_CANCELLATION_AUTHORITY_ENABLED',flag);vi.stubEnv('EZIL_CANCELLATION_AUTHORITY_SECRET',secret);
    vi.stubEnv('EZIL_CANCELLATION_WORKFLOWS',map);vi.stubEnv('EZIL_LIFECYCLE_DEPLOYMENTS',deployments);
    return (await import('./env')).env;
}
it('defaults off, stays server-only, and supports cleanup while launch authority is disabled',async()=>{
    const defaults=await load();expect(defaults.EZIL_CANCELLATION_AUTHORITY_ENABLED).toBe('false');expect(defaults.EZIL_CANCELLATION_WORKFLOWS).toEqual({});
    const configured=await load('true','cd'.repeat(32),JSON.stringify(workflows),JSON.stringify([lifecycleDeployment]));
    expect(configured.EZIL_CANCELLATION_WORKFLOWS).toEqual(workflows);expect(configured.EZIL_LIFECYCLE_AUTHORITY_ENABLED).toBe('false');
    vi.stubGlobal('window',{});const client=await load('true','cd'.repeat(32),JSON.stringify(workflows),JSON.stringify([lifecycleDeployment]));
    expect(client.EZIL_CANCELLATION_AUTHORITY_ENABLED).toBe('false');expect(client.EZIL_CANCELLATION_AUTHORITY_SECRET).toBeUndefined();expect(client.EZIL_CANCELLATION_WORKFLOWS).toEqual({});
});
it('rejects missing, mutable, foreign or shared signing settings without printing values',async()=>{
    const output=vi.spyOn(console,'error').mockImplementation(()=>{}),pins=JSON.stringify([lifecycleDeployment]);
    for(const [flag,secret,map,deployments] of [['true',undefined,undefined,pins],['true','sensitive-sentinel',JSON.stringify(workflows),pins],
        ['sensitive-sentinel',undefined,undefined,pins],['true','cd'.repeat(32),'{}',pins],['true','cd'.repeat(32),JSON.stringify(workflows),'[]'],
        ['false',undefined,'sensitive-sentinel',pins],['true','cd'.repeat(32),JSON.stringify({[lifecycleDeployment.stateMachineVersionArn]:lifecycleDeployment.stateMachineVersionArn}),pins],
        ['true','cd'.repeat(32),JSON.stringify({[lifecycleDeployment.stateMachineVersionArn]:'arn:aws:states:us-east-1:111111111111:stateMachine:ezil-cancel:1'}),pins]]){
        await expect(load(flag,secret,map,deployments)).rejects.toThrow('Invalid server environment variables');
    }
    vi.stubEnv('EZIL_LIFECYCLE_AUTHORITY_SECRET','cd'.repeat(32));
    await expect(load('true','cd'.repeat(32),JSON.stringify(workflows),pins)).rejects.toThrow('Invalid server environment variables');
    expect(JSON.stringify(output.mock.calls)).not.toContain('sensitive-sentinel');expect(JSON.stringify(output.mock.calls)).not.toContain('cd'.repeat(32));
});
