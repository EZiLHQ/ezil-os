import {checkAssignmentVideoEligibility,createAssignmentVideoTransport} from './transport.js';
import {bindFrameClickCues,setFrameClickCues} from './frame-cues.js';
import {showShellClicks} from './shell-clicks.js';

const OS='https://os-staging.ezil.work', UNIVERSE='https://universe-staging.ezil.work';
const protocol='ezil.assignment.work/v2';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const canonical=/^https:\/\/github\.ezil\.work\/default\/u-[0-9a-f]{16}-a-([0-9a-f-]{36})\.git$/;
const initialEntry=globalThis.location?.href;
const failure=code=>Object.assign(new Error(code),{code});
let current;

export function assignmentIntent(href,repoUrl) {
    const candidate=canonical.exec(repoUrl)?.[1];
    if(!uuid.test(candidate??''))return null;
    let url;try{url=new URL(href);}catch{return null;}
    if(url.origin!==OS || url.pathname!=='/app/code' || url.username || url.password
        || url.searchParams.getAll('assignment').length>1 || url.searchParams.getAll('repo').length!==1
        || url.searchParams.get('repo')!==repoUrl)return null;
    const hint=url.searchParams.get('assignment');return hint===null || hint===candidate ? candidate : null;
}

function buildGate(body) {
    const panel=document.createElement('section');
    panel.className='ezil-assignment-work-gate';panel.setAttribute('aria-label','Assignment workspace');
    const card=document.createElement('div'),title=document.createElement('h2'),detail=document.createElement('p');
    detail.setAttribute('role','status');card.append(title,detail);panel.append(card);body.append(panel);
    return {set(heading,message){panel.hidden=false;title.textContent=heading;detail.textContent=message;},
        action(label,fn){card.querySelector('button')?.remove();const el=document.createElement('button');el.type='button';
            el.textContent=label;el.onclick=event=>{if(event.isTrusted)fn();};card.append(el);},
        clear(){card.querySelector('button')?.remove();},reveal(){panel.hidden=true;},remove(){panel.remove();}};
}

async function retry(operation, codes, times=2) {
    for(let i=0;;i++){try{return await operation();}catch(err){if(i+1>=times||!codes.includes(err.code))throw err;
        await new Promise(resolve=>setTimeout(resolve,320*(i+1)));}}
}

