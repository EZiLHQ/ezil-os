import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ jar: new Map<string,string>(), claims: {sub:'os-user',session_id:'session-a'}, verify: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get:(k:string) => mocks.jar.has(k) ? {value:mocks.jar.get(k)} : undefined, set:(k:string,v:string) => mocks.jar.set(k,v) }) }));
vi.mock('@/utils/supabase/server', () => ({ createClient: async () => ({auth:{getClaims:async()=>({data:{claims:mocks.claims},error:null})}}) }));
vi.mock('@/server/auth/auth0', () => ({ verifyProjectIdToken: mocks.verify }));
import { retainProjectIdentity, retainedIdentity, launchGrant, clearProjectIdentity, vaults, LAUNCH_COOKIE } from './session';
import { validateRedemption, trustedOrigin } from './contract';
import { Vault } from './vault';
const value = () => ({binding:{projectId:'11111111-1111-4111-8111-111111111111', repositoryId:'22222222-2222-4222-8222-222222222222',canonicalURL:'https://github.ezil.work/acme/repo.git',ref:'refs/heads/main',bindingVersion:'a'.repeat(64)},identity:{issuer:'https://id.ezil.work/',subject:'auth0|a'},git:{username:'ezil',token:'egg_private_synthetic',expiresAt:new Date(Date.now()+60000).toISOString(),scope:'read'}});
beforeEach(()=> { mocks.jar.clear(); mocks.claims={sub:'os-user',session_id:'session-a'}; mocks.verify.mockResolvedValue({issuer:'https://id.ezil.work/',subject:'auth0|a',expiresAt:Date.now()+120000}); vi.stubEnv('PROJECT_REPO_WORKS_ORIGIN','https://works-staging.example.invalid'); });
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
describe('private identity and launch session',()=>{
    it('retains only an opaque browser handle and rejects a different session for the same user',async()=>{
        await retainProjectIdentity('private-id-token'); expect([...mocks.jar.values()].join('')).not.toContain('private-id-token');
        expect((await retainedIdentity('os-user')).subject).toBe('auth0|a');
        mocks.claims.session_id='session-b'; await expect(retainedIdentity('os-user')).rejects.toThrow('invalid_identity');
    });
    it('redeems once using v1.1 body only and binds repeat opens to the same computer/session',async()=>{
        await retainProjectIdentity('private-id-token');
        const handle=vaults.launches.put({code:'c'.repeat(43),deadline:Date.now()+60000},Date.now()+60000);mocks.jar.set(LAUNCH_COOKIE,handle);
        const fetcher=vi.fn(async()=>Response.json(value()));vi.stubGlobal('fetch',fetcher);
        const grant=await launchGrant('os-user','computer-a');expect(grant?.version).toBe(1);
        const [url,opts]=fetcher.mock.calls[0] as unknown as [URL,RequestInit];
        expect(url.origin).toBe('https://works-staging.example.invalid');expect(url.search).toBe('');
        expect(JSON.parse(opts.body as string)).toEqual({userIdToken:'private-id-token',code:'c'.repeat(43)});
        expect(opts.headers).toEqual({'content-type':'application/json'});
        expect(await launchGrant('os-user','computer-a')).toBe(grant);expect(fetcher).toHaveBeenCalledTimes(1);
        await expect(launchGrant('os-user','computer-b')).rejects.toThrow('not_authorized');
        mocks.claims.sub='foreign';await expect(launchGrant('foreign','computer-a')).rejects.toThrow('invalid_identity');
        await clearProjectIdentity(); expect(await launchGrant('foreign','computer-a')).toBeUndefined();
    });
    it('refusal consumes a pending code and never returns a partial grant',async()=>{
        await retainProjectIdentity('private');const h=vaults.launches.put({code:'c'.repeat(43),deadline:Date.now()+60000},Date.now()+60000);mocks.jar.set(LAUNCH_COOKIE,h);
        const f=vi.fn(async()=>Response.json({error:'project_repo_not_authorized'},{status:403}));vi.stubGlobal('fetch',f);
        await expect(launchGrant('os-user','a')).rejects.toThrow('not_authorized');
        await expect(launchGrant('os-user','a')).rejects.toThrow('not_authorized');expect(f).toHaveBeenCalledTimes(1);
    });
    it('validates identity, expiry, read scope, ref and canonical URL',()=>{
        const identity={token:'private',...value().identity,userId:'os-user',sessionId:'a',expiresAt:Date.now()+120000};
        expect(validateRedemption(value(),identity).git.scope).toBe('read');
        for(const bad of [ {...value(),identity:{...value().identity,subject:'other'}}, {...value(),git:{...value().git,scope:'write'}}, {...value(),git:{...value().git,expiresAt:new Date(Date.now()+300001).toISOString()}}, {...value(),binding:{...value().binding,ref:'refs/heads/../evil'}}, {...value(),binding:{...value().binding,canonicalURL:'https://evil.invalid/repo.git'}}]) expect(()=>validateRedemption(bad,identity)).toThrow();
    });
    it('rejects wildcard/lookalike caller origins and unbounded/expired vault entries',()=>{
        expect(trustedOrigin('https://universe2.ezil.work','https://universe2.ezil.work')).toBe(true);
        for(const origin of [null,'null','https://universe2.ezil.work.evil.invalid','http://universe2.ezil.work']) expect(trustedOrigin(origin,'https://universe2.ezil.work')).toBe(false);
        const v=new Vault<string>(1);const h=v.put('secret',200,100);expect(()=>v.put('second',200,100)).toThrow();expect(v.get(h,200)).toBeUndefined();expect(v.take(v.put('once',400,200),200)).toBe('once');
    });
});
