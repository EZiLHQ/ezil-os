import { expect, test } from 'bun:test';
import { deriveEditorBridgeToken, handleEditorBridgeRequest, signEditorBridgeSync } from './editor-bridge';

test('existing Worker forwards protocol3 bytes and negotiation without widening route or identity', async () => {
    const secret='synthetic-only',sandboxId='guac-bbbbbbbbbbbb4bbb-aaaaaaaaaaaa4aaa',nonce='synthetic-boot',now=1800000000000;
    const token=await deriveEditorBridgeToken(secret,sandboxId,nonce);
    const body=JSON.stringify({protocol:3,ownerId:'local',epoch:1,seq:1,sessions:[{resource:'local/a',effort:'high'}]});
    const sent:Request[]=[];
    const deps={secret,sandboxId,nonce,now:()=>now,osUrl:'https://os.invalid',log:()=>{},fetch:async(request:Request)=>{
        sent.push(request);return Response.json({ok:true,protocol:2,supportedProtocols:[1,2,3]});}};
    const request=()=>new Request('https://code.invalid/editor-bridge/v1/sync',{method:'POST',body,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'}});
    const response=await handleEditorBridgeRequest(request(),deps);
    expect(response.status).toBe(200);expect(await response.json()).toEqual({ok:true,protocol:2,supportedProtocols:[1,2,3]});
    expect(sent).toHaveLength(1);expect(await sent[0]!.clone().text()).toBe(body);
    expect(sent[0]!.headers.get('x-ezil-signature')).toBe(await signEditorBridgeSync(secret,String(now/1000),sandboxId,new TextEncoder().encode(body)));
    expect(sent[0]!.headers.get('authorization')).toBeNull();
    expect((await handleEditorBridgeRequest(request(),{...deps,nonce:'other-boot'})).status).toBe(401);
    expect(sent).toHaveLength(1);
});
