import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({context:vi.fn(),identity:vi.fn(),action:vi.fn()}));
vi.mock('@/server/api/trpc',()=>({createTRPCContext:mocks.context}));
vi.mock('@/server/auth/retained-identity',()=>({retainedIdentity:mocks.identity}));
vi.mock('@/server/assignment-video/broker',()=>({recordingAction:mocks.action}));
vi.mock('@/server/shell/http',()=>({
    shellUnauthenticated:()=>Response.json({error:'sign_in'},{status:401}),
    shellJson:(data:unknown,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store'}}),
}));
import { POST } from './route';
import { BrokerError, creatorUnlinked } from '@/server/assignment-video/contract';
const attemptId='00000000-0000-4000-8000-000000000001';
const action={attemptId,action:'status'};
const defaults = {'content-type':'application/json','origin':'https://os-staging.ezil.work','sec-fetch-site':'same-origin',
    'x-ezil-assignment-video':'1','host':'os-staging.ezil.work'};
function post(headers:Record<string,string>=defaults,body:unknown=action){
    return POST(new Request('https://os-staging.ezil.work/api/shell/assignment-video',{method:'POST',headers,body:JSON.stringify(body)}));
}
beforeEach(()=>{
    vi.resetAllMocks();
    vi.stubEnv('BILLING_FUNDING_URL','https://ai-staging.ezil.work');
    vi.stubEnv('UNIVERSE_PROJECT_REPO_ORIGIN','https://universe-staging.ezil.work');
    mocks.context.mockResolvedValue({user:{id:'signed-owner'},delegation:null});
    mocks.identity.mockResolvedValue({userId:'signed-owner',sessionId:'persisted',subject:'participant'});
    mocks.action.mockResolvedValue({status:'recording'});
});
describe('same-origin actual assignment shell route',()=>{
    it('requires the dedicated staging pair',async()=>{
        vi.stubEnv('BILLING_FUNDING_URL','https://ai.ezil.work');
        expect((await post()).status).toBe(404);
        expect(mocks.context).not.toHaveBeenCalled();
    });
    it('allows normal status reads when the optional Git pilot is unavailable',async()=>{
        vi.stubEnv('UNIVERSE_PROJECT_REPO_ORIGIN', undefined);
        expect((await post()).status).toBe(200);
    });
    it('rejects wrong or absent origin, cross-site, non-JSON and missing CSRF sentinel',async()=>{
        for(const changed of [{origin:'https://elsewhere.example'},{origin:''},{'sec-fetch-site':'same-site'},
            {'x-ezil-assignment-video':''}]){
            expect((await post({...defaults,...changed} as Record<string,string>)).status).toBe(403);
        }
        expect((await post({...defaults,'content-type':'text/plain'})).status).toBe(400);
        expect(mocks.context).not.toHaveBeenCalled();
    });
    it('requires the current nondelegated OS session, including a second check after an operation',async()=>{
        mocks.context.mockResolvedValueOnce({user:null,delegation:null});
        expect((await post()).status).toBe(401);
        mocks.context.mockResolvedValueOnce({user:{id:'signed-owner'},delegation:{}});
        expect((await post()).status).toBe(404);
        mocks.identity.mockResolvedValueOnce(null);
        expect((await post()).status).toBe(401);
        expect(mocks.action).not.toHaveBeenCalled();
        mocks.identity.mockResolvedValueOnce({sessionId:'a',subject:'actor'}).mockResolvedValueOnce({sessionId:'b',subject:'actor'});
        expect((await post()).status).toBe(401);
    });
    it('returns the known Creator refusal only from preflight for the same still-current session',async()=>{
        const preflight={attemptId,action:'preflight'};
        mocks.action.mockRejectedValue(new BrokerError(creatorUnlinked,409));
        const refused=await post(defaults,preflight);
        expect(refused.status).toBe(409);
        expect(await refused.json()).toEqual({error:{code:creatorUnlinked}});
        expect(refused.headers.get('cache-control')).toContain('no-store');
        mocks.identity.mockResolvedValueOnce({sessionId:'a',subject:'actor'}).mockResolvedValueOnce({sessionId:'b',subject:'actor'});
        const changed=await post(defaults,preflight);
        expect(changed.status).toBe(401);
        expect(await changed.json()).toEqual({error:{code:'identity_refresh_required'}});
        const status=await post();
        expect(await status.json()).toEqual({error:{code:'recording_refused'}});
    });
    it('bounds the body and rejects supplied participant credentials or session fields',async()=>{
        for(const invalid of [{...action,userIdToken:'supplied'},{...action,osSessionId:'supplied'},{...action,filler:'a'.repeat(2049)}]){
            expect((await post(defaults,invalid)).status).toBe(400);
        }
        expect(mocks.action).not.toHaveBeenCalled();
    });
    it('sends only the normal validated action and identity and returns a private no-store receipt',async()=>{
        const res=await post();
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({status:'recording'});
        expect(res.headers.get('cache-control')).toContain('no-store');
        expect(mocks.action).toHaveBeenCalledOnce();
        expect(mocks.identity).toHaveBeenCalledTimes(2);
    });
});
