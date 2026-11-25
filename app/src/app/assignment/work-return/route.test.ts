import { beforeEach, describe, expect, it, vi } from 'vitest';
import { safeReturnUrl } from '@/utils/constants';
import { embeddedCodeAttempt, listenForWorkSignIn, workReturnAttempt } from '@/utils/assignment-work-auth';

const mocks = vi.hoisted(() => ({context:vi.fn(), enabled:vi.fn()}));
vi.mock('@/server/api/trpc', () => ({ createTRPCContext:mocks.context }));
vi.mock('@/server/git/assignment-enrollment', () => ({ assignmentEnrollmentEnabled:mocks.enabled }));
import { GET } from './route';

const id='ba4cf399-1f9b-43e5-be10-45e403bc0190', origin='https://os-staging.ezil.work', universe='https://universe-staging.ezil.work';
const returned='/assignment/work-return?attempt='+id;
const repo='https://github.ezil.work/default/u-0123456789abcdef-a-'+id+'.git';
const request=(path=returned, dest='document',host=origin)=>new Request(host+path,{headers:{'sec-fetch-dest':dest}});
const stageEnv=()=>{vi.unstubAllEnvs();vi.stubEnv('BILLING_FUNDING_URL','https://ai-staging.ezil.work');vi.stubEnv('EZIL_ASSIGNMENT_PRODUCTION_ENABLED','');
    vi.stubEnv('UNIVERSE_PROJECT_REPO_ORIGIN',universe);};
const productionEnv=()=>{vi.unstubAllEnvs();vi.stubEnv('BILLING_FUNDING_URL','https://ai.ezil.work');vi.stubEnv('EZIL_ASSIGNMENT_PRODUCTION_ENABLED','1');
    vi.stubEnv('UNIVERSE_PROJECT_REPO_ORIGIN','https://universe.ezil.work');};
beforeEach(()=>{vi.clearAllMocks();stageEnv();mocks.enabled.mockReturnValue(true);mocks.context.mockResolvedValue({user:{id:'signed-in'},delegation:null});});

