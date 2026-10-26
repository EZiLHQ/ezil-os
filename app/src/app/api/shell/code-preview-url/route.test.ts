import { beforeEach, it, expect, vi } from 'vitest';
const mocks=vi.hoisted(()=>({events:[] as string[], user:{id:'os-user'} as {id:string}|null, owned:true, grant:vi.fn(), preview:vi.fn(),contexts:[] as any[]}));
vi.mock('@/server/project-repositories/session',()=>({launchGrant:async(...args:unknown[])=>{mocks.events.push('redeem');return mocks.grant(...args);}}));
vi.mock('@/server/api/trpc',()=>({createTRPCContext:async()=>({user:mocks.user,db:{},headers:new Headers()})}));
vi.mock('@/server/api/root',()=>({appRouter:{createCaller:(ctx:unknown)=>{mocks.contexts.push(ctx);return {computer:{get:async()=>{mocks.events.push('ownership');if(!mocks.owned)throw Error('not owned');return {id:'computer-a'};}},cloudflareGuacamole:{codePreviewUrl:mocks.preview}};}}}));
import { POST } from './route';
const request=(body:unknown)=>new Request('https://os-staging.ezil.work/api/shell/code-preview-url',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
beforeEach(()=>{mocks.events=[];mocks.contexts=[];mocks.user={id:'os-user'};mocks.owned=true;mocks.grant.mockReset();mocks.preview.mockReset().mockResolvedValue({ok:true,codePreviewUrl:'https://test.invalid/?folder=exact'});});
it('checks session and ownership before redemption, passes secret only in server context',async()=>{
 const grant={binding:{canonicalURL:'https://github.ezil.work/team/repo.git'},git:{token:'synthetic-private'}};mocks.grant.mockResolvedValue(grant);
 const response=await POST(request({computerId:'computer-a',projectLaunch:true}));expect(response.status).toBe(200);expect(mocks.events).toEqual(['ownership','redeem']);expect(mocks.contexts.at(-1).projectGrant).toBe(grant);expect(mocks.preview).toHaveBeenCalledWith({computerId:'computer-a',repo:grant.binding.canonicalURL});expect(await response.text()).not.toContain('synthetic-private');
});
it('foreign computer never redeems or opens, missing OS session never parses intent',async()=>{
 mocks.owned=false;await POST(request({computerId:'foreign',projectLaunch:true}));expect(mocks.grant).not.toHaveBeenCalled();expect(mocks.preview).not.toHaveBeenCalled();
 mocks.user=null;expect((await POST(request({computerId:'foreign',projectLaunch:true}))).status).toBe(401);
});
it('expired/missing launch state cannot open workspace root on refresh',async()=>{
 expect((await POST(request({computerId:'computer-a',projectLaunch:true}))).status).toBe(403);expect(mocks.preview).not.toHaveBeenCalled();
});
it('rejects caller repository substitution and surfaces a configuration refusal without credentials',async()=>{
 mocks.grant.mockResolvedValue({binding:{canonicalURL:'https://github.ezil.work/team/repo.git'}});expect((await POST(request({computerId:'computer-a',repo:'https://github.ezil.work/other/repo.git',projectLaunch:true}))).status).toBe(403);
 mocks.grant.mockRejectedValue(Error('project_repo_configuration_required'));expect((await POST(request({computerId:'computer-a',projectLaunch:true}))).status).toBe(503);expect(mocks.preview).not.toHaveBeenCalled();
});
