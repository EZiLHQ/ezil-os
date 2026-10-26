import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
vi.mock('server-only',()=>({}));
vi.mock('@/server/project-repositories/session', async()=> { const {Vault}=await import('@/server/project-repositories/vault');return {COOKIE_OPTIONS:{httpOnly:true,secure:true,sameSite:'lax',path:'/'}, LAUNCH_COOKIE:'__Host-ezil-project-launch',vaults:{launches:new Vault()}}; });
import { POST } from './route';
import { vaults } from '@/server/project-repositories/session';
const origin='https://universe2.ezil.work';
function req(body='code='+'c'.repeat(43), headers:Record<string,string>={},query='') {return new NextRequest('https://os-staging.ezil.work/api/project-repositories/launch'+query,{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded',...headers},body});}
beforeEach(()=>vi.stubEnv('PROJECT_REPO_CALLER_ORIGINS',origin));afterEach(()=>vi.unstubAllEnvs());
it('cross-site form stores code server-side and returns only opaque HttpOnly handle plus same-origin navigation',async()=>{
 const response=await POST(req());expect(response.status).toBe(303);expect(response.headers.get('location')).toBe('https://os-staging.ezil.work/api/project-repositories/continue');
 const cookie=response.cookies.get('__Host-ezil-project-launch')!;expect(cookie.value).toMatch(/^[\w-]{43}$/);expect(cookie.value).not.toBe('c'.repeat(43));expect(cookie.httpOnly).toBe(true);expect(cookie.sameSite).toBe('lax');expect(vaults.launches.get(cookie.value)?.code).toBe('c'.repeat(43));expect(response.headers.get('cache-control')).toBe('no-store');
});
it.each([['code='+'c'.repeat(42),{}],['code='+'c'.repeat(43)+'&code='+'a'.repeat(43),{}],['code='+'c'.repeat(43)+'&repo=evil',{}],['code='+'c'.repeat(43),{origin:'https://evil.invalid'}],['{}',{'content-type':'application/json'}],['code='+'c'.repeat(1000),{}]])('rejects malformed/untrusted form without storing an intent',async(body,headers)=>expect((await POST(req(body as string,headers as Record<string,string>))).status).toBe(400));
it('rejects query codes',async()=>expect((await POST(req(undefined,{},'?code=evil'))).status).toBe(400));
