import { beforeEach, describe, expect, it, vi } from 'vitest';
import { safeReturnUrl } from '@/utils/constants';
import { embeddedCodeAttempt, embeddedWorkReturn, listenForWorkSignIn, workReturnAttempt } from '@/utils/assignment-work-auth';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({context:vi.fn(), enabled:vi.fn(), identity:vi.fn()}));
vi.mock('@/server/api/trpc', () => ({ createTRPCContext:mocks.context }));
// The real owner-bound repository name; only the stage switch is stubbed.
vi.mock('@/server/git/assignment-enrollment', async original => ({
    ...await original<typeof import('@/server/git/assignment-enrollment')>(), assignmentEnrollmentEnabled:mocks.enabled }));
vi.mock('@/server/auth/retained-identity', () => ({ retainedIdentity:mocks.identity }));
import { ownerRepositoryName } from '@/server/git/assignment-enrollment';
import { GET } from './route';

const id='ba4cf399-1f9b-43e5-be10-45e403bc0190', origin='https://os-staging.ezil.work', universe='https://universe-staging.ezil.work';
const returned='/assignment/work-return?attempt='+id;
const repo='https://github.ezil.work/default/u-0123456789abcdef-a-'+id+'.git';
const request=(path=returned, dest='document',host=origin)=>new Request(host+path,{headers:{'sec-fetch-dest':dest}});
const subject='auth0|builder', hourMs=3_600_000;
const kept=(sub=subject,validFor=10*hourMs)=>({subject:sub,expiresAt:Date.now()+validFor});
beforeEach(()=>{vi.clearAllMocks();mocks.enabled.mockReturnValue(true);mocks.context.mockResolvedValue({user:{id:'signed-in'},delegation:null});
    mocks.identity.mockImplementation(async()=>kept());});

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
        const enrollment='/app/assignment-enrollment?attempt='+id+'&workspace=1';
        expect(safeReturnUrl(enrollment)).not.toBe(enrollment);
    });
    it.each([returned+'&returnUrl=https://example.org',returned+'&attempt='+id,returned+'&x=1',
        returned+'&workspace=0',returned+'&workspace=1&workspace=1',returned+'&workspace=1&x=1',
        returned+'&owner=0123456789abcdef',returned+'&workspace=1&owner=0123456789ABCDEF',returned+'&workspace=1&owner=0123456789abcde',
        returned+'&workspace=1&owner=0123456789abcdef0',returned+'&workspace=1&owner=0123456789abcdef&owner=0123456789abcdef',
        returned+'&owner=0123456789abcdef&workspace=1',returned+'&workspace=1&owner=',returned+'&workspace=1&owner=0123456789abcdef&x=1',
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

describe('embedded workspace return: the same EZiL ID, kept for the work window, without a loop',()=>{
    const embedded=returned+'&workspace=1', workspace=universe+'/assignment/workspace/'+id;
    const tag=(sub:string)=>ownerRepositoryName(sub,'a-'+id).slice(2,18);
    const owned=embedded+'&owner='+tag(subject);
    const cookie='__Host-ezil-work-return';
    const get=(path:string,jar?:string)=>GET(new Request(origin+path,{headers:{'sec-fetch-dest':'document',...(jar?{cookie:jar}:{})}}));
    const where=(response:Response)=>new URL(response.headers.get('location')!);

    it('reads the owner tag only in its exact position and shape',()=>{
        expect(embeddedWorkReturn(embedded)).toEqual({attempt:id,owner:null});
        expect(embeddedWorkReturn(owned)).toEqual({attempt:id,owner:tag(subject)});
        expect(embeddedWorkReturn(returned)).toBeNull();
        expect(safeReturnUrl(owned)).toBe(owned);
        expect(tag(subject)).toMatch(/^[0-9a-f]{16}$/);
    });
    it('a fresh OS browser goes straight to the ordinary EZiL ID sign-in and comes back here',async()=>{
        mocks.context.mockResolvedValue({user:null,delegation:null});
        const response=await get(owned);
        const login=where(response);
        expect(response.status).toBe(303);
        expect(login.origin+login.pathname).toBe(origin+'/auth/auth0/login');
        expect([...login.searchParams.keys()]).toEqual(['returnUrl']);
        expect(login.searchParams.get('returnUrl')).toBe(owned);
        expect(response.headers.get('set-cookie')).toBe(cookie+'='+id+'; Path=/; Max-Age=120; HttpOnly; Secure; SameSite=Lax');
        expect(mocks.identity).not.toHaveBeenCalled();
        // The sign-in came back with a session and its EZiL ID: the workspace, with no second trip.
        mocks.context.mockResolvedValue({user:{id:'signed-in'},delegation:null});
        const back=await get(owned,cookie+'='+id);
        expect(back.headers.get('location')).toBe(workspace);
        expect(back.headers.get('set-cookie')).toContain(cookie+'=; Path=/; Max-Age=0');
    });
    it('🔴 a sign-in that came back without an OS session stops at the lock screen; Continue there is one more try',async()=>{
        mocks.context.mockResolvedValue({user:null,delegation:null});
        const repeat=await get(owned,cookie+'='+id);
        const stop=where(repeat);
        expect(stop.origin+stop.pathname).toBe(origin+'/login');
        expect(stop.searchParams.get('error')).toBe('auth_callback_failed');
        expect(stop.searchParams.get('returnUrl')).toBe(owned);
        expect(repeat.headers.get('set-cookie')).toContain(cookie+'=; Path=/; Max-Age=0');
        // The marker is spent, so the person's own Continue gets exactly one automatic trip again, then the same stop.
        const retry=await get(owned);
        expect(where(retry).pathname).toBe('/auth/auth0/login');
        expect(retry.headers.get('set-cookie')).toContain(cookie+'='+id+';');
        expect(where(await get(owned,cookie+'='+id)).pathname).toBe('/login');
        expect(mocks.identity).not.toHaveBeenCalled();
    });
    it('🔴 a fresh sign-in that kept no EZiL ID is not followed by a silent refresh',async()=>{
        mocks.identity.mockRejectedValue(new Error('IDENTITY_REFRESH_REQUIRED'));
        const response=where(await get(owned,cookie+'='+id));
        expect(response.origin+response.pathname).toBe(origin+'/login');
        expect(response.searchParams.has('prompt')).toBe(false);
    });
    it('🔴 an OS session without its retained EZiL ID is refreshed silently, once, instead of bouncing back to Universe',async()=>{
        mocks.identity.mockRejectedValue(new Error('IDENTITY_REFRESH_REQUIRED'));
        const first=await get(owned);
        const login=where(first);
        expect(login.origin+login.pathname).toBe(origin+'/auth/auth0/login');
        expect(login.searchParams.get('prompt')).toBe('none');
        expect(login.searchParams.get('returnUrl')).toBe(owned);
        expect(first.headers.get('set-cookie')).toBe(cookie+'='+id+'; Path=/; Max-Age=120; HttpOnly; Secure; SameSite=Lax');
        expect(mocks.identity).toHaveBeenCalledWith('signed-in');
        // The refresh came back and kept one: the workspace, and the marker is spent.
        mocks.identity.mockImplementation(async()=>kept());
        const second=await get(owned,cookie+'='+id);
        expect(second.headers.get('location')).toBe(workspace);
        expect(second.headers.get('set-cookie')).toContain(cookie+'=; Path=/; Max-Age=0');
    });
    it('🔴 a refresh that kept nothing ends on the lock screen: no second refresh, no Universe bounce',async()=>{
        mocks.identity.mockRejectedValue(new Error('IDENTITY_REFRESH_REQUIRED'));
        const response=await get(owned,'a=b; '+cookie+'='+id);
        const login=where(response);
        expect(login.origin+login.pathname).toBe(origin+'/login');
        expect(login.searchParams.get('error')).toBe('auth_callback_failed');
        expect(login.searchParams.get('returnUrl')).toBe(owned);
        expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    });
    it('a marker for another attempt does not spend this one',async()=>{
        mocks.identity.mockRejectedValue(new Error('IDENTITY_REFRESH_REQUIRED'));
        expect(where(await get(owned,cookie+'=00000000-0000-4000-8000-000000000001')).searchParams.get('prompt')).toBe('none');
    });
    it('🔴 a matching EZiL ID the vault still accepts is used as it is, with five minutes left: no extra provider round trip',async()=>{
        for(const left of [5*60_000,61_000,10*hourMs]){
            mocks.identity.mockImplementation(async()=>kept(subject,left));
            const response=await get(owned);
            expect(response.headers.get('location')).toBe(workspace);
            expect(response.headers.get('set-cookie')).toBeNull();
        }
        expect(mocks.identity).toHaveBeenCalledTimes(3);
    });
    it('only the vault decides expiry: its refusal is refreshed once, and a second refusal stops at the lock screen',async()=>{
        // `retainedIdentity` rejects a lost entry, an expired token and one inside IDENTITY_MIN_VALIDITY_MS alike.
        mocks.identity.mockRejectedValue(new Error('IDENTITY_REFRESH_REQUIRED'));
        const first=await get(owned);
        expect(where(first).searchParams.get('prompt')).toBe('none');
        expect(first.headers.get('set-cookie')).toContain(cookie+'='+id+'; Path=/; Max-Age=120');
        const second=where(await get(owned,cookie+'='+id));
        expect(second.origin+second.pathname).toBe(origin+'/login');
        expect(second.searchParams.has('prompt')).toBe(false);
    });
    it('🔴 another account is told so on the lock screen: never a silent refresh, a switch, or a Universe bounce',async()=>{
        mocks.identity.mockImplementation(async()=>kept('auth0|someone-else'));
        for(const jar of [undefined,cookie+'='+id]){
            const response=await get(owned,jar);
            const login=where(response);
            expect(login.origin+login.pathname).toBe(origin+'/login');
            expect(login.searchParams.get('error')).toBe('assignment_account');
            expect(login.searchParams.get('returnUrl')).toBe(owned);
            expect(login.searchParams.has('prompt')).toBe(false);
        }
    });
    it('the matching account returns to its workspace, and a link without the tag keeps the earlier answer',async()=>{
        expect((await get(owned)).headers.get('location')).toBe(workspace);
        mocks.identity.mockImplementation(async()=>kept('auth0|someone-else'));
        expect((await get(embedded)).headers.get('location')).toBe(workspace);
    });
    it('the standalone return never reads the retained identity',async()=>{
        mocks.identity.mockRejectedValue(new Error('IDENTITY_REFRESH_REQUIRED'));
        expect((await get(returned)).headers.get('location')).toBe(universe+'/assignment/work/'+id);
        expect(mocks.identity).not.toHaveBeenCalled();
    });
    it('every answer is a private, unframeable redirect',async()=>{
        mocks.identity.mockRejectedValue(new Error('IDENTITY_REFRESH_REQUIRED'));
        for(const response of [await get(owned),await get(owned,cookie+'='+id)]){
            expect(response.status).toBe(303);
            expect(response.headers.get('cache-control')).toContain('no-store');
            expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
            expect(response.headers.get('referrer-policy')).toBe('no-referrer');
        }
    });
});
