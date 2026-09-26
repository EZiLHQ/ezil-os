import { createHash, createHmac, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMountAuthorityHandler, MOUNT_AUTHORITY_PATH, mountAuthoritySignature } from './computer-mount-authority-http';
import { canonicalConfiguration } from './computer-configuration';
import { lifecycleDeployment as deployment } from '../../../tests/fixtures/lifecycle';

const key = 'ab'.repeat(32), url = 'https://control.example'+MOUNT_AUTHORITY_PATH;
const scope = { computerId: randomUUID(), computerGeneration: 1, providerInstanceId: 'i-0123456789abcdef0',
    dataVolumeId: 'vol-0123456789abcdef0', fenceToken: randomUUID() };
const plan = { computerId: scope.computerId, filesystemUuid: randomUUID(), mode: 'mount' as const,
    schemaVersion: 1 as const, volumeId: scope.dataVolumeId };
const input = { authorization: { schemaVersion: 1 as const, authorizationId: randomUUID(), scope, filesystemUuid: plan.filesystemUuid,
    mode: plan.mode, digest: createHash('sha256').update(canonicalConfiguration(plan)).digest('hex'), issuedAt: 1800000000, expiresAt: 1800000900 }, plan, deployment };
const body = JSON.stringify(input);
function request(text = body, age = 0, realm = 'ezil-mount-authority-v1') {
    const timestamp = String(Math.floor(Date.now()/1000)+age);
    const signature = createHmac('sha256',Buffer.from(key,'hex')).update([realm,'POST',MOUNT_AUTHORITY_PATH,timestamp,
        createHash('sha256').update(text).digest('hex')].join('\n')).digest('hex');
    if (realm === 'ezil-mount-authority-v1') expect(mountAuthoritySignature(Buffer.from(text),key,timestamp)).toBe(signature);
    return new Request(url,{ method:'POST', headers:{ 'content-type':'application/json', 'x-ezil-workflow-timestamp':timestamp,
        'x-ezil-workflow-signature':signature }, body:text });
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('mount authority HTTP', () => {
    it('binds the exact work and rechecks revocation on fresh signed replay', async () => {
        const authorize = vi.fn(async () => true), handle = createMountAuthorityHandler({ enabled:true, secret:key, authorize });
        const req = request(), r = await handle(req.clone()); expect(r.status).toBe(200);
        expect(await r.json()).toEqual({ authorized:true, work:input }); expect(r.headers.get('cache-control')).toBe('no-store');
        expect(r.headers.get('set-cookie')).toBeNull();
        authorize.mockResolvedValue(false); expect((await handle(req)).status).toBe(403); expect(authorize).toHaveBeenCalledTimes(2);
    });
    it('stays closed with missing/invalid settings and rejects user credentials or other signing realms', async () => {
        const authorize = vi.fn(async () => true);
        for (const [enabled,secret,status] of [[false,undefined,404],[true,undefined,503],[true,'PRIVATE_KEY',503]] as const) {
            expect((await createMountAuthorityHandler({ enabled,secret,authorize })(request())).status).toBe(status);
        }
        const handle = createMountAuthorityHandler({ enabled:true,secret:key,authorize });
        for (const req of [request(body,-31),request(body,31),request(body,0,'ezil-lifecycle-authority-v1'),
            request(body,0,'ezil-configuration-authority-v1'), new Request(url,{method:'POST',body,
                headers:{authorization:'Bearer PRIVATE_SESSION',cookie:'supabase=PRIVATE_SESSION'}})]) {
            const r = await handle(req); expect(r.status).toBe(401); expect(await r.text()).not.toContain('PRIVATE_SESSION');
        }
        expect(authorize).not.toHaveBeenCalled();
    });
    it('rejects altered bodies, unknown fields, invalid content and excessive streams before the database', async () => {
        const authorize = vi.fn(async () => true), handle = createMountAuthorityHandler({ enabled:true,secret:key,authorize });
        expect((await handle(new Request(url,{method:'POST',headers:request().headers,body:body+' '}))).status).toBe(401);
        for (const text of ['{', 'x'.repeat(16385), JSON.stringify({...input,secret:'PRIVATE_VALUE'}),
            JSON.stringify({...input,plan:{...plan,mode:'initialize'}})]) expect((await handle(request(text))).status).toBe(400);
        expect(authorize).not.toHaveBeenCalled();
    });
    it('enforces the fixed path, method, declared length and unencoded JSON media type', async () => {
        const authorize = vi.fn(async () => true), handle = createMountAuthorityHandler({ enabled:true,secret:key,authorize });
        for (const [target,method,extra,status] of [[url+'?x=1','POST',{},404],[url,'GET',{},405],
            [url,'POST',{'content-length':'16385'},413],[url,'POST',{'content-type':'text/plain'},415],
            [url,'POST',{'content-encoding':'gzip'},415]] as const) {
            const headers = new Headers(request().headers); for (const [k,v] of Object.entries(extra)) headers.set(k,v);
            expect((await handle(new Request(target,{method,headers,...(method==='POST'?{body}:{})}))).status).toBe(status);
        } expect(authorize).not.toHaveBeenCalled();
    });
    it('bounds stalled request bodies and authorizers with redacted failure responses', async () => {
        vi.useFakeTimers(); const authorize = vi.fn(async () => true), handle = createMountAuthorityHandler({ enabled:true,secret:key,authorize });
        const stream = new ReadableStream({ start() {} });
        const req = new Request(url,{method:'POST',headers:request().headers,body:stream,duplex:'half'} as RequestInit);
        const reading = handle(req); await vi.advanceTimersByTimeAsync(5100); expect((await reading).status).toBe(400);
        expect(authorize).not.toHaveBeenCalled();
        const waiting = createMountAuthorityHandler({enabled:true,secret:key,authorize:()=>new Promise(()=>{})})(request());
        await vi.advanceTimersByTimeAsync(15100); expect((await waiting).status).toBe(503);
        const r = await createMountAuthorityHandler({enabled:true,secret:key,authorize:async()=>{throw new Error('PRIVATE_DATABASE')}})(request());
        expect(r.status).toBe(503); expect(await r.text()).not.toContain('PRIVATE_DATABASE');
    });
    it('rejects disablement, request cancellation or stale time during authorization', async () => {
        for (const kind of ['disable','cancel','stale']) {
            const controller = new AbortController(), req = new Request(url,{method:'POST',headers:request().headers,body,signal:controller.signal});
            const now = Date.now();
            const options = { enabled:true,secret:key,authorize:async()=>{
                if(kind==='disable') options.enabled=false;
                if(kind==='cancel') controller.abort();
                if(kind==='stale') vi.spyOn(Date,'now').mockReturnValue(now+31000);
                return true;
            }};
            const r = await createMountAuthorityHandler(options)(req); expect([401,403,503]).toContain(r.status);
            vi.restoreAllMocks();
        }
    });
    it('does not let the authorizer mutate the response binding', async () => {
        const handle = createMountAuthorityHandler({enabled:true,secret:key,authorize:async work=>{
            work.authorization.scope.computerId=randomUUID(); return true;
        }});
        expect(await (await handle(request())).json()).toEqual({authorized:true,work:input});
    });
});
