import {checkAssignmentVideoEligibility,createAssignmentVideoTransport} from './transport.js';
import {bindFrameClickCues,setFrameClickCues} from './frame-cues.js';
import {showShellClicks} from './shell-clicks.js';

import { currentTabPicker, STAGING_OS as OS } from './current-tab.js';
import { encodeTabSegments, seedFrame } from './tab-segments.js';
import { embeddedWorkFrame, respondToWorkDiscover, WORK_HOST, WORK_PROTOCOL } from './work-protocol.js';
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

// `live`: a stopped share never asks again (a stale prepare would otherwise abort the next share's mint).
async function retry(operation, codes, times=2, live=()=>true) {
    for(let i=0;;i++){
        if(!live())throw failure('cancelled');
        try{return await operation();}catch(err){if(i+1>=times||!codes.includes(err.code)||!live())throw err;
            await new Promise(resolve=>setTimeout(resolve,320*(i+1)));}}
}

const AWS_UNVERIFIED='This AWS computer is not verified for this assignment. Reopen it from Universe on the computer you started with, or select a Cloudflare computer you own.';
const hex64=/^[a-f0-9]{64}$/;
const WINDOW_MS=3600000;
/**
 * Whether Universe's answer lets this AWS computer run the assignment. The server alone compares the binding with the
 * computer's own workspace; this only requires an explicit, well-formed answer. `boundWorkspaceId` must be PRESENT: a
 * 64-hex workspace Universe bound, or null for the first opening (an older Universe omits it and is refused). A first
 * opening may already hold the explicit Start window, as long as that window is complete and no longer than the
 * assignment hour; nothing here supplies a time Universe did not sign. A migrated workspace is the other way in.
 */
export function awsAssignmentAnswer(result) {
    if(hex64.test(result?.upgradedWorkspaceId??'') && uuid.test(result?.upgradeOperationId??''))return true;
    const bound=result?.boundWorkspaceId;
    if(typeof bound==='string')return hex64.test(bound);
    if(bound!==null)return false;
    const {windowStartedAt:from,deadlineAt:until}=result;
    if(!from&&!until)return true;
    const start=Date.parse(from),deadline=Date.parse(until);
    return Number.isFinite(start)&&Number.isFinite(deadline)&&deadline>start&&deadline-start<=WINDOW_MS;
}

const EMBED_SIGN_IN='Continue to EZiL OS sign-in from your Universe assignment tab.';
const EMBED_UNAVAILABLE='This assignment workspace could not be verified here. Return to your Universe assignment to try again.';
const EMBED_PAUSED=['Sharing paused','Share this tab again from Universe to resume your assignment.'];
const identityCodes=['identity_refresh_required','IDENTITY_REFRESH_REQUIRED','assignment_identity_mismatch'];
const replyCode=error=>typeof error?.code==='string' && /^[A-Za-z_]{1,64}$/.test(error.code) ? error.code : 'workspace_unavailable';

/**
 * The assignment framed by its own Universe work page, which records ITS tab (`ezil.assignment.work/v2`).
 *
 * WINDOW (exact origins and actual windows only, `./work-protocol.js`): the parent's `discover {challenge}` is answered
 * with one of `authentication_required | preparing | ready | unavailable`, echoing that challenge. `preparing` while no
 * port is bound invites ONE `bind {challenge}` carrying exactly one MessagePort, for the latest answered challenge.
 * Nothing is fetched before a valid discover; one bind per document.
 *
 * PORT (byte-for-byte the Universe 994b90ac `assignment-work-capture.js` vocabulary; the shell's top-level
 * 6ef24888^ bridge, adapted to this base's checks): parent `request {id, method}` for `begin | upload | status | unlock
 * | end`, plus `pulse | lock | cancel`; child `ready` (bound, eligible and AWS-checked: sharing may start), `reply {id,
 * ok, value | code}`, `pause {reason, effectiveAt}` and `reopen`. The parent owns consent and the browser picker and
 * sends only frame bytes. This document keeps the sealed repository proof, the recording transport and every Universe
 * answer; replies carry only the fields the parent reads. `begin` runs only in reply to a request on the bound port.
 *
 * The server gate is unchanged: `prepare` seals the checkout, `begin` binds that receipt to the parent's capture
 * session, the seed must be confirmed phase-ready, and only then may the `open` mint ask `code-preview-url`, which
 * re-checks the same session, receipt, unlock and deadline. Window `ready` = the editor is open on the verified folder.
 */
