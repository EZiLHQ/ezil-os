import assert from 'node:assert/strict';
import test from 'node:test';
import {openWithAssignmentConsent} from './shell.js';
const id='2d5fd5d2-ad3e-47ea-9a95-60eb51bce32a';
const repo='https://github.ezil.work/default/u-0123456789abcdef-a-'+id+'.git';
class Element{
    children=[];hidden=false;isConnected=true;
    setAttribute(name,value){this[name]=value;} append(...children){this.children.push(...children);} querySelector(){return null;}
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
test('embedded OS never activates even a valid canonical assignment',async(t)=>{
    const fetch=t.mock.method(globalThis,'fetch',async()=>{throw Error('unexpected network');});
    const f=fixture('https://os-staging.ezil.work/app/code?repo='+encodeURIComponent(repo)+'&assignment='+id,{repoUrl:repo});
    await new Promise(r=>setImmediate(r));
    assert.equal(f.gate.locked(),true);assert.equal(fetch.mock.callCount(),0);assert.deepEqual(f.counts(),[0,0]);
    await f.gate.close();
});
test('the native Stop during a delayed private checkout cannot later start media or release Code',async(t)=>{
    const requests=[],elements=[];
    t.mock.method(globalThis,'fetch',async(_path,options)=>{
        // The server clock is asked for on its own schedule (`clock`); `requests` is the recording protocol only.
        const body=JSON.parse(options.body);if(body.action!=='clock')requests.push(body.action);
        return Response.json({status:'eligible',attemptId:id,repositoryUrl:repo,expiresAt:new Date(Date.now()+60000).toISOString()});
    });
    let handle,resolveCheckout,releasePreparing,opened=0;
    const preparing=new Promise(r=>releasePreparing=r);
    const checkout=new Promise(r=>resolveCheckout=r);
    class Track{
        readyState='live';muted=false;listeners={};
        getCaptureHandle(){return {origin:'https://os-staging.ezil.work',handle};}
        getSettings(){return {displaySurface:'browser'};}
        addEventListener(n,f){this.listeners[n]=f;} stop(){this.readyState='ended';}
    }
    const track=new Track(),stream={getTracks:()=>[track],getVideoTracks:()=>[track],getAudioTracks:()=>[]};
    const body=new Element(),doc={body,createElement(tag){const e=new Element();e.tag=tag;elements.push(e);return e;}};
    const win={location:new URL('https://os-staging.ezil.work/app/code?repo='+encodeURIComponent(repo)+'&assignment='+id),crypto:globalThis.crypto,
        isSecureContext:true,document:doc,addEventListener(){},removeEventListener(){},MediaStreamTrack:Track,VideoFrame:class{},VideoEncoder:class{},
        navigator:{mediaDevices:{setCaptureHandleConfig(config){handle=config.handle;},getDisplayMedia:async()=>stream}}};
    win.top=win;win.parent=win;Object.assign(globalThis,{window:win,document:doc});
    const gate=openWithAssignmentConsent({project:{repoUrl:repo},actor:()=>'owner',computerId:'fixture',body:new Element(),
        park(){},open(){opened++;},prepare(){releasePreparing();return checkout;}});
    try{
        await new Promise(r=>setImmediate(r));
        const button=elements.find(e=>e.textContent==='Share this OS tab and open assignment');
        assert.ok(button);button.onclick({isTrusted:false});await Promise.resolve();assert.deepEqual(requests,['preflight']);
        button.onclick({isTrusted:true});await preparing;
        track.listeners.ended();assert.equal(gate.locked(),true);
        const workspaceFolder='/workspace',checkoutFolder=workspaceFolder+'/'+repo.split('/').at(-1).slice(0,-4);
        resolveCheckout({ok:true,repository:{id:'test',workspaceFolder,checkoutFolder},assignmentOpen:{attemptId:id,proof:'x'.repeat(60)}});
        await new Promise(r=>setImmediate(r));
        assert.equal(track.readyState,'ended');assert.deepEqual(requests,['preflight']);assert.equal(opened,0);assert.equal(gate.access(),null);
    }finally{await gate.close();}
});


test('verified production placement gates the picker and ordinary Code is unaffected',async t=>{
    const upgradedWorkspaceId='a'.repeat(64),upgradeOperationId='9bb4a746-14a6-4dec-9f3e-fbb971356ff2';
    let upgrade={};
    t.mock.method(globalThis,'fetch',async()=>Response.json({status:'eligible',attemptId:id,repositoryUrl:repo,
        expiresAt:new Date(Date.now()+60000).toISOString(),...upgrade}));
    for (const [provider, proof, consent] of [
        ['aws-ec2',{},false],
        ['aws-ec2',{upgradedWorkspaceId},false],
        [null,{upgradedWorkspaceId,upgradeOperationId},false],
        ['aws-ec2',{upgradedWorkspaceId,upgradeOperationId},true],
        ['aws-ec2',{boundWorkspaceId:null},true],
        ['aws-ec2',{boundWorkspaceId:null,windowStartedAt:new Date(Date.now()-1000).toISOString(),deadlineAt:new Date(Date.now()+60000).toISOString()},false],
        ['aws-ec2',{boundWorkspaceId:'b'.repeat(64),windowStartedAt:new Date(Date.now()-1000).toISOString(),deadlineAt:new Date(Date.now()+60000).toISOString()},true],
        ['aws-ec2',{boundWorkspaceId:'b'.repeat(63)},false],
        [null,{boundWorkspaceId:null},false],
        ['cloudflare',{},true],
    ]) {
        upgrade=proof;
        const texts=[],doc={createElement(){const e=new Element();Object.defineProperty(e,'textContent',{set:v=>texts.push(v)});return e;}};
        const win={location:new URL('https://os.ezil.work/app/code?repo='+encodeURIComponent(repo)+'&assignment='+id),
            addEventListener(){},removeEventListener(){},document:doc,crypto:globalThis.crypto,isSecureContext:true,
            navigator:{mediaDevices:{getDisplayMedia(){},setCaptureHandleConfig(){}}},VideoFrame:class{},VideoEncoder:class{},
            MediaStreamTrack:class{getCaptureHandle(){}}};
        win.top=win;Object.assign(globalThis,{window:win,document:doc});
        let opens=0,prepares=0;
        const gate=openWithAssignmentConsent({project:{repoUrl:repo},actor:()=>'owner',computerId:'self',body:new Element(),
            park(){},open(){opens++;},prepare(){prepares++;},computerProvider:async()=>provider});
        await new Promise(r=>setImmediate(r));
        assert.equal(texts.includes('Choose an assignment-ready computer'),!consent);
        assert.equal(texts.includes('Share this OS tab and open assignment'),consent);assert.equal(gate.locked(),true);
        assert.equal(opens,0);assert.equal(prepares,0);await gate.close();
    }
});

test('an assignment sign-in refresh keeps the selected computer, repository and attempt',async t=>{
    const assigned=[],elements=[];
    const computerId='11111111-1111-4111-8111-111111111111';
    const origin='https://os.ezil.work';
    const location=Object.assign(new URL(origin+'/app/code?'+new URLSearchParams({repo,assignment:id,computer:computerId})),
        {assign:target=>assigned.push(target)});
    const doc={createElement(){const element=new Element();elements.push(element);return element;}};
    const win={location,document:doc,addEventListener(){},removeEventListener(){}};
    win.top=win;
    Object.assign(globalThis,{window:win,document:doc});
    t.mock.method(globalThis,'fetch',async()=>Response.json({error:{code:'identity_refresh_required'}},{status:409}));
    const gate=openWithAssignmentConsent({project:{repoUrl:repo},actor:()=>'owner',computerId,body:new Element(),
        park(){},open(){assert.fail('editor must stay closed');},prepare(){assert.fail('checkout must stay closed');}});
    try{
        await new Promise(r=>setImmediate(r));
        const signIn=elements.find(element=>typeof element.onclick==='function'&&element.textContent==='Sign in to EZiL OS');
        assert.ok(signIn);
        signIn.onclick({isTrusted:false});
        assert.deepEqual(assigned,[]);
        signIn.onclick({isTrusted:true});
        const login=new URL(assigned[0],origin);
        assert.equal(login.pathname,'/auth/auth0/login');
        const back=new URL(login.searchParams.get('returnUrl'),origin);
        assert.equal(back.pathname,'/app/code');
        assert.deepEqual([...back.searchParams],[['repo',repo],['assignment',id],['computer',computerId]]);
    }finally{await gate.close();}
});
