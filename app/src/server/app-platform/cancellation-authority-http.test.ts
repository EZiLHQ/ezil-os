import { createHash, createHmac, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CANCELLATION_AUTHORITY_PATH, cancellationAuthoritySignature, type CancellationAuthorityScope } from './cancellation-authority-protocol';
import { createCancellationAuthorityHandler } from './cancellation-authority-http';

const key='cd'.repeat(32),url='https://control.example'+CANCELLATION_AUTHORITY_PATH;
const input={schemaVersion:1,computerId:randomUUID(),cancellationId:randomUUID(),digest:'a'.repeat(64)};
const scope: CancellationAuthorityScope={source:{schemaVersion:1,jobId:randomUUID(),digest:'b'.repeat(64)},dataVolumeId:null,writers:[]};
function request(body=JSON.stringify(input),age=0,realm='ezil-cancellation-authority-v1'){
    const timestamp=String(Math.floor(Date.now()/1000)+age);
    const signature=createHmac('sha256',Buffer.from(key,'hex')).update([realm,'POST',CANCELLATION_AUTHORITY_PATH,timestamp,
        createHash('sha256').update(body).digest('hex')].join('\n')).digest('hex');
    if(realm==='ezil-cancellation-authority-v1')expect(cancellationAuthoritySignature(Buffer.from(body),key,timestamp)).toBe(signature);
    return new Request(url,{method:'POST',headers:{'content-type':'application/json','x-ezil-workflow-timestamp':timestamp,'x-ezil-workflow-signature':signature},body});
}
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks()});
describe('dedicated cancellation authority',()=>{
    it('returns server scope and revalidates pending authority on replay',async()=>{
        const authorize=vi.fn<()=>Promise<CancellationAuthorityScope|null>>(async()=>scope);
        const handler=createCancellationAuthorityHandler({enabled:true,secret:key,authorize}),r=request();
        const response=await handler(r.clone());expect(response.status).toBe(200);expect(await response.json()).toEqual({authorized:true,...input,...scope});
        expect(response.headers.get('cache-control')).toBe('no-store');expect(response.headers.get('set-cookie')).toBeNull();
        authorize.mockResolvedValue(null);expect((await handler(r)).status).toBe(403);expect(authorize).toHaveBeenCalledTimes(2);
    });
    it('disabled and missing-secret endpoints never read the database',async()=>{
        const authorize=vi.fn(async()=>scope);
        for(const [enabled,secret,status] of [[false,undefined,404],[true,undefined,503],[true,'bad',503]] as const){
            expect((await createCancellationAuthorityHandler({enabled,secret,authorize})(request())).status).toBe(status);
        }expect(authorize).not.toHaveBeenCalled();
    });
    it('rejects lifecycle/configuration signatures and supplied browser credentials',async()=>{
        const authorize=vi.fn(async()=>scope),handler=createCancellationAuthorityHandler({enabled:true,secret:key,authorize});
        for(const r of [request(undefined,-31),request(undefined,31),request(undefined,0,'ezil-lifecycle-authority-v1'),
            request(undefined,0,'ezil-configuration-authority-v1'),new Request(url,{method:'POST',headers:{cookie:'supabase=sensitive-sentinel',authorization:'Bearer sensitive-sentinel'},body:'{}'})]){
            const response=await handler(r);expect(response.status).toBe(401);expect(await response.text()).not.toContain('sensitive-sentinel');
        }expect(authorize).not.toHaveBeenCalled();
    });
    it('rejects altered input, provider handles, extra source data and excessive bodies before authority lookup',async()=>{
        const authorize=vi.fn(async()=>scope),handler=createCancellationAuthorityHandler({enabled:true,secret:key,authorize});
        for(const body of [JSON.stringify({...input,source:scope.source}),JSON.stringify({...input,instanceId:'sensitive-sentinel'}),
            JSON.stringify({...input,computerId:'bad'}),'x'.repeat(4097),'{malformed'])expect((await handler(request(body))).status).toBe(400);
        const signed=request();expect((await handler(new Request(url,{method:'POST',headers:signed.headers,body:JSON.stringify(input)+' '}))).status).toBe(401);
        expect(authorize).not.toHaveBeenCalled();
    });
    it('enforces exact route, method, media type and declared size',async()=>{
        const authorize=vi.fn(async()=>scope),handler=createCancellationAuthorityHandler({enabled:true,secret:key,authorize});
        const base=request();
        for(const suffix of ['?extra=1','#fragment','/other'])expect((await handler(new Request(url+suffix,{method:'POST',headers:base.headers,body:'{}'}))).status).toBe(404);
        expect((await handler(new Request(url,{method:'GET',headers:base.headers}))).status).toBe(405);
        for(const [name,value,status] of [['content-type','text/plain',415],['content-encoding','gzip',415],['content-length','4097',413]] as const){
            const headers=new Headers(base.headers);headers.set(name,value);
            expect((await handler(new Request(url,{method:'POST',headers,body:'{}'}))).status).toBe(status);
        }expect(authorize).not.toHaveBeenCalled();
    });
    it('bounds stalled bodies and refuses aborted requests',async()=>{
        vi.useFakeTimers();const authorize=vi.fn(async()=>scope),handler=createCancellationAuthorityHandler({enabled:true,secret:key,authorize});
        const stalled=new Request(url,{method:'POST',headers:request().headers,body:new ReadableStream(),duplex:'half'} as RequestInit);
        const response=handler(stalled);await vi.advanceTimersByTimeAsync(5001);expect((await response).status).toBe(400);
        const controller=new AbortController();controller.abort();
        expect((await handler(new Request(url,{method:'POST',headers:request().headers,body:'{}',signal:controller.signal}))).status).toBe(400);
        expect(authorize).not.toHaveBeenCalled();
    });
    it('redacts lookup failures and refuses malformed returned scope',async()=>{
        const handler=createCancellationAuthorityHandler({enabled:true,secret:key,authorize:async()=>{throw new Error('sensitive-sentinel')}});
        const response=await handler(request());expect(response.status).toBe(503);expect(await response.text()).not.toContain('sensitive-sentinel');
        const bad=createCancellationAuthorityHandler({enabled:true,secret:key,authorize:async()=>({...scope,dataVolumeId:'sensitive-sentinel'})});
        const denied=await bad(request());expect(denied.status).toBe(403);expect(await denied.text()).not.toContain('sensitive-sentinel');
    });
});
