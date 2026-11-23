import assert from 'node:assert/strict';
import test from 'node:test';
import {openWithAssignmentConsent} from './shell.js';
const id='2d5fd5d2-ad3e-47ea-9a95-60eb51bce32a';
const repo='https://github.ezil.work/default/u-0123456789abcdef-a-'+id+'.git';
class Element{
    children=[];hidden=false;isConnected=true;
    setAttribute(){} append(...children){this.children.push(...children);} querySelector(){return null;}
    remove(){this.isConnected=false;}
}
function fixture(url,project,who='owner'){
    const top={},win={location:new URL(url),top,parent:top,addEventListener(){},removeEventListener(){}};
    Object.assign(globalThis,{window:win,document:{createElement:()=>new Element()}});
    const locks=[];let open=0,prepare=0;
    const gate=openWithAssignmentConsent({project,actor:()=>who,computerId:'fixture',body:new Element(),
        park:locked=>locks.push(locked),open:()=>open++,prepare:()=>prepare++});
    return {gate,locks,counts:()=>[open,prepare]};
}
test('mismatched, unresolved or signed-out assignment routes cannot mint Code, including duplicate launches',async()=>{
    const href='https://os-staging.ezil.work/app/code?repo='+encodeURIComponent(repo)+'&assignment='+id;
    for(const [url,project,who] of [
        [href.replace('assignment='+id,'assignment=eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),{repoUrl:repo},'owner'],
        [href,{repoUrl:repo},null],
        [href,{repoUrl:'https://github.ezil.work/default/previous-checkout.git'},'owner'],
        [href,null,'owner'],
        ['https://os-staging.ezil.work/app/code?assignment='+id+'&repo='+encodeURIComponent('https://github.ezil.work/default/not-the-assignment.git'),{repoUrl:'https://github.ezil.work/default/not-the-assignment.git'},'owner'],
    ]){
        const f=fixture(url,project,who);await Promise.resolve();
        assert.equal(f.gate.locked(),true);assert.equal(f.gate.access(),null);assert.deepEqual(f.counts(),[0,0]);
        assert.ok(f.locks.every(Boolean));await f.gate.close();
    }
});
test('ordinary repository continues through the normal Code launch without media control',async()=>{
    const ordinary='https://github.ezil.work/default/ordinary.git';
    const f=fixture('https://os-staging.ezil.work/app/code?repo='+encodeURIComponent(ordinary),{repoUrl:ordinary});
    await Promise.resolve();assert.equal(f.gate,null);assert.deepEqual(f.counts(),[1,0]);assert.deepEqual(f.locks,[]);
});
test('a share stopped during private checkout cannot later call begin or unlock the editor',async(t)=>{
    const protocol='ezil.assignment.work/v2', universe='https://universe-staging.ezil.work';
    const phase='2d5fd5d2-ad3e-47ea-9a95-60eb51bce329', replies=[], actions=[];
    const requests=[];
    t.mock.method(globalThis,'fetch',async(_path,options)=>{
        const body=JSON.parse(options.body);requests.push(body.action);
        return Response.json({status:'eligible',attemptId:id,repositoryUrl:repo,expiresAt:new Date(Date.now()+60000).toISOString()});
    });
    let message,completeCheckout,preparing,opened=0;
    const checkoutStarted=new Promise(resolve=>{preparing=resolve;});
    const checkout=new Promise(resolve=>{completeCheckout=resolve;});
    const top={postMessage(data){actions.push(data.type);}};
    const win={location:new URL('https://os-staging.ezil.work/app/code?repo='+encodeURIComponent(repo)+'&assignment='+id),
        top,parent:top,addEventListener(type,fn){if(type==='message')message=fn;},removeEventListener(){}};
    Object.assign(globalThis,{window:win,document:{createElement:()=>new Element()}});
    const gate=openWithAssignmentConsent({project:{repoUrl:repo},computerId:'fixture',actor:()=>'owner',body:new Element(),
        park(){},open(){opened++;},prepare(){preparing();return checkout;}});
    const port={postMessage(data){replies.push(data);},start(){},close(){}};
    const discover={source:top,origin:universe,data:{type:'discover',protocol,challenge:phase,attemptId:id}};
    try{
        await new Promise(resolve=>setImmediate(resolve));message(discover);
        assert.deepEqual(actions,['available']);
        message({...discover,data:{...discover.data,type:'bind'},ports:[port]});
        const data={protocol,attemptId:id,captureSessionId:phase};
        port.onmessage({data:{...data,type:'request',method:'begin',id:1,consentVersion:4}});
        await checkoutStarted;
        port.onmessage({data:{...data,type:'lock'}});
        const workspaceFolder='/workspace',checkoutFolder=workspaceFolder+'/'+repo.split('/').at(-1).slice(0,-4);
        completeCheckout({ok:true,repository:{id:'test',workspaceFolder,checkoutFolder},assignmentOpen:{attemptId:id,proof:'x'.repeat(60)}});
        await new Promise(resolve=>setImmediate(resolve));
        assert.equal(replies.find(v=>v.id===1)?.ok,false);
        assert.deepEqual(requests,['preflight']);assert.equal(opened,0);
        assert.equal(gate.access(),null);assert.equal(gate.locked(),true);
    }finally{await gate.close();}
});
