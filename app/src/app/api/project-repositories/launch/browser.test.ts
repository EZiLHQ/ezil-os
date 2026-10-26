import { it, expect, vi } from 'vitest';
import { createServer } from 'node:https';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { NextRequest } from 'next/server';
vi.mock('server-only',()=>({}));
// Isolated HTTPS test listeners; production owned-origin validation is covered separately.
vi.mock('@/utils/forwarded',()=>({ownedPublicOrigin:(_headers:unknown,fallback:string)=>new URL(fallback).origin}));
vi.mock('@/server/project-repositories/session', async()=> { const {Vault}=await import('@/server/project-repositories/vault');return {COOKIE_OPTIONS:{httpOnly:true,secure:true,sameSite:'lax',path:'/'},LAUNCH_COOKIE:'__Host-ezil-project-launch',vaults:{launches:new Vault()}}; });
import { POST } from './route';
const binary=process.env.EZIL_TEST_CHROMIUM;
it.skipIf(!binary)('real Chromium: origin-only form passes, null Origin fails, Lax session returns only after same-origin navigation',async()=>{
 const root=mkdtempSync(join(tmpdir(),'os-origin-browser-'));
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(root,'key'),'-out',join(root,'cert'),'-days','1','-subj','/CN=localhost'],{stdio:'ignore'});
 const tls={key:readFileSync(join(root,'key')),cert:readFileSync(join(root,'cert'))};
 let osOrigin='',callerOrigin='',policy='origin';let seen:{origin?:string;cookie?:string;status:number}[]=[];let afterCookie='';
 const os=createServer(tls,async(req,res)=>{
  if(req.url==='/seed'){res.writeHead(302,{'set-cookie':'__Host-test-session=synthetic; Secure; HttpOnly; SameSite=Lax; Path=/','location':callerOrigin});return res.end();}
  if(req.url==='/api/project-repositories/launch'){
   let body='';for await(const chunk of req)body+=chunk;
   const response=await POST(new NextRequest(osOrigin+req.url,{method:'POST',headers:req.headers as Record<string,string>,body}));
   seen.push({origin:req.headers.origin,cookie:req.headers.cookie,status:response.status});res.writeHead(response.status,Object.fromEntries(response.headers));return res.end(await response.text());
  }
  afterCookie=req.headers.cookie??'';res.end('<html>complete</html>');
 });
 const caller=createServer(tls,(_req,res)=>{res.writeHead(200,{'content-type':'text/html','referrer-policy':policy});res.end(`<form method="POST" action="${osOrigin}/api/project-repositories/launch"><input name="code" value="${'c'.repeat(43)}"></form><script>document.forms[0].submit()</script>`);});
 try{
  await new Promise<void>(r=>os.listen(0,'127.0.0.1',r));await new Promise<void>(r=>caller.listen(0,'127.0.0.1',r));
  osOrigin=`https://localhost:${(os.address() as any).port}`;callerOrigin=`https://127.0.0.1:${(caller.address() as any).port}`;
  vi.stubEnv('PROJECT_REPO_CALLER_ORIGINS',callerOrigin);
  for(const p of ['origin','no-referrer']){
   policy=p;seen=[];afterCookie='';
   await promisify(execFile)(binary!,['--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--ignore-certificate-errors','--no-proxy-server',`--user-data-dir=${join(root,p)}`,'--dump-dom','--virtual-time-budget=3000',osOrigin+'/seed'],{timeout:20000,maxBuffer:1048576});
   expect(seen).toHaveLength(1);expect(seen[0].cookie??'').not.toContain('__Host-test-session');
   if(p==='origin'){expect(seen[0].origin).toBe(callerOrigin);expect(seen[0].status).toBe(303);expect(afterCookie).toContain('__Host-test-session=synthetic');expect(afterCookie).toContain('__Host-ezil-project-launch=');}
   else{expect(seen[0].origin).toBe('null');expect(seen[0].status).toBe(400);}
  }
 }finally{vi.unstubAllEnvs();os.closeAllConnections();caller.closeAllConnections();await Promise.all([new Promise(r=>os.close(r)),new Promise(r=>caller.close(r))]);rmSync(root,{recursive:true,force:true});}
},45000);
