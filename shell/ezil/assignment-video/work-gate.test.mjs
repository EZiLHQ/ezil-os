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
        const body=JSON.parse(options.body);requests.push(body.action);
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
function consentWindow(url){
    const elements=[],assigned=[],opened=[];let handle;
    class Track{
        readyState='live';muted=false;listeners={};
        getCaptureHandle(){return {origin:'https://os-staging.ezil.work',handle};}
        getSettings(){return {displaySurface:'browser'};}
        addEventListener(n,f){this.listeners[n]=f;} stop(){this.readyState='ended';}
    }
    const track=new Track(),stream={getTracks:()=>[track],getVideoTracks:()=>[track],getAudioTracks:()=>[]};
    const doc={body:new Element(),createElement(tag){const e=new Element();e.tag=tag;elements.push(e);return e;}};
    const location=Object.assign(new URL(url),{assign:target=>assigned.push(target)});
    const win={location,open:(...args)=>opened.push(args),crypto:globalThis.crypto,isSecureContext:true,document:doc,addEventListener(){},removeEventListener(){},
        MediaStreamTrack:Track,VideoFrame:class{},VideoEncoder:class{},
        navigator:{mediaDevices:{setCaptureHandleConfig(config){handle=config.handle;},getDisplayMedia:async()=>stream}}};
    win.top=win;win.parent=win;Object.assign(globalThis,{window:win,document:doc});
    const button=label=>elements.find(e=>typeof e.onclick==='function'&&e.textContent===label);
    return {elements,assigned,opened,track,button};
}
const entry='https://os-staging.ezil.work/app/code?repo='+encodeURIComponent(repo)+'&assignment='+id;
const eligibleBody=extra=>({status:'eligible',attemptId:id,repositoryUrl:repo,expiresAt:new Date(Date.now()+60000).toISOString(),
    windowStartedAt:null,deadlineAt:null,...extra});
