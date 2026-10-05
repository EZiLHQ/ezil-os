import { describe, expect, it, mock } from 'bun:test';
mock.module('cloudflare:workers', () => ({DurableObject:class {},WorkerEntrypoint:class {},RpcTarget:class {},RpcStub:class {},env:{}}));
import { hmacSha256Hex, PREVIEW_TOKEN_PAYLOAD, TOKEN_MAX_AGE_MS } from './hmac';
const secret='relay-route-test-only';
const name='guac-abcdef0123456789-fedcba9876543210';
const runtimeId='a'.repeat(32);
const token=async (key=secret,t=Date.now())=>`t=${t},v1=${await hmacSha256Hex(key,PREVIEW_TOKEN_PAYLOAD(t))}`;
async function fixture(extra:Record<string,unknown> = {}) {
    const calls:{name:string;runtimeId?:string}[]=[];
    let opened='';
    const mod=await import('./index');
    const env={SANDBOX_HMAC_SECRET:secret, Sandbox:{
        idFromName:(value:string)=>{opened=value;return value},
        get:()=>({relayRefresh:async (sandboxId:string, runtimeId?:string)=>{calls.push({name:sandboxId,runtimeId});return {runtimeId:'a'.repeat(32),expiresAt:Date.now()+300000}}}),
    },...extra};
    return {calls,opened:()=>opened,fetch:(req:Request)=>mod.default.fetch(req,env as never)};
}
describe('relay control uses the real signed Worker boundary',()=>{
    it('rejects absent, incorrect and expired signatures before accessing any computer',async()=>{
        for (const signed of ['',await token('wrong-key'),await token(secret,Date.now()-TOKEN_MAX_AGE_MS-1000)]) {
            for(const method of ['GET','POST']) {
                const f=await fixture();
                const res=await f.fetch(new Request(`https://worker.example/sandbox/${name}/relay-refresh`,{method,
                    headers:{Authorization:`Bearer ${signed}`,'Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify({runtimeId})}:{})}));
                expect(res.status).toBe(401);expect(f.calls).toHaveLength(0);expect(f.opened()).toBe('');
            }
        }
    });
    it('forwards a signed read and runtime-fenced refresh only to the named computer',async()=>{
        const f=await fixture();
        const signed=await token();
        for(const method of ['GET','POST']) {
            const res=await f.fetch(new Request(`https://worker.example/sandbox/${name}/relay-refresh`,{method,
                headers:{Authorization:`Bearer ${signed}`,'Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify({runtimeId})}:{})}));
            expect(res.status).toBe(200);
            expect(await res.json()).toMatchObject({ok:true,runtimeId});
        }
        expect(f.calls).toEqual([{name,runtimeId:undefined},{name,runtimeId}]);
    });
    it('signed malformed runtime identity never reaches the Durable Object',async()=>{
        const f=await fixture();
        for (const body of ['null','[]','{',JSON.stringify({runtimeId:'old-image'})]) {
            const res=await f.fetch(new Request(`https://worker.example/sandbox/${name}/relay-refresh`,{method:'POST',
                headers:{Authorization:`Bearer ${await token()}`,'Content-Type':'application/json'},body}));
            expect(res.status).toBe(400);expect(f.calls).toHaveLength(0);
        }
    });
});

describe('backend acceptance fault route authorization',()=>{
    it('denies unsigned staging controls and signed controls for production or other computers',async()=>{
        const staging={EZIL_ACCEPTANCE_ENV:'staging',EZIL_ACCEPTANCE_SANDBOX:name};
        const cases=[{env:staging,signed:'',expected:401},
          {env:{},signed:await token(),expected:404},
          {env:{...staging,EZIL_ACCEPTANCE_ENV:'production'},signed:await token(),expected:404},
          {env:{...staging,EZIL_ACCEPTANCE_SANDBOX:'guac-other-computer'},signed:await token(),expected:404}];
        for(const test of cases){
            const f=await fixture(test.env);
            const response=await f.fetch(new Request(`https://worker.example/sandbox/${name}/acceptance-fault`,{method:'POST',
              headers:{Authorization:`Bearer ${test.signed}`,'Content-Type':'application/json'},body:JSON.stringify({fault:'turn_unavailable',durationMs:1000})}));
            expect(response.status).toBe(test.expected);expect(f.calls).toHaveLength(0);expect(f.opened()).toBe('');
        }
    });
});
