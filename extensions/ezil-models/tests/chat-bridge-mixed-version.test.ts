// Actual pinned legacy source, not fake old hello replies. All OS HTTP is synthetic.
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { ChatBridgeClient } from '../src/chat-bridge-client';
const root=path.resolve(import.meta.dir,'../../..');
const OLD='92cdb3d412fb13c3a7a4b0bbc6885542b564b022';
const show=(file:string)=>execFileSync('git',['show',`${OLD}:${file}`],{cwd:root,encoding:'utf8'});
const oldSource=new Bun.Transpiler({loader:'ts'}).transformSync(show('extensions/ezil-models/src/chat-bridge-client.ts'));
const OldClient=new Function(oldSource.replace(/^export /gm,'')+'; return ChatBridgeClient;')();
const req=createRequire(import.meta.url);
function world(legacy:boolean) {
    const file=path.join(root,'worker/copilot-chat/chat-bridge-fake.cjs');
    const fake=readFileSync(file,'utf8'), module={exports:{} as any};
    const load=(id:string)=>id==='node:fs' && legacy ? {...req(id),readFileSync:(p:string,...args:any[])=>String(p).endsWith('chat-bridge.js')?show('worker/copilot-chat/chat-bridge.js'):req(id).readFileSync(p,...args)}:req(id);
    new Function('require','module','exports','__dirname',fake)(load,module,module.exports,path.dirname(file));
    return module.exports.world();
}
for(const [name,Client,legacy,expected] of [['old client + new workbench',OldClient,false,2],['new client + old workbench',ChatBridgeClient,true,2],['new client + new workbench',ChatBridgeClient,false,3]] as const) {
    test(name,async()=>{
        const w=world(legacy), bodies:any[]=[],calls:any[]=[];
        const client=new Client({syncUrl:'https://synthetic.invalid/editor-bridge/v1/sync',token:'synthetic-only',ownerId:'mixed-test',log:()=>{},
            execute:async(r:any)=>{calls.push(r);return w.bridge.handle(r);},
            fetch:async(_url:any,init:any)=>{bodies.push(JSON.parse(String(init.body)));return Response.json({ok:true,protocol:2,supportedProtocols:[1,2,3],owner:'self',epoch:1,pollMs:2000,deliver:bodies.length===2?[{kind:'create',operationId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',attemptId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',deliverWithinMs:60000,model:'ezil/qwen'}]:[]});}});
        await client.tick();await client.tick();
        expect(bodies).toHaveLength(2);expect(bodies.map(b=>b.protocol)).toEqual([1,expected]);
        expect(bodies[0]).not.toHaveProperty('sessions');expect(bodies[0]).not.toHaveProperty('supportedProtocols');
        if(expected===2) {
            expect(bodies[1].sessions[0]).not.toHaveProperty('effort');
            expect(bodies[1].catalog.models[0].efforts).toEqual([]);
            expect(calls.some(r=>r.protocol===3)).toBe(false);
        } else expect(bodies[1].sessions[0]).toHaveProperty('effort',null);
        if(!legacy) {
            const result=await w.bridge.handle({op:'sessions',ownerId:'mixed-test',epoch:1});
            expect(result.sessions[0]).not.toHaveProperty('effort');
            expect(await w.bridge.handle({op:'setModel',ownerId:'mixed-test',epoch:1,effort:'high'}))
                .toMatchObject({status:'rejected',reason:'effort_not_per_session'});
        }
        await client.tick();
        expect(bodies[2].reports[0]).toMatchObject({status:'applied',model:'ezil/qwen',requestCount:0});
        if(expected===2) expect(bodies[2].reports[0]).not.toHaveProperty('effort');
        else expect(bodies[2].reports[0]).toHaveProperty('effort',null);
        w.bridge.dispose();
    });
}