describe('return from top-level OS sign-in to the original Universe assignment',()=>{
    it('preserves an exact local OAuth transaction and sends the verified OS user to one fixed stage destination',async()=>{
        expect(safeReturnUrl(returned)).toBe(returned);
        const response=await GET(request());
        expect(response.status).toBe(303);
        expect(response.headers.get('location')).toBe(universe+'/assignment/work/'+id);
        expect(response.headers.get('cache-control')).toContain('no-store');
        expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
        expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    });
    it('allows normal sign-in for a logged-out top-level browser without minting access or recursing',async()=>{
        mocks.context.mockResolvedValue({user:null,delegation:null});
        const first=await GET(request());
        const login=new URL(first.headers.get('location')!);
        expect(login.origin+login.pathname).toBe(origin+'/login');
        expect(login.searchParams.get('returnUrl')).toBe(returned);
    });
    it('returns an embedded assignment to its Universe workspace in the same document',async()=>{
        const embedded=returned+'&workspace=1';
        expect(safeReturnUrl(embedded)).toBe(embedded);
        const signedIn=await GET(request(embedded));
        expect(signedIn.status).toBe(303);
        expect(signedIn.headers.get('location')).toBe(universe+'/assignment/workspace/'+id);
        mocks.context.mockResolvedValue({user:null,delegation:null});
        const login=await GET(request(embedded));
        expect(new URL(login.headers.get('location')!).searchParams.get('returnUrl')).toBe(embedded);
        const enrollment='/app/assignment-enrollment?attempt='+id+'&workspace=1';
        expect(safeReturnUrl(enrollment)).not.toBe(enrollment);
    });
    it('on production serves only the embedded workspace return, on os.ezil.work, to universe.ezil.work',async()=>{
        productionEnv();
        const prod='https://os.ezil.work', embedded=returned+'&workspace=1';
        const signedIn=await GET(request(embedded,'document',prod));
        expect(signedIn.status).toBe(303);
        expect(signedIn.headers.get('location')).toBe('https://universe.ezil.work/assignment/workspace/'+id);
        expect(signedIn.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
        mocks.context.mockResolvedValue({user:null,delegation:null});
        const login=new URL((await GET(request(embedded,'document',prod))).headers.get('location')!);
        expect(login.origin+login.pathname).toBe(prod+'/login');
        expect(login.searchParams.get('returnUrl')).toBe(embedded);
        mocks.context.mockClear();
        // The production top-level assignment tab never used this route, the staging host is another deployment, and
        // an unowned or sibling host is not this deployment's OS origin.
        for(const [path,dest,host] of [[returned,'document',prod],[embedded,'iframe',prod],[embedded,'document',origin],
            [embedded,'document','https://os-prod.ezil.work'],[embedded,'document','https://os.ezil.org'],[embedded,'document','https://evil.example']] as const)
            expect((await GET(request(path,dest,host))).status).toBe(404);
        expect(mocks.context).not.toHaveBeenCalled();
    });
    it('serves nothing when no deployment authority is selected, or the staging authority is asked on production',async()=>{
        const embedded=returned+'&workspace=1';
        vi.unstubAllEnvs();vi.stubEnv('BILLING_FUNDING_URL','');
        expect((await GET(request(embedded))).status).toBe(404);
        expect((await GET(request(embedded,'document','https://os.ezil.work'))).status).toBe(404);
        stageEnv();
        expect((await GET(request(embedded,'document','https://os.ezil.work'))).status).toBe(404);
        expect(mocks.context).not.toHaveBeenCalled();
    });
    it.each([returned+'&returnUrl=https://example.org',returned+'&attempt='+id,returned+'&x=1',
        returned+'&workspace=0',returned+'&workspace=1&workspace=1',returned+'&workspace=1&x=1',
        '/assignment/work-return?workspace=1&attempt='+id,
        '/assignment/work-return?attempt=../os','//universe-staging.ezil.work/assignment/work/'+id,
        '/assignment/work-return?attempt='+id.toUpperCase()])('rejects a supplied alternative return target %s',async value=>{
        expect(workReturnAttempt(value)).toBeNull();
        expect(safeReturnUrl(value)).not.toBe(value);
        expect((await GET(request(value))).status).toBe(404);
    });
    it('refuses iframe, production or delegated and disabled-stage use',async()=>{
        expect((await GET(request(returned,'iframe'))).status).toBe(404);
        expect((await GET(request(returned,'document','https://os.ezil.work'))).status).toBe(404);
        mocks.enabled.mockReturnValueOnce(false);
        expect((await GET(request())).status).toBe(404);
        expect(mocks.context).not.toHaveBeenCalled();
        mocks.context.mockResolvedValue({user:{id:'signed'},delegation:{}});
        expect((await GET(request())).status).toBe(404);
    });
    it('identifies only the canonical matching assignment entry in Code',()=>{
        expect(embeddedCodeAttempt({assignment:id,repo})).toBe(id);
        for(const data of [{assignment:id,repo:'https://github.com/example/other.git'}, {assignment:[id,id],repo},
            {assignment:id,repo:[repo,repo]}, {assignment:id,repo:repo.replace(id,id.toUpperCase())}, {repo}]) {
            expect(embeddedCodeAttempt(data)).toBeNull();
        }
    });
    it('sends only the challenged auth-required indication to the actual top-level Universe frame',()=>{
        const top={postMessage:vi.fn()},listeners=new Map<string, EventListener>();
        const win={top,parent:top,location:{origin},addEventListener:(key:string,fn:EventListener)=>listeners.set(key,fn),
            removeEventListener:(key:string)=>listeners.delete(key)};
        const dispose=listenForWorkSignIn(id,win as unknown as Window);
        const data={type:'discover',attemptId:id,challenge:id,protocol:'ezil.assignment.work/v2'};
        const probe=(source:object,from:string,overrides={})=>listeners.get('message')?.({source,origin:from,data:{...data,...overrides}} as unknown as Event);
        probe({},universe);probe(top,'https://other.ezil.work');probe(top,universe,{attemptId:'wrong'});probe(top,universe,{challenge:'wrong'});
        expect(top.postMessage).not.toHaveBeenCalled();
        probe(top,universe);
        expect(top.postMessage).toHaveBeenCalledWith({...data,type:'authentication_required'},universe);
        dispose();probe(top,universe);expect(top.postMessage).toHaveBeenCalledTimes(1);
    });
});
