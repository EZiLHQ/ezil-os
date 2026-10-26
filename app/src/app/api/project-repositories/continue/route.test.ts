import { it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
const mocks=vi.hoisted(()=>({resolve:vi.fn(),identity:vi.fn(),bind:vi.fn()}));
vi.mock('@/server/project-repositories/session',()=>({resolveLaunchIntent:mocks.resolve,retainedIdentity:mocks.identity,bindLaunchIdentity:mocks.bind}));
import { POST } from './route';
const origin='https://os-staging.ezil.work';
function request(body='intentId='+'a'.repeat(43),headers:Record<string,string>={}) {return new NextRequest(origin+'/api/project-repositories/continue',{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded',...headers},body});}
beforeEach(()=>{mocks.resolve.mockReset().mockResolvedValue({});mocks.identity.mockReset().mockResolvedValue({userId:'a',sessionId:'session-a'});mocks.bind.mockReset().mockResolvedValue({});});
it('binds the explicit document intent to the authenticated session before navigating without any ID in the URL',async()=>{
 const response=await POST(request());expect(response.status).toBe(303);expect(mocks.resolve).toHaveBeenCalledWith('a'.repeat(43));expect(mocks.bind).toHaveBeenCalledWith('a'.repeat(43),{userId:'a',sessionId:'session-a'});expect(response.headers.get('location')).toBe(origin+'/os?app=code&projectLaunch=1');
});
it('refuses a correlation/proof mismatch and never selects another cookie',async()=>{mocks.resolve.mockRejectedValue(Error('mismatch'));expect((await POST(request())).status).toBe(403);expect(mocks.bind).not.toHaveBeenCalled();});
it('refuses an intent already bound to another session',async()=>{mocks.bind.mockRejectedValue(Error('mismatch'));expect((await POST(request())).status).toBe(403);});
it('uses existing SSO when identity is missing and retains no intent or code in return URL',async()=>{mocks.identity.mockRejectedValue(Error('no session'));const r=await POST(request());expect(r.status).toBe(303);expect(r.headers.get('location')).toContain('/auth/auth0/login?returnUrl=');expect(r.headers.get('location')).not.toContain('a'.repeat(43));expect(mocks.bind).not.toHaveBeenCalled();});
const invalidHeaders: Record<string,string>[] = [{origin:'null'},{origin:'https://evil.invalid'},{'content-type':'application/json'}];
it.each(invalidHeaders)('rejects an invalid continuation origin/type',async headers=>{expect((await POST(request(undefined,headers))).status).toBe(400);expect(mocks.resolve).not.toHaveBeenCalled();});