export function openWithAssignmentConsent({project,computerId,actor,open,body,park,prepare}) {
    const win=globalThis.window, repo=project?.repoUrl;
    if(!win || win.location.origin!==OS){queueMicrotask(open);return null;}
    const address=new URL(win.location.href);
    const entry=address.searchParams.has('repo')||address.searchParams.has('assignment')?address.href:initialEntry;
    const attemptId=assignmentIntent(entry,repo);
    const reserved=Boolean(canonical.exec(repo));
    const explicit=address.pathname==='/app/code' && address.searchParams.has('assignment');
    if(!reserved&&!explicit){queueMicrotask(open);return null;}
    const owner=actor(),ui=buildGate(body),sameOwner=()=>Boolean(owner)&&actor()===owner;
    let port,challenge,eligibility,active,needsSignIn=false,closing=false,pulseAt=0,watch,eligibilityRun=0,bridgeTimer;
    let locked=true,closePromise,resolveDrained,closeCodeCues,closeShellCues;
    const embedded=win!==win.top && win.parent===win.top;
    const valid=()=>!closing && sameOwner();
    const send=(type,fields={})=>{try{port?.postMessage({protocol,attemptId,type,...fields});}catch{}};
    function lock(title='Assignment paused',message='Share this tab from Universe to continue.') {
        locked=true;park(true);closeCodeCues?.();closeCodeCues=null;closeShellCues?.();closeShellCues=null;
        setFrameClickCues(null);ui.set(title,message);
    }
    function visibleIssue(title,message){lock(title,message);ui.clear();}
    lock('Opening assignment workspace','Checking your assignment and signed-in OS session…');
    async function eligibilityCheck(){
        const run=++eligibilityRun;
        try {
            const candidate=await retry(()=>checkAssignmentVideoEligibility(attemptId),['media_unavailable','recording_unavailable']);
            if(!valid()||run!==eligibilityRun)return;
            if(candidate.repositoryUrl!==repo || candidate.attemptId!==attemptId || candidate.status!=='eligible')
                throw failure('assignment_mismatch');
            eligibility=candidate;needsSignIn=false;ui.clear();
            ui.set('Ready to share','Use Share assignment tab in Universe. Your editor will open after capture is verified.');
        }catch(err){
            if(closing||run!==eligibilityRun)return;
            eligibility=null;needsSignIn=err.code==='identity_refresh_required';visibleIssue('Workspace verification unavailable',
                err.code==='identity_refresh_required'?'Sign in to EZiL OS, then retry.':'The assigned repository or recording service could not be verified. Your editor remains locked.');
            ui.action('Retry verification',eligibilityCheck);
        }
    }
    function onWindow(ev){
        const d=ev.data;
        if(!valid()||!embedded||ev.source!==win.parent||ev.origin!==UNIVERSE||d?.protocol!==protocol||d.attemptId!==attemptId)return;
        if(d.type==='discover' && uuid.test(d.challenge)){
            if(!eligibility){
                if(needsSignIn)ev.source.postMessage({protocol,attemptId,type:'authentication_required',challenge:d.challenge},UNIVERSE);
                return;
            }
            if(port)return;
            challenge=d.challenge;
            ev.source.postMessage({protocol,attemptId,type:'available',challenge},UNIVERSE);
        }else if(eligibility && d.type==='bind' && d.challenge===challenge && challenge && !port && ev.ports.length===1){
            port=ev.ports[0];port.onmessage=onPort;port.start();send('ready');challenge=null;
        }
    }
    function assertActive(id,drain=false){if(!(drain?sameOwner():valid())||!active||active.id!==id||active.ending||(!drain && active.shareEnded))throw failure('recording_phase_changed');return active;}
    function startIdleWatch(){
        clearInterval(watch);pulseAt=Date.now();watch=setInterval(()=>{
            if(!active||active.ending)return;
            if(!sameOwner()||Date.now()-pulseAt>14000){
                const item=active;lock('Sharing interrupted','The assignment is locked. Reconnect from Universe.');
                send('pause',{reason:'connection_lost'});
                void end(item,'connection_lost',item.expected);
            }
        },2800);
    }
    async function end(item,reason,count){
        if(!item || item!==active)return {};
        if(item.ending)return item.ending;
        clearInterval(watch);clearTimeout(bridgeTimer);
        lock(['submitted','timeout'].includes(reason)?'Assignment closed':'Sharing paused',
            ['submitted','timeout'].includes(reason)?'This assignment is no longer editable.':'Share this tab again to resume your assignment.');
        item.onWorkbench?.reject(failure('workspace_locked'));item.onWorkbench=null;
        item.ending=(async()=>{
            try{
                if(item.transport && item.grant){
                    if(['submitted','timeout'].includes(reason))return await item.transport.finalize({reason,expectedSegments:Math.max(item.expected,count||0)});
                    return await retry(()=>item.transport.checkpoint(reason==='sharing_stopped'?'sharing_stopped':'connection_lost'),['media_unavailable']);
                }
                return {};
            }finally{item.transport?.dispose();if(active===item)active=null;resolveDrained?.();}
        })();
        return item.ending;
    }
    async function begin(d){
        if(!valid() || !eligibility || d.consentVersion!==4 || !uuid.test(d.captureSessionId))throw failure('assignment_not_ready');
        if(active){if(active.id===d.captureSessionId && active.grant)return active.grant;throw failure('recording_in_use');}
        const item=active={id:d.captureSessionId,expected:0};
        startIdleWatch();lock('Verifying assigned repository','Preparing your workspace. The editor stays locked during this check.');
        try{
            const result=await retry(()=>prepare(attemptId),['media_unavailable','sandbox_starting','assignment_open_unavailable'],3);
            assertActive(item.id);
            const proof=result?.assignmentOpen,meta=result?.repository;
            const checkout=repo.slice(repo.lastIndexOf('/')+1,-4);
            if(result.ok!==true || result.codePreviewUrl || proof?.attemptId!==attemptId || !/^[A-Za-z0-9_-]{48,1700}$/.test(proof.proof)
                || !meta?.id || typeof meta.workspaceFolder!=='string' || meta.checkoutFolder!==meta.workspaceFolder+'/'+checkout)
                throw failure('assigned_checkout_unverified');
            item.proof=proof.proof;item.meta=meta;
            item.transport=createAssignmentVideoTransport({attemptId,repoOpenProof:proof.proof,captureSessionId:item.id,consentVersion:4,
                onStop:(reason,effectiveAt)=>{if(active!==item)return;item.shareEnded=true;item.allowMint=false;lock();item.onWorkbench?.reject(failure('workspace_locked'));send('pause',{reason,effectiveAt});}});
            item.grant=await retry(()=>item.transport.begin(),['media_unavailable','workspace_timeout'],2);
            assertActive(item.id);
            if(item.grant.captureSessionId!==item.id||item.grant.status!=='awaiting_frame')throw failure('recording_phase_changed');
            item.expected=item.grant.nextSequence;
            ui.set('Checking recording','The first frame must be saved before the editor opens.');
            return item.grant;
        }catch(err){await end(item,'connection_lost',item.expected).catch(()=>{});throw err;}
    }
    async function upload(d){
        const item=assertActive(d.captureSessionId,true),p=d.part;
        if(!item.grant || !p || !(p.bytes instanceof ArrayBuffer)||!p.bytes.byteLength||p.bytes.byteLength>8*1024*1024
            || p.mimeType!=='video/webm'||!Number.isSafeInteger(p.sequence)||p.sequence<0||p.sequence>=600)throw failure('invalid_segment');
        const result=await item.transport.upload(p);
        if(!result.confirmed)throw failure('upload_unconfirmed');
        item.expected=Math.max(item.expected,p.sequence+1);
        if(result.phaseReady){if(result.captureSessionId!==item.id)throw failure('recording_phase_changed');item.seed=result;}
        return result;
    }
    async function unlock(d){
        const item=assertActive(d.captureSessionId);
        if(!item.seed)throw failure('seed_not_confirmed');
        const status=await retry(async()=>{
            const state=await item.transport.status();
            if(!state.phaseReady || !state.workspaceUnlocked || state.captureSessionId!==item.id||state.startedAt!==item.seed.startedAt
                || state.deadlineAt!==item.seed.deadlineAt||!state.firstFrameAt)throw failure('seed_not_confirmed');
            return state;
        },['seed_not_confirmed','media_unavailable'],3);
        assertActive(item.id);
        item.allowMint=true;
        const ready=new Promise((resolve,reject)=>{item.onWorkbench={resolve,reject};});
        bridgeTimer=setTimeout(()=>item.onWorkbench?.reject(failure('assigned_checkout_unverified')),80000);
        ui.set('Opening verified editor','Recording is active. Waiting for the assigned Code workspace…');
        open();
        try{await ready;return {status:'ready',captureSessionId:item.id,startedAt:status.startedAt,deadlineAt:status.deadlineAt};}
        finally{clearTimeout(bridgeTimer);item.onWorkbench=null;}
    }
    function onPort(ev){
        const d=ev.data;
        if(d?.protocol!==protocol||d.attemptId!==attemptId)return;
        if(d.type==='pulse'){if(active?.id===d.captureSessionId)pulseAt=Date.now();return;}
        if(d.type==='lock'&&active?.id===d.captureSessionId){active.shareEnded=true;active.allowMint=false;lock();active.onWorkbench?.reject(failure('workspace_locked'));return;}
        if(d.type==='cancel'&&active?.id===d.captureSessionId){void end(active,'connection_lost',active.expected).catch(()=>{});return;}
        if(d.type!=='request'||!Number.isSafeInteger(d.id)||d.id<=0)return;
        const run=async()=>{
            if(d.method==='begin')return begin(d);
            if(d.method==='end'){
                if(!['sharing_stopped','connection_lost','submitted','timeout'].includes(d.reason)||active?.id!==d.captureSessionId)throw failure('recording_phase_changed');
                return end(active,d.reason,d.expectedSegments);
            }
            if(d.method==='upload')return upload(d);
            if(d.method==='status')return assertActive(d.captureSessionId,true).transport.status();
            if(d.method==='unlock')return unlock(d);
            throw failure('invalid_request');
        };
        run().then(value=>send('reply',{id:d.id,ok:true,value})).catch(err=>send('reply',{id:d.id,ok:false,code:err.code||'workspace_unavailable'}));
    }
    function confirmed(frame,frameUrl,actualRoot){
        const item=active;if(!valid()||!item?.allowMint||!item.onWorkbench||!frame.isConnected)return;
        if(actualRoot!==item.meta.workspaceFolder && actualRoot!==item.meta.checkoutFolder){
            item.onWorkbench.reject(failure('assigned_checkout_unverified'));return;
        }
        const u=new URL(frameUrl);
        if(u.searchParams.get('folder')!==item.meta.workspaceFolder && u.searchParams.get('folder')!==item.meta.checkoutFolder){
            item.onWorkbench.reject(failure('assigned_checkout_unverified'));return;
        }
        locked=false;park(false);ui.reveal();closeShellCues=showShellClicks(win);
        closeCodeCues=bindFrameClickCues(frame,u.origin,u.searchParams.get('ezil_mint'),computerId);
        setFrameClickCues(computerId);item.onWorkbench.resolve();
    }
    function close(){
        if(closePromise)return closePromise;
        closing=true;clearInterval(watch);clearTimeout(bridgeTimer);win.removeEventListener('message',onWindow);win.removeEventListener('pagehide',pageHide);
        const item=active;lock();
        closePromise=(async()=>{
            try{
                if(item){
                    send('pause',{reason:'connection_lost'});
                    await Promise.race([new Promise(r=>resolveDrained=r),new Promise(r=>setTimeout(r,2500))]);
                    if(item===active)await end(item,'connection_lost',item.expected);
                }
            }catch{}finally{send('reopen');ui.remove();port?.close();port=null;if(current===gate)current=null;}
        })();return closePromise;
    }
    function pageHide(){if(active?.grant)active.transport.checkpointOnExit?.('connection_lost');void close();}
    const gate={repo,locked:()=>locked,confirm:confirmed,close,
        access:()=>active?.allowMint && valid()?{attemptId,phase:'open',repoOpenProof:active.proof,captureSessionId:active.id}:null};
    current=gate;
    if(!attemptId||!sameOwner()||!embedded){
        visibleIssue('Open this assignment from Universe','The assignment can be edited in its signed-in Universe work tab after sharing is confirmed.');
        if(attemptId)ui.action('Open Universe assignment',()=>win.open(UNIVERSE+'/assignment/work/'+attemptId,'_top'));
    }else{
        win.addEventListener('message',onWindow);win.addEventListener('pagehide',pageHide,{once:true});
        void eligibilityCheck();
    }
    return gate;
}

export function confirmAssignmentFolder(project,_receipt,frame,frameUrl,actualRoot){
    if(current?.repo===project?.repoUrl)current.confirm(frame,frameUrl,actualRoot);
}