test('a Creator-link refusal keeps the editor closed and offers a trusted route back to Universe',async t=>{
    const requests=[];
    t.mock.method(globalThis,'fetch',async(_path,options)=>{
        requests.push(JSON.parse(options.body).action);
        return Response.json({error:{code:'assignment_video_creator_unlinked'}},{status:409});
    });
    const w=consentWindow(entry);
    const gate=openWithAssignmentConsent({project:{repoUrl:repo},actor:()=>'owner',computerId:'fixture',body:new Element(),
        park(){},open(){assert.fail('editor must stay closed');},prepare(){assert.fail('checkout must stay closed');}});
    try{
        await new Promise(r=>setImmediate(r));
        assert.ok(w.elements.some(e=>e.textContent==='The Creator needs to connect EZiL ID'));
        assert.ok(w.elements.some(e=>e.textContent?.includes('verified EZiL ID')));
        assert.equal(w.button('Share this OS tab and open assignment'),undefined);
        assert.equal(w.button('Retry verification'),undefined);
        const back=w.button('Return to Universe jobs');
        assert.ok(back);
        back.onclick({isTrusted:false});assert.deepEqual(w.opened,[]);
        back.onclick({isTrusted:true});
        assert.deepEqual(w.opened,[['https://universe-staging.ezil.work/builder-jobs','_self','noreferrer']]);
        assert.deepEqual(requests,['preflight']);
        assert.equal(gate.locked(),true);assert.equal(gate.access(),null);
    }finally{await gate.close();}
});
test('an AWS computer needs Universe\'s explicit binding answer; every other provider keeps its own path',async t=>{
    const bound='b'.repeat(64),now=Date.now();
    const window=(from,until)=>({windowStartedAt:new Date(now-from).toISOString(),deadlineAt:new Date(now+until).toISOString()});
    for(const [provider,proof,opens] of [
        ['aws-ec2',{boundWorkspaceId:null},true],
        ['aws-ec2',{boundWorkspaceId:null,...window(1000,60000)},true],
        ['aws-ec2',{boundWorkspaceId:null,...window(1000,3600000)},false],
        ['aws-ec2',{boundWorkspaceId:null,windowStartedAt:new Date(now-1000).toISOString(),deadlineAt:null},false],
        ['aws-ec2',{boundWorkspaceId:bound,...window(1000,60000)},true],
        ['aws-ec2',{boundWorkspaceId:'b'.repeat(63)},false],
        ['aws-ec2',{},false],
        ['aws-ec2',{upgradedWorkspaceId:bound,upgradeOperationId:'11111111-1111-4111-8111-111111111111'},true],
        ['aws-ec2',{upgradedWorkspaceId:bound},false],
        ['cloudflare',{},true],
        [null,{},true],
    ]){
        t.mock.method(globalThis,'fetch',async()=>Response.json(eligibleBody(proof)));
        const w=consentWindow(entry);
        const gate=openWithAssignmentConsent({project:{repoUrl:repo},actor:()=>'owner',computerId:'fixture',body:new Element(),
            computerProvider:async()=>provider,park(){},open(){assert.fail('editor must stay closed');},prepare(){assert.fail('checkout must stay closed');}});
        try{
            await new Promise(r=>setImmediate(r));
            assert.equal(Boolean(w.button('Share this OS tab and open assignment')),opens,JSON.stringify([provider,proof]));
            assert.equal(Boolean(w.button('Check this computer again')),!opens);
            assert.equal(gate.locked(),true);assert.equal(gate.access(),null);
        }finally{await gate.close();t.mock.restoreAll();}
    }
});
test('an unreadable provider does not block a share the server will decide',async t=>{
    t.mock.method(globalThis,'fetch',async()=>Response.json(eligibleBody({})));
    const w=consentWindow(entry);
    const gate=openWithAssignmentConsent({project:{repoUrl:repo},actor:()=>'owner',computerId:'fixture',body:new Element(),
        computerProvider:async()=>{throw new Error('offline');},park(){},open(){},prepare(){}});
    try{
        await new Promise(r=>setImmediate(r));
        assert.ok(w.button('Share this OS tab and open assignment'));
    }finally{await gate.close();}
});
test('an assignment sign-in refresh keeps the selected computer, repository and attempt',async t=>{
    const computerId='11111111-1111-4111-8111-111111111111';
    t.mock.method(globalThis,'fetch',async()=>Response.json({error:{code:'identity_refresh_required'}},{status:409}));
    const w=consentWindow(entry+'&computer='+computerId);
    const gate=openWithAssignmentConsent({project:{repoUrl:repo},actor:()=>'owner',computerId,body:new Element(),
        park(){},open(){assert.fail('editor must stay closed');},prepare(){assert.fail('checkout must stay closed');}});
    try{
        await new Promise(r=>setImmediate(r));
        const signIn=w.button('Sign in to EZiL OS');
        assert.ok(signIn);
        signIn.onclick({isTrusted:false});
        assert.deepEqual(w.assigned,[]);
        signIn.onclick({isTrusted:true});
        const login=new URL(w.assigned[0],'https://os-staging.ezil.work');
        assert.equal(login.pathname,'/auth/auth0/login');
        const back=new URL(login.searchParams.get('returnUrl'),'https://os-staging.ezil.work');
        assert.equal(back.pathname,'/app/code');
        assert.deepEqual([...back.searchParams],[['repo',repo],['assignment',id],['computer',computerId]]);
    }finally{await gate.close();}
});
test('a mismatched assignment account offers explicit sign-in and preserves the exact link',async t=>{
    const origin='https://os-staging.ezil.work';
    const signedRepo=repo.replace('https:', 'https%3A');
    const actions=[];
    const assigned=[];
    const requests=[];
    const doc={createElement(){const element=new Element();actions.push(element);return element;}};
    t.mock.method(globalThis,'fetch',async(_path,options)=>{
        requests.push({ body:JSON.parse(options.body), repositoryUrl:options.headers['X-Ezil-Assignment-Repository'] });
        return Response.json({error:{code:'assignment_identity_mismatch'}},{status:409});
    });
    for (const path of ['/app/code?repo='+signedRepo,
        '/app/code?computer='+id+'&repo='+signedRepo+'&assignment='+id+'#workspace']) {
        const location=Object.assign(new URL(origin+path),{assign:target=>assigned.push(target)});
        const win={location,document:doc,addEventListener(){},removeEventListener(){}};
        win.top=win;
        Object.assign(globalThis,{window:win,document:doc});
        const gate=openWithAssignmentConsent({project:{repoUrl:repo},actor:()=>'owner',computerId:id,body:new Element(),
            park(){},open(){assert.fail('editor must stay closed');},prepare(){assert.fail('checkout must stay closed');}});
        try {
            await new Promise(r=>setImmediate(r));
            assert.ok(actions.some(e=>e.textContent==='Use the same EZiL ID you used on Universe.'));
            const signIn=actions.findLast(e=>typeof e.onclick==='function'&&e.textContent==='Sign in to EZiL OS');
            assert.ok(signIn);
            assert.equal(gate.locked(),true);
            assert.equal(gate.access(),null);
            const before=assigned.length;
            signIn.onclick({isTrusted:false});
            assert.equal(assigned.length,before);
            signIn.onclick({isTrusted:true});
            const login=new URL(assigned.at(-1),origin);
            assert.equal(login.pathname,'/auth/auth0/login');
            assert.equal(login.searchParams.get('prompt'),'login');
            assert.equal(login.searchParams.get('returnUrl'),path);
        } finally {
            await gate.close();
        }
    }
    const preflight={body:{action:'preflight',attemptId:id},repositoryUrl:repo};
    assert.deepEqual(requests,[preflight,preflight]);
});
test('a stopped share never asks the checkout again and aborts only its own mint',async t=>{
    t.mock.method(globalThis,'fetch',async()=>Response.json(eligibleBody({})));
    const w=consentWindow(entry);
    let prepares=0,signal,release;
    const first=new Promise(r=>release=r);
    const gate=openWithAssignmentConsent({project:{repoUrl:repo},actor:()=>'owner',computerId:'fixture',body:new Element(),
        park(){},open(){assert.fail('editor must stay closed');},
        async prepare(_id,options){prepares++;signal=options?.signal;release();await new Promise(r=>setTimeout(r,20));
            throw Object.assign(new Error('prepare_failed'),{code:'sandbox_starting'});}});
    try{
        await new Promise(r=>setImmediate(r));
        w.button('Share this OS tab and open assignment').onclick({isTrusted:true});
        await first;
        assert.equal(signal.aborted,false);
        w.track.listeners.ended();
        assert.equal(signal.aborted,true);
        await new Promise(r=>setTimeout(r,800));
        assert.equal(prepares,1);
    }finally{await gate.close();}
});
