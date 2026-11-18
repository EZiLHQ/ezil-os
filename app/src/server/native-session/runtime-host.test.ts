import { describe, it, expect } from 'vitest';
import { callRuntimeHost } from './runtime-host';
import type { RuntimeRpcRequest } from './runtime-contract';
const id='11111111-1111-4111-8111-111111111111';
const request: RuntimeRpcRequest={v:'ezil-native-runtime-rpc/1',action:'cancel',scope:{authority:'control',ownerUserId:id,
 originalOAuthClientId:'fixture',sessionId:id,computerId:id,runtimeId:id,hostEpoch:'a'.repeat(32),placement:{generation:'7',leaseEpoch:'3',instanceId:'i-0123456789abcdef0',fenceToken:id},
 profile:'ezil-native-claude-v1',policyDigest:null,aiAuthorization:{authorizationId:id,state:'inactive',expiresAt:'2026-11-17T10:00:00.000Z',policyDigest:null},
 controlAuthorizationId:id,controlDeadline:'2026-11-17T10:00:00.000Z'},rootRequestId:id,requestDigest:'sha256:'+'b'.repeat(64),deadline:'2026-11-17T10:00:00.000Z',payload:{action:'cancel',targetRequestId:'22222222-2222-4222-8222-222222222222'}};
describe('native runtime uncertainty',()=>{
 it('preserves host timeout from edge through OS channel parsing',async()=>{
  expect(await callRuntimeHost({available:true,call:async()=>({kind:'reply',body:JSON.stringify({v:request.v,outcome:'unknown',reason:'host_timeout'})})},request,1000)).toEqual({kind:'unknown',reason:'host_timeout'});
 });
});