function openEmbeddedAssignment({attemptId, repo, computerId, actor, open, body, park, prepare, computerProvider, win}) {
    const owner=actor(), ui=buildGate(body), name=repo.split('/').at(-1).slice(0,-4);
    let state='preparing', locked=true, armed=false, eligible=false, closing=false, closePromise, port=null, challenge=null;
    let active=null, windowStart, pulseAt=0, watch, drained, clickCues, frameCues;
    const inflight=new Set();
    const owned=()=>Boolean(owner) && actor()===owner;
    const isHere=()=>!closing && current===gate && owned();
    const terminal=()=>state==='unavailable' || state==='authentication_required';
    const live=item=>isHere() && active===item && !item.ending && !item.shareEnded;
    const check=item=>{if(!live(item))throw failure('recording_phase_changed');};
    const send=(type,fields={})=>{try{port?.postMessage({protocol:WORK_PROTOCOL,attemptId,type,...fields});}catch{/* closed by the parent */}};
    const reply=respondToWorkDiscover(attemptId,win,()=>state,arm);
    function lock(title,message){
        locked=true;park(true);clickCues?.();clickCues=null;frameCues?.();frameCues=null;setFrameClickCues(null);ui.clear();ui.set(title,message);
    }
    function setState(next,announce=true){if(state===next)return;state=next;if(announce)reply.push();}
    // `announce`: false only inside a discover, whose own reply follows and carries the new state.
    function settle(next,title,message,announce=true){
        if(closing)return;
        if(active){const item=active;suspend(item,false);send('pause',{reason:'connection_lost',effectiveAt:null});void end(item,'connection_lost',item.expected);}
        lock(title,message);setState(next,announce);
    }
    function failed(error,announce=true){
        const cause=error?.code||error?.message;
        if(!owned() || identityCodes.includes(cause))settle('authentication_required','Sign in to EZiL OS',EMBED_SIGN_IN,announce);
        else if(cause==='assignment_video_creator_unlinked')
            settle('unavailable','The Creator needs to connect EZiL ID','The job Creator must sign in to Universe with their verified EZiL ID. Return to the job in Universe to check whether your assignment is still available.',announce);
        else if(cause==='assignment_aws_unverified')settle('unavailable','Choose an assignment-ready computer',AWS_UNVERIFIED,announce);
        else settle('unavailable','Assignment unavailable',EMBED_UNAVAILABLE,announce);
    }
    function arm(latest){
        if(closing)return;
        challenge=latest;
        if(!owned()){if(state!=='authentication_required')settle('authentication_required','Sign in to EZiL OS',EMBED_SIGN_IN,false);return;}
        if(!armed){armed=true;void eligibility();}
    }
    async function eligibility(){
        lock('Preparing assignment','Verifying the assigned repository and OS session…');
        try{
            const result=await retry(()=>checkAssignmentVideoEligibility(attemptId,{repositoryUrl:repo}),['media_unavailable','recording_unavailable'],2,isHere);
            if(!isHere())return;
            if(result.status!=='eligible' || result.attemptId!==attemptId || result.repositoryUrl!==repo)throw failure('assignment_mismatch');
            const provider=await Promise.resolve(computerProvider?.()).catch(()=>null);
            if(!isHere())return;
            if(provider==='aws-ec2' && !awsAssignmentAnswer(result))throw failure('assignment_aws_unverified');
            eligible=true;
            lock('Share this assignment tab from Universe','Your editor opens after Universe confirms the recording.');
            if(port)send('ready');
        }catch(error){if(!closing && current===gate)failed(error);}
    }
    function onWindow(event){
        const data=event.data;
        if(event.source!==win.parent || event.origin!==WORK_HOST || data?.protocol!==WORK_PROTOCOL || data.type!=='bind' || data.attemptId!==attemptId
            || !challenge || data.challenge!==challenge || event.ports?.length!==1 || port || terminal() || !isHere())return;
        port=event.ports[0];port.onmessage=onPort;port.start?.();
        if(eligible)send('ready');
    }
    // The parent's sharing stopped or this document lost it: the editor locks at once; Universe then ends the phase.
    function suspend(item,announce=true){
        item.shareEnded=true;item.allowMint=false;item.ctl.abort();item.editor?.reject(failure('workspace_locked'));
        lock(...EMBED_PAUSED);if(state==='ready')setState('preparing',announce);
    }
    function startIdleWatch(){
        clearInterval(watch);pulseAt=Date.now();
        watch=setInterval(()=>{
            const item=active;if(!item || item.ending)return;
            if(!owned()){failed(failure('identity_refresh_required'));return;}
            if(Date.now()-pulseAt>14000){suspend(item);send('pause',{reason:'connection_lost',effectiveAt:null});void end(item,'connection_lost',item.expected);}
        },2800);
    }
    async function begin(d){
        if(!eligible || d.consentVersion!==4 || !uuid.test(d.captureSessionId??''))throw failure('assignment_not_ready');
        if(active){
            if(active.id===d.captureSessionId && active.grant && !active.ending && !active.shareEnded)
                return {captureSessionId:active.id,status:active.grant.status,nextSequence:active.grant.nextSequence};
            throw failure('recording_in_use');
        }
        const item=active={id:d.captureSessionId,expected:0,ctl:new AbortController()};
        startIdleWatch();lock('Preparing assignment','Verifying the assigned repository…');
        try{
            const result=await retry(()=>prepare(attemptId,{signal:item.ctl.signal}),['sandbox_starting','media_unavailable','assignment_open_unavailable'],3,
                ()=>live(item) && !item.ctl.signal.aborted);
            check(item);
            const sealed=result?.assignmentOpen, meta=result?.repository;
            if(result?.ok!==true || result.codePreviewUrl || result.url || sealed?.attemptId!==attemptId || !/^[A-Za-z0-9_-]{48,1700}$/.test(sealed.proof)
                || !meta?.id || typeof meta.workspaceFolder!=='string' || meta.checkoutFolder!==meta.workspaceFolder+'/'+name)
                throw failure('assigned_checkout_unverified');
            item.meta=meta;item.proof=sealed.proof;
            item.transport=createAssignmentVideoTransport({attemptId,repoOpenProof:item.proof,captureSessionId:item.id,consentVersion:4,
                onStop:(why,at)=>{
                    if(active!==item || item.ending)return;
                    suspend(item);send('pause',{reason:why==='submitted'||why==='timeout'?why:'connection_lost',effectiveAt:at??null});
                }});
            item.grant=await retry(()=>item.transport.begin(),['media_unavailable'],2,()=>live(item));
            check(item);
            if(item.grant.captureSessionId!==item.id || item.grant.status!=='awaiting_frame' || !Number.isSafeInteger(item.grant.nextSequence))
                throw failure('recording_phase_changed');
            item.expected=item.grant.nextSequence;
            ui.set('Checking recording','Saving the first frame before opening your editor…');
            return {captureSessionId:item.id,status:item.grant.status,nextSequence:item.grant.nextSequence};
        }catch(error){
            if(identityCodes.includes(error?.code))failed(error);
            else await end(item,'connection_lost',item.expected).catch(()=>{});
            throw error;
        }
    }
    async function upload(d){
        const item=active,p=d.part;
        // A stopping share may still deliver its final clip (`lock` precedes `end`); a seed may not.
        if(!item || item.id!==d.captureSessionId || item.ending || !item.grant || !owned())throw failure('recording_phase_changed');
        if(!p || !(p.bytes instanceof ArrayBuffer) || !p.bytes.byteLength || p.bytes.byteLength>8*1024*1024 || p.mimeType!=='video/webm'
            || !Number.isSafeInteger(p.sequence) || p.sequence<0 || p.sequence>=600 || !Number.isSafeInteger(p.startMs) || !Number.isSafeInteger(p.endMs))
            throw failure('invalid_segment');
        const seeding=!item.seed;
        if(seeding && (item.shareEnded || p.sequence!==item.expected || p.startMs!==0 || p.endMs!==1 || p.bytes.byteLength>1024*1024))
            throw failure('invalid_segment');
        const ack=await item.transport.upload({sequence:p.sequence,startMs:p.startMs,endMs:p.endMs,mimeType:'video/webm',bytes:p.bytes});
        if(active!==item || item.ending)throw failure('recording_phase_changed');
        if(!seeding){item.expected=Math.max(item.expected,p.sequence+1);return {confirmed:true,sequence:p.sequence};}
        if(!ack.phaseReady || ack.captureSessionId!==item.id || ack.nextSequence!==item.expected+1 || !ack.firstFrameAt)throw failure('seed_not_confirmed');
        const startAt=Date.parse(ack.startedAt), deadline=Date.parse(ack.deadlineAt), serverNow=Date.parse(ack.serverNow);
        const offset=Number.isFinite(serverNow)?serverNow-Date.now():0;
        if(!Number.isFinite(startAt) || !Number.isFinite(deadline) || deadline<=Date.now()+offset || deadline<=startAt || deadline-startAt>3600000)
            throw failure('recording_closed');
        // Reopening after a stop resumes the attempt's own window; a different start is never a new clock.
        if(windowStart!==undefined && windowStart!==startAt)throw failure('recording_closed');
        windowStart=startAt;item.seed=ack;item.expected=ack.nextSequence;
        return {confirmed:true,phaseReady:true,captureSessionId:item.id,nextSequence:ack.nextSequence,startedAt:ack.startedAt,deadlineAt:ack.deadlineAt};
    }
    async function status(d){
        const item=active;
        if(!item || item.id!==d.captureSessionId || item.ending || !item.grant || !owned())throw failure('recording_phase_changed');
        const s=await item.transport.status();
        return {captureSessionId:s.captureSessionId,status:s.status,stopRequestedAt:s.stopRequestedAt??null};
    }
    async function unlock(d){
        const item=active;
        if(!item || item.id!==d.captureSessionId)throw failure('recording_phase_changed');
        check(item);
        if(!item.seed)throw failure('seed_not_confirmed');
        await retry(async()=>{
            const s=await item.transport.status();
            if(s.phaseReady!==true || s.workspaceUnlocked!==true || s.captureSessionId!==item.id || s.startedAt!==item.seed.startedAt
                || s.deadlineAt!==item.seed.deadlineAt || !s.firstFrameAt)throw failure('seed_not_confirmed');
        },['seed_not_confirmed','media_unavailable'],3,()=>live(item));
        check(item);
        item.allowMint=true;
        ui.set('Opening assigned editor','Recording is active. Checking your workspace…');
        const editor=new Promise((resolve,reject)=>{item.editor={resolve,reject};});
        const timer=setTimeout(()=>item.editor?.reject(failure('assigned_checkout_unverified')),80000);
        try{open();await editor;}
        catch(error){if(active===item && !item.ending){item.allowMint=false;lock(...EMBED_PAUSED);}throw error;}
        finally{clearTimeout(timer);item.editor=null;}
        check(item);
        return {status:'ready',captureSessionId:item.id,startedAt:item.seed.startedAt,deadlineAt:item.seed.deadlineAt};
    }
    function end(item,reason,count){
        if(!item || item!==active)return Promise.resolve({});
        if(item.ending)return item.ending;
        if(!item.shareEnded)suspend(item);
        item.ending=(async()=>{
            clearInterval(watch);
            try{
                if(item.transport && item.grant){
                    const expectedSegments=Math.min(600,Math.max(item.expected,Number.isSafeInteger(count) && count>=0 ? count : 0));
                    if(reason==='submitted' || reason==='timeout')await item.transport.finalize({reason,expectedSegments});
                    else await retry(()=>item.transport.checkpoint(reason==='sharing_stopped'?'sharing_stopped':'connection_lost'),['media_unavailable']);
                }
                return {};
            }finally{
                item.transport?.dispose();if(active===item)active=null;drained?.();
                if((reason==='submitted' || reason==='timeout') && !closing){
                    lock('Assignment closed',reason==='submitted'?'Assignment submitted. Recording ended.':'The assignment time has ended.');setState('unavailable');
                }
            }
        })();
        return item.ending;
    }
    const methods={begin,upload,status,unlock,
        end:d=>{
            if(!['sharing_stopped','connection_lost','submitted','timeout'].includes(d.reason) || active?.id!==d.captureSessionId || !owned())
                return Promise.reject(failure('recording_phase_changed'));
            return end(active,d.reason,d.expectedSegments);
        }};
    function onPort(event){
        const d=event.data;
        if(d?.protocol!==WORK_PROTOCOL || d.attemptId!==attemptId)return;
        if(d.type==='pulse'){if(active && active.id===d.captureSessionId)pulseAt=Date.now();return;}
        if(d.type==='lock'){if(active && active.id===d.captureSessionId && !active.shareEnded)suspend(active);return;}
        if(d.type==='cancel'){if(active && active.id===d.captureSessionId && !active.grant)void end(active,'connection_lost',active.expected);return;}
        if(d.type!=='request' || !Number.isSafeInteger(d.id) || d.id<=0)return;
        const method=Object.hasOwn(methods,d.method)?methods[d.method]:null;
        const run=async()=>{
            if(!method)throw failure('invalid_request');
            // Only the drain of an already granted phase continues past a refusal; nothing new starts.
            if(['begin','unlock'].includes(d.method) && (terminal() || !isHere()))
                throw failure(state==='authentication_required'?'identity_refresh_required':'workspace_unavailable');
            return method(d);
        };
        const task=run().then(value=>send('reply',{id:d.id,ok:true,value}),error=>send('reply',{id:d.id,ok:false,code:replyCode(error)}));
        inflight.add(task);void task.finally(()=>inflight.delete(task));
    }
    // The same folder rule as the OS tab: the editor must show the verified workspace or its checkout, and nothing else.
    function confirm(frame,frameUrl,actualRoot){
        const item=active;
        if(!item?.allowMint || !item.editor || !live(item) || !frame.isConnected)return;
        const url=new URL(frameUrl), folders=[item.meta.workspaceFolder,item.meta.checkoutFolder];
        if(!folders.includes(actualRoot) || !folders.includes(url.searchParams.get('folder'))){item.editor.reject(failure('assigned_checkout_unverified'));return;}
        locked=false;park(false);ui.reveal();clickCues=showShellClicks(win);
        frameCues=bindFrameClickCues(frame,url.origin,url.searchParams.get('ezil_mint'),computerId);setFrameClickCues(computerId);
        item.editor.resolve();setState('ready');
    }
    function close(){
        if(closePromise)return closePromise;
        closing=true;reply.dispose();clearInterval(watch);
        win.removeEventListener('message',onWindow);win.removeEventListener('pagehide',pageHide);
        const item=active;
        if(item && !item.shareEnded)suspend(item,false);else lock(...EMBED_PAUSED);
        const bounded=(promise,timers)=>Promise.race([promise,new Promise(r=>{timers.push(setTimeout(r,2500));})]);
        closePromise=(async()=>{
            const timers=[];
            try{
                if(item){
                    send('pause',{reason:'connection_lost',effectiveAt:null});
                    await bounded(new Promise(r=>drained=r),timers);
                    if(item===active)await end(item,'connection_lost',item.expected);
                }
                // The parent's own `end` (or any other request) is answered before the port goes away.
                await bounded(Promise.allSettled([...inflight]),timers);
            }catch{/* accepted footage stays saved */}
            finally{timers.forEach(clearTimeout);send('reopen');port?.close();port=null;ui.remove();if(current===gate)current=null;}
        })();
        return closePromise;
    }
    function pageHide(){if(active?.grant)active.transport.checkpointOnExit('connection_lost');void close();}
    const gate={repo,locked:()=>locked,confirm,close,
        access:()=>active?.allowMint && live(active) ? {attemptId,phase:'open',repoOpenProof:active.proof,captureSessionId:active.id} : null};
    current=gate;
    lock('Open this assignment from Universe','Waiting for your Universe assignment page…');
    win.addEventListener('message',onWindow);win.addEventListener('pagehide',pageHide,{once:true});
    return gate;
}

