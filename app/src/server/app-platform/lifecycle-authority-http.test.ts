import { createHash, createHmac, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createLifecycleAuthorityHandler } from './lifecycle-authority-http';
import { LIFECYCLE_AUTHORITY_PATH, lifecycleAuthoritySignature } from './lifecycle-authority-protocol';
import { computerRecoveryFixture } from '../../../tests/fixtures/computer-recovery';

const key='ab'.repeat(32), url='https://control.example'+LIFECYCLE_AUTHORITY_PATH;
const input={schemaVersion:1,computerId:randomUUID(),jobId:randomUUID(),digest:'a'.repeat(64)};
function request(body=JSON.stringify(input),age=0,realm='ezil-lifecycle-authority-v1') {
    const timestamp=String(Math.floor(Date.now()/1000)+age);
    const signature=createHmac('sha256',Buffer.from(key,'hex')).update([realm,'POST',LIFECYCLE_AUTHORITY_PATH,timestamp,
        createHash('sha256').update(body).digest('hex')].join('\n')).digest('hex');
    expect(realm!=='ezil-lifecycle-authority-v1'||lifecycleAuthoritySignature(Buffer.from(body),key,timestamp)===signature).toBe(true);
    return new Request(url,{method:'POST',headers:{'content-type':'application/json','x-ezil-workflow-timestamp':timestamp,'x-ezil-workflow-signature':signature},body});
}
describe('lifecycle authority endpoint',()=>{
    it('v2 returns only authenticated server writer records and fails closed without v2 authority',async()=>{
        const f=computerRecoveryFixture(), body=JSON.stringify({...input,schemaVersion:2});
        const authorize=vi.fn(async()=>true), authorizeRecovery=vi.fn(async()=>({writers:f.writers}));
        const handle=createLifecycleAuthorityHandler({enabled:true,secret:key,authorize,authorizeRecovery});
        const result=await handle(request(body));expect(result.status).toBe(200);
        expect(await result.json()).toEqual({authorized:true,...input,schemaVersion:2,writers:f.writers});
        expect(authorize).not.toHaveBeenCalled();expect(authorizeRecovery).toHaveBeenCalledOnce();
        expect((await createLifecycleAuthorityHandler({enabled:true,secret:key,authorize})(request(body))).status).toBe(403);
        expect((await handle(request(JSON.stringify({...input,schemaVersion:2,writers:f.writers})))).status).toBe(400);
    });
    it('authenticates without cookies and repeats current authority checks on replay',async()=>{
        const authorize=vi.fn(async()=>true), handle=createLifecycleAuthorityHandler({enabled:true,secret:key,authorize});
        const r=request(), first=await handle(r.clone());expect(first.status).toBe(200);expect(await first.json()).toEqual({authorized:true,...input});
        expect(first.headers.get('set-cookie')).toBeNull();expect(first.headers.get('cache-control')).toBe('no-store');
        authorize.mockResolvedValue(false);expect((await handle(r)).status).toBe(403);expect(authorize).toHaveBeenCalledTimes(2);
    });
    it('disabled or unconfigured endpoint never accesses the database',async()=>{
        const authorize=vi.fn(async()=>true);
        for(const [enabled,secret,status] of [[false,undefined,404],[true,undefined,503],[true,'invalid',503]] as const){
            expect((await createLifecycleAuthorityHandler({enabled,secret,authorize})(request())).status).toBe(status);
        }expect(authorize).not.toHaveBeenCalled();
    });
    it('rejects stale signatures, alternate signing realms, and user credentials',async()=>{
        const authorize=vi.fn(async()=>true), handle=createLifecycleAuthorityHandler({enabled:true,secret:key,authorize});
        const raw=JSON.stringify(input);
        for(const r of [request(raw,-31),request(raw,31),request(raw,0,'ezil-configuration-authority-v1'),
            new Request(url,{method:'POST',headers:{authorization:'Bearer sensitive-sentinel',cookie:'supabase=sensitive-sentinel'},body:raw})]){
            const result=await handle(r);expect(result.status).toBe(401);expect(await result.text()).not.toContain('sensitive-sentinel');
        }expect(authorize).not.toHaveBeenCalled();
    });
    it('rejects provider handles, extra fields, wrong scope, oversized and altered bodies',async()=>{
        const authorize=vi.fn(async()=>true),handle=createLifecycleAuthorityHandler({enabled:true,secret:key,authorize});
        for(const body of [JSON.stringify({...input,instanceId:'sensitive-sentinel'}),JSON.stringify({...input,computerId:'wrong'}),'x'.repeat(4097)]){
            expect((await handle(request(body))).status).toBe(400);
        }
        const r=request();expect((await handle(new Request(url,{method:'POST',headers:r.headers,body:JSON.stringify(input)+' '}))).status).toBe(401);
        expect(authorize).not.toHaveBeenCalled();
    });
    it('fails closed without returning database exception text',async()=>{
        const handle=createLifecycleAuthorityHandler({enabled:true,secret:key,authorize:async()=>{throw new Error('sensitive-sentinel')}});
        const r=await handle(request());expect(r.status).toBe(503);expect(await r.text()).not.toContain('sensitive-sentinel');
    });
});
