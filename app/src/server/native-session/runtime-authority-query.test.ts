import { createHash, createHmac } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { deriveControlKey } from '@/server/lib/compute/aws-enroll';
import type { Placement } from '@/server/lib/compute/placement';
import { handleNativeRuntimeAuthorityQuery, RUNTIME_AUTHORITY_DOMAIN, RUNTIME_AUTHORITY_REPLY_DOMAIN } from './runtime-authority-query';
const id='11111111-1111-4111-8111-111111111111', req='22222222-2222-4222-8222-222222222222', now=new Date('2026-11-17T08:00:00.000Z');
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const secret='isolated-fixture-secret';
const placement={computerId:id,provider:'aws-ec2',generation:7,leaseEpoch:3,state:'RUNNING',enrollConsumedHash:'a'.repeat(64)} as Placement;
const key=deriveControlKey(secret,{computerId:id,generation:7,leaseEpoch:3,nonceHash:'a'.repeat(64)});
const mac=(parts:string[])=>'v1='+createHmac('sha256',key).update(parts.join('|')).digest('hex');
describe('private runtime authority envelope',()=>{
 it('rejects unauthenticated input before database readers',async()=>{
  const execute=vi.fn();const response=await handleNativeRuntimeAuthorityQuery(new Request('https://os.example/api',{method:'POST',body:'{}'}),
   {env:{CLOUDFLARE_GUACAMOLE_HMAC_SECRET:secret},db:{execute},aiPort:null,now:()=>now,placement:async()=>placement});
  expect(response.status).toBe(401);expect(execute).not.toHaveBeenCalled();
 });
 it('signs an exact-request-correlated refusal for a missing dispatch; never claims or writes',async()=>{
  const scope={authority:'control',ownerUserId:id,originalOAuthClientId:'fixture',sessionId:id,computerId:id,runtimeId:id,hostEpoch:'a'.repeat(32),
    placement:{generation:'7',leaseEpoch:'3',instanceId:'i-0123456789abcdef0',fenceToken:id},profile:'ezil-native-claude-v1',policyDigest:null,
    aiAuthorization:{authorizationId:id,state:'inactive',expiresAt:'2026-11-17T08:10:00.000Z',policyDigest:null},controlAuthorizationId:id,controlDeadline:'2026-11-17T08:10:00.000Z'};
  const raw=JSON.stringify({v:1,requestNonce:'a'.repeat(43),issuedAt:now.toISOString(),expiresAt:'2026-11-17T08:00:10.000Z',request:{v:'ezil-native-runtime-rpc/1',action:'cancel',scope,rootRequestId:req,requestDigest:'sha256:'+'b'.repeat(64),deadline:'2026-11-17T08:00:09.000Z',payload:{action:'cancel',targetRequestId:id}}});
  const ts=String(now.getTime()/1000),execute=vi.fn(async()=>[]);
  const response=await handleNativeRuntimeAuthorityQuery(new Request('https://os.example/api',{method:'POST',body:raw,headers:{'x-ezil-computer-id':id,'x-ezil-generation':'7','x-ezil-lease-epoch':'3','x-ezil-timestamp':ts,'x-ezil-signature':mac([RUNTIME_AUTHORITY_DOMAIN,ts,id,'7','3',sha(raw)])}}),
   {env:{CLOUDFLARE_GUACAMOLE_HMAC_SECRET:secret},db:{execute},aiPort:null,now:()=>now,placement:async()=>placement});
  expect(response.status).toBe(403);const reply=await response.text();expect(JSON.parse(reply).requestSha256).toBe(sha(raw));
  expect(response.headers.get('x-ezil-authority')).toBe(mac([RUNTIME_AUTHORITY_REPLY_DOMAIN,id,'7','3',sha(raw),sha(reply)]));
  expect(execute).toHaveBeenCalledTimes(1);
 });
});