export function openWithAssignmentConsent({project, computerId, actor, open, body, park, prepare, computerProvider}) {
    const win=globalThis.window, repo=project?.repoUrl;
    if(!win || win.location.origin!==OS){queueMicrotask(open);return null;}
    const address=new URL(win.location.href);
    const entry=address.searchParams.has('repo')||address.searchParams.has('assignment')?address.href:initialEntry;
    const attemptId=assignmentIntent(entry,repo);
    const explicit=address.pathname==='/app/code' && address.searchParams.has('assignment');
    if(!canonical.test(repo) && !explicit){queueMicrotask(open);return null;}
    // Framed by its own Universe workspace: a separate gate that waits for that exact parent and never uses the picker.
    if(attemptId && embeddedWorkFrame(win))
        return openEmbeddedAssignment({attemptId,repo,computerId,actor,open,body,park,prepare,computerProvider,win});

    const owner=actor(), ui=buildGate(body);
    // `windowStart`: the first accepted start of this attempt's recording window, kept across stops and reopenings.
    let disposePromise, disposed=false, locked=true, picker, activity, indicator, clickCues, frameCues, windowStart;
    const isOwner=()=>Boolean(owner) && actor()===owner;
    const isHere=()=>!disposed && current===gate && isOwner() && win===win.top;
    const samePhase=item=>isHere() && activity===item && !item.ended;
    const recordingSource=item=>samePhase(item) && Boolean(item.source?.matches()) && !item.source.stream.getVideoTracks()[0].muted;
    function lockedView(title,message) {
        locked=true;park(true);clickCues?.();clickCues=null;frameCues?.();frameCues=null;
        setFrameClickCues(null);ui.clear();ui.set(title,message);
    }
    function showIndicator(message) {
        if(!indicator){
            indicator=document.createElement('button');indicator.type='button';
            indicator.className='ezil-assignment-recording-status';
            indicator.setAttribute('aria-label','Stop sharing this assignment tab');
            indicator.title='Stop sharing this assignment tab';
            indicator.onclick=event=>{if(event.isTrusted && activity)void finish(activity,'sharing_stopped');};
            document.body.append(indicator);
        }
        indicator.textContent=message+' · Stop';
    }
    function removeIndicator(){indicator?.remove();indicator=null;}
    function check(item){if(!recordingSource(item))throw failure('source_lost');}
    function displayConsent(message) {
        lockedView('Record this assignment tab',message || 'Share only this EZiL OS tab to open the assignment. The job creator can review saved work even if you do not submit.');
        if(message)ui.set('Record this assignment tab',message+' The job creator can review saved work even if you do not submit.');
        ui.action('Share this OS tab and open assignment',share);
    }
    function showSignIn(){
        lockedView('Sign in to EZiL OS','Return to this assignment after signing in.');
        // The selected computer survives the sign-in: the assignment resumes on exactly the one it started on.
        const params=new URLSearchParams({repo,assignment:attemptId});
        if(uuid.test(computerId??''))params.set('computer',computerId);
        const dest='/app/code?'+params;
        ui.action('Sign in to EZiL OS',()=>win.location.assign('/auth/auth0/login?'+new URLSearchParams({returnUrl:dest})));
    }
    function showAccountSignIn(){
        lockedView('Sign in to EZiL OS','Use the same EZiL ID you used on Universe.');
        const target=new URL(entry);
        const returnUrl=target.pathname+target.search+target.hash;
        const params=new URLSearchParams({prompt:'login',returnUrl});
        ui.action('Sign in to EZiL OS',()=>win.location.assign('/auth/auth0/login?'+params));
    }
    async function eligible(){
        lockedView('Checking assignment','Verifying the assigned repository and OS session…');
        try{
            const result=await retry(()=>checkAssignmentVideoEligibility(attemptId,{repositoryUrl:repo}),['media_unavailable','recording_unavailable']);
            if(!isHere())return;
            if(result.status!=='eligible' || result.attemptId!==attemptId || result.repositoryUrl!==repo)throw failure('assignment_mismatch');
            // Only an AWS computer is checked here: any other provider keeps its own path, and the server decides it.
            const provider=await Promise.resolve(computerProvider?.()).catch(()=>null);
            if(provider==='aws-ec2'){
                if(!isHere())return;
                if(!awsAssignmentAnswer(result)){
                    lockedView('Choose an assignment-ready computer',AWS_UNVERIFIED);
                    ui.action('Check this computer again',eligible);
                    return;
                }
            }
            if(!isHere())return;
            picker??=currentTabPicker(win);
            displayConsent();
        }catch(e){
            if(!isHere())return;
            if(e.code==='identity_refresh_required'){showSignIn();return;}
            if(e.code==='assignment_identity_mismatch'){showAccountSignIn();return;}
            if(e.code==='assignment_video_creator_unlinked'){
                lockedView('The Creator needs to connect EZiL ID','The job Creator must sign in to Universe with their verified EZiL ID. Return to the job to check whether your assignment is still available.');
                ui.action('Return to Universe jobs',()=>win.open('https://universe-staging.ezil.work/builder-jobs','_self','noreferrer'));
                return;
            }
            const unsupported=e.message==='unsupported';
            lockedView('Assignment unavailable',unsupported?'This browser cannot verify sharing of this OS tab.':'The assigned repository or recording service could not be verified.');
            if(!unsupported)ui.action('Retry verification',eligible);
        }
    }
    function share() {
        if(!isHere()||!picker||activity)return;
        const item={id:win.crypto.randomUUID(),expected:0};
        activity=item;
        // choose invokes the native picker synchronously inside the trusted user's action.
        const selection=picker.choose();
        lockedView('Share this OS tab','Choose this EZiL OS tab in your browser.');
        item.starting=start(item,selection);
    }
    async function start(item,selection) {
        const live=()=>samePhase(item);
        try{
            const source=await selection;
            if(!samePhase(item)){source.stream.getTracks().forEach(t=>t.stop());return;}
            item.source=source;
            const track=source.stream.getVideoTracks()[0];
            track.addEventListener('ended',()=>void finish(item,'sharing_stopped'),{once:true});
            track.addEventListener('mute',()=>void finish(item,'connection_lost'),{once:true});
            track.addEventListener('capturehandlechange',()=>{if(!recordingSource(item))void finish(item,'connection_lost');});
            item.watch=setInterval(()=>{if(!recordingSource(item))void finish(item,'connection_lost');},1100);
            showIndicator('Sharing');lockedView('Preparing assignment','Verifying the assigned repository…');
            item.prepareCtl=new AbortController();
            const result=await retry(()=>prepare(attemptId,{signal:item.prepareCtl.signal}),['sandbox_starting','media_unavailable','assignment_open_unavailable'],3,live);
            check(item);
            const proof=result?.assignmentOpen, meta=result?.repository, name=repo.split('/').at(-1).slice(0,-4);
            if(result.ok!==true||result.codePreviewUrl||result.url||proof?.attemptId!==attemptId||!/^[A-Za-z0-9_-]{48,1700}$/.test(proof.proof)
                ||!meta?.id||typeof meta.workspaceFolder!=='string'||meta.checkoutFolder!==meta.workspaceFolder+'/'+name)
                throw failure('assigned_checkout_unverified');
            item.meta=meta;item.proof=proof.proof;
            item.transport=createAssignmentVideoTransport({attemptId,repoOpenProof:item.proof,captureSessionId:item.id,consentVersion:4,
                onStop:(why,at)=>void finish(item,why==='submitted'||why==='timeout'?why:'connection_lost',at)});
            item.grant=await retry(()=>item.transport.begin(),['media_unavailable'],2,live);
            check(item);
            if(item.grant.captureSessionId!==item.id||item.grant.status!=='awaiting_frame'||!Number.isSafeInteger(item.grant.nextSequence))
                throw failure('recording_phase_changed');
            item.expected=item.grant.nextSequence;
            const bytes=await seedFrame(source.stream,()=>recordingSource(item),
                ()=>ui.set('Checking recording','Saving the first frame before opening your editor…'));
            check(item);
            const upload=part=>retry(()=>item.transport.upload(part),['upload_failed','media_unavailable'],2);
            const ack=await upload({sequence:item.expected,startMs:0,endMs:1,mimeType:'video/webm',bytes});
            check(item);
            if(!ack.phaseReady || ack.captureSessionId!==item.id || ack.nextSequence!==item.expected+1 || !ack.firstFrameAt)
                throw failure('seed_not_confirmed');
            item.expected=ack.nextSequence;
            const startAt=Date.parse(ack.startedAt), deadline=Date.parse(ack.deadlineAt), serverNow=Date.parse(ack.serverNow);
            const offset=Number.isFinite(serverNow)?serverNow-Date.now():0;
            if(!Number.isFinite(startAt)||!Number.isFinite(deadline)||deadline<=Date.now()+offset||deadline<=startAt||deadline-startAt>3600000)
                throw failure('recording_closed');
            // Reopening after a stop resumes the attempt's own window; a different start is never a new clock.
            if(windowStart!==undefined&&windowStart!==startAt)throw failure('recording_closed');
            windowStart=startAt;
            item.recorder=await encodeTabSegments({win,stream:source.stream,matches:()=>recordingSource(item),windowStart:startAt,deadline,
                firstSequence:item.expected,clockOffset:offset,upload:part=>{item.expected=Math.max(item.expected,part.sequence+1);return upload(part);},
                cutoff:async()=>{const state=await item.transport.status();return state.stopRequestedAt||null;},
                onFault:()=>void finish(item,'connection_lost'),onFrame:()=>{},
                onAwaitFrame:()=>ui.set('Opening assigned editor','Recording is active. Checking your workspace…')});
            check(item);
            await retry(async()=>{
                const state=await item.transport.status();
                if(state.phaseReady!==true||state.workspaceUnlocked!==true||state.captureSessionId!==item.id||state.startedAt!==ack.startedAt
                  ||state.deadlineAt!==ack.deadlineAt||!state.firstFrameAt)throw failure('seed_not_confirmed');
            },['seed_not_confirmed','media_unavailable'],3);
            check(item);
            item.deadline=setTimeout(()=>void finish(item,'timeout',ack.deadlineAt),Math.max(0,deadline-Date.now()-offset));
            item.allowMint=true;showIndicator('Recording');
            const editor=new Promise((resolve,reject)=>{item.editor={resolve,reject};});
            item.editorTimeout=setTimeout(()=>item.editor?.reject(failure('assigned_checkout_unverified')),80000);
            open();await editor;
        }catch(error){
            if(activity!==item||item.ended)return;
            const cause=error.code||error.message;
            let message='Recording was interrupted. Accepted footage is preserved. Share this OS tab to resume.';
            if(cause==='wrong_tab')message='Select this EZiL OS tab. The other source was discarded.';
            if(error.name==='NotAllowedError')message='Sharing was declined. Share this OS tab to open your editor.';
            if(cause==='assigned_checkout_unverified')message='The assigned checkout could not be verified. Share this tab to try again.';
            if(cause==='assignment_aws_unverified')message=AWS_UNVERIFIED;
            void finish(item,'connection_lost',null,message,cause==='identity_refresh_required'||cause==='IDENTITY_REFRESH_REQUIRED');
        }finally{clearTimeout(item.editorTimeout);item.editor=null;}
    }
    function confirmed(frame,frameUrl,actualRoot){
        const item=activity;if(!item?.allowMint||!item.editor||!recordingSource(item)||!frame.isConnected)return;
        const url=new URL(frameUrl), folders=[item.meta.workspaceFolder,item.meta.checkoutFolder];
        if(!folders.includes(actualRoot)||!folders.includes(url.searchParams.get('folder'))){item.editor.reject(failure('assigned_checkout_unverified'));return;}
        locked=false;park(false);ui.reveal();clickCues=showShellClicks(win);
        frameCues=bindFrameClickCues(frame,url.origin,url.searchParams.get('ezil_mint'),computerId);
        setFrameClickCues(computerId);item.editor.resolve();
    }
    function finish(item,reason='sharing_stopped',effectiveAt=null,message,signIn=false){
        if(activity!==item)return Promise.resolve();
        if(item.ending)return item.ending;
        item.ended=true;item.allowMint=false;item.prepareCtl?.abort();clearInterval(item.watch);clearTimeout(item.deadline);clearTimeout(item.editorTimeout);
        item.editor?.reject(failure('workspace_locked'));
        item.source?.stream.getTracks().forEach(t=>t.stop());
        removeIndicator();lockedView('Sharing stopped','Checking saved assignment footage…');
        item.ending=(async()=>{
            let saved=true;
            try{await item.starting;if(item.recorder)item.expected=(await item.recorder.stop(effectiveAt)).expectedSegments;}
            catch{saved=false;}
            try{
                if(item.grant){
                    if(reason==='submitted'||reason==='timeout')await item.transport.finalize({reason,expectedSegments:item.expected});
                    else await retry(()=>item.transport.checkpoint(reason==='sharing_stopped'?'sharing_stopped':'connection_lost'),['media_unavailable']);
                }
            }catch{saved=false;}
            finally{item.transport?.dispose();if(activity===item)activity=null;}
            if(!isHere())return;
            if(reason==='submitted'||reason==='timeout'){lockedView('Assignment closed',reason==='submitted'?'Assignment submitted. Recording ended.':'The assignment time has ended.');return;}
            if(signIn){showSignIn();return;}
            displayConsent(message||(saved?'Sharing stopped. Share this OS tab again to resume.':'Sharing was interrupted. Your recording may contain a gap.'));
        })();
        return item.ending;
    }
    function close(){
        if(disposePromise)return disposePromise;
        disposed=true;const item=activity;
        win.removeEventListener('pagehide',pageHide);
        disposePromise=(item?finish(item,'connection_lost'):Promise.resolve()).finally(()=>{
            picker?.dispose();removeIndicator();ui.remove();if(current===gate)current=null;
        });
        return disposePromise;
    }
    function pageHide(){if(activity?.grant)activity.transport.checkpointOnExit('connection_lost');void close();}
    const gate={repo,locked:()=>locked,confirm:confirmed,close,
        access:()=>activity?.allowMint&&recordingSource(activity)?{attemptId,phase:'open',repoOpenProof:activity.proof,captureSessionId:activity.id}:null};
    current=gate;
    if(!attemptId||!isOwner()||win!==win.top){
        lockedView('Open your assigned OS tab','Use the assignment link in Universe to open the verified workspace in its own OS tab.');
    }else{win.addEventListener('pagehide',pageHide,{once:true});void eligible();}
    return gate;
}

export function confirmAssignmentFolder(project,_receipt,frame,frameUrl,actualRoot){
    if(current?.repo===project?.repoUrl)current.confirm(frame,frameUrl,actualRoot);
}
