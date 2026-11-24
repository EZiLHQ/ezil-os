import {checkAssignmentClock,checkAssignmentVideoEligibility,createAssignmentVideoTransport} from './transport.js';
import { currentTabPicker, assignmentOsOrigin } from './current-tab.js';
import { encodeTabSegments, seedFrame } from './tab-segments.js';
import { createCountdown } from './countdown.js';
import { createStatusControl } from './status-control.js';
import telemetry from '../telemetry.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const canonical=/^https:\/\/github\.ezil\.work\/default\/u-[0-9a-f]{16}-a-([0-9a-f-]{36})\.git$/;
const initialEntry=globalThis.location?.href;
const failure=code=>Object.assign(new Error(code),{code});
let current;
/**
 * How long a stop holds the gate on "Checking saved assignment footage…" before it hands the consent screen back. It
 * bounds the screen only: the footage keeps saving in order in the background (`save`), never cut short by this.
 */
export const STOP_SETTLE_MS=5000;
/**
 * Backstop for saving a stopped share's footage. Every step is already bounded by the transport's own timeouts (control
 * 18 s, PUT 30 s); this covers one full-timeout pass of the longest chain (an in-flight segment 66 s, the cutoff status
 * 18 s, the final segment 66 s) and a codec call that never settles. Past it the phase is checkpointed anyway.
 */
export const STOP_SAVE_CEILING_MS=150000;
/**
 * How long the seed frame waits for the shared tab to present a fresh, unmuted frame. It bounds a muted share before
 * recording: Chrome mutes a captured tab that sends no new frames (the picker's focus, a still screen), and a mute that
 * outlasts this fails as `no_current_frame`.
 */
export const FRESH_FRAME_MS=8000;
/** How often the server's clock is asked for: while a share is live (a pause reaches capture within seconds) and between shares. */
export const CLOCK_LIVE_MS=3000;
export const CLOCK_IDLE_MS=15000;
/** `editor-ready` is retried (editor still covered) on these answers, a few times, before it offers "Check again". */
const EDITOR_READY_TRANSIENT=['media_unavailable','recording_unavailable','assignment_open_unavailable'];
const EDITOR_READY_TRIES=4;
/** How long an unpaused share waits for its editor to be re-verified before it offers to reconnect it. */
export const RECONNECT_OFFER_MS=15000;
/**
 * The stopped share whose footage is still being saved (`{item,done}`), in any gate of this document. A new share sends
 * no begin until it is done: the broker holds one capture lease per attempt and OS session, so a new phase would refuse
 * the old phase's last confirm.
 */
let saving=null;
/** Answers that mean the computer was still waking when the share gave up. */
const WAKING=['sandbox_starting','timeout','fetch_failed'];
/** A Universe, media-service or Git-gateway call that did not answer: retry, never a refusal. */
const UNREACHABLE=['assignment_open_unavailable','media_unavailable','repo_url_unavailable'];
/**
 * `finish` causes that are not faults: the participant's own stop (the browser's Stop sharing, the indicator) and the
 * assignment closing (submitted, its hour ended). Never a bare `timeout`: that is a mint that gave up.
 */
const DELIBERATE=['track_ended','indicator_stop','universe_submitted','universe_timeout','deadline'];

/**
 * Gate evidence for a feedback report (telemetry's local mirror) and the wire: which step failed and why. Codes and
 * stages only: never an attempt, session or recording id, a URL or a proof.
 */
function report(stage,code,item,{outcome='error',reason,correlationId,detail}={}) {
    telemetry.capture({eventClass:'api_failure',site:'ezil-os:assignment#'+stage,code,outcome,detail,
        durationMs:item?.startedAt?Date.now()-item.startedAt:undefined,reason,serverCorrelationId:correlationId});
}

/** `promise` within `ms`: `{done:true,ok,value}` once it settles, `{done:false}` if it has not by then. */
function settle(promise,ms) {
    let timer;
    return Promise.race([Promise.resolve(promise).then(value=>({done:true,ok:true,value}),()=>({done:true,ok:false})),
        new Promise(resolve=>{timer=setTimeout(()=>resolve({done:false}),ms);})]).finally(()=>clearTimeout(timer));
}

/** The gate's copy for a share that failed, chosen by its actual cause. Footage is claimed only once a segment was confirmed. */
function causeMessage(cause,error,item) {
    const again=item.accepted?' Accepted footage is preserved. Share this OS tab to resume.':' Share this OS tab again to open your assignment.';
    if(cause==='wrong_tab')return 'Select this EZiL OS tab. The other source was discarded.';
    if(error?.name==='NotAllowedError')return 'Sharing was declined. Share this OS tab to open your editor.';
    if(cause==='repo_open_unsupported_provider')return 'This computer does not support assignment recording. Select a Cloudflare computer you own in EZiL OS, then reopen the assignment.';
    if(cause==='assigned_checkout_unverified')return 'The assigned checkout could not be verified.'+(item.accepted?' Accepted footage is preserved.':'')+' Share this tab to try again.';
    if(cause==='assignment_recording_required')return 'This assignment opens only in its own recorded EZiL OS tab. Open it again from Universe.';
    if(WAKING.includes(cause))return 'Your computer is still starting.'+again;
    if(UNREACHABLE.includes(cause))return 'EZiL OS could not reach Universe to verify your assignment.'+again;
    if(cause==='no_current_frame')return 'This tab stopped sending video to the recorder. Keep this EZiL OS tab in front while it is shared.'+again;
    if(/^billing_/.test(cause))return 'This computer could not start under your EZiL OS plan. Check Settings, then try again.'+again;
    if(/^capacity_/.test(cause))return 'No computer is available to start right now.'+again;
    return item.accepted?'Recording was interrupted. Accepted footage is preserved. Share this OS tab to resume.'
        :'Sharing was interrupted before recording started. Share this OS tab again to open your assignment.';
}

export function assignmentIntent(href,repoUrl) {
    const candidate=canonical.exec(repoUrl)?.[1];
    if(!uuid.test(candidate??''))return null;
    let url;try{url=new URL(href);}catch{return null;}
    if(!assignmentOsOrigin(url.origin) || url.pathname!=='/app/code' || url.username || url.password
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

export function openWithAssignmentConsent({project, computerId, actor, open, body, park, prepare, computerProvider, settleMs=STOP_SETTLE_MS,
    saveCeilingMs=STOP_SAVE_CEILING_MS, frameMs=FRESH_FRAME_MS, clockLiveMs=CLOCK_LIVE_MS, clockIdleMs=CLOCK_IDLE_MS, reconnectMs=RECONNECT_OFFER_MS}) {
    const win=globalThis.window, repo=project?.repoUrl;
    if(!win || !assignmentOsOrigin(win.location.origin)){queueMicrotask(open);return null;}
    const address=new URL(win.location.href);
    const entry=address.searchParams.has('repo')||address.searchParams.has('assignment')?address.href:initialEntry;
    const attemptId=assignmentIntent(entry,repo);
    const explicit=address.pathname==='/app/code' && address.searchParams.has('assignment');
    if(!canonical.test(repo) && !explicit){queueMicrotask(open);return null;}

    const owner=actor(), ui=buildGate(body);
    // `shown`: the ended share whose result the gate is showing; a late save result refreshes only its own screen.
    let disposePromise, disposed=false, locked=true, picker, activity, indicator, shown, clockTimer, over=false;
    // The server's clock for this assignment. It outlives a share: a stop, a close or a restart never touches it.
    const countdown=createCountdown();
    const isOwner=()=>Boolean(owner) && actor()===owner;
    const isHere=()=>!disposed && current===gate && isOwner() && win===win.top;
    const samePhase=item=>isHere() && activity===item && !item.ended;
    // The exact tab is still shared. A muted track is still this tab; it only presents no new frames.
    const sameTab=item=>samePhase(item) && Boolean(item.source?.matches());
    const recordingSource=item=>sameTab(item) && !item.paused && !item.source.stream.getVideoTracks()[0].muted;
    // While the server's clock is paused (`item.gated`) the share, the transport and the editor's mint stay alive. A muted
    // track is expected then (the tab shows the computer reconnecting), so it does not block the mint.
    const mintSource=item=>item.gated?sameTab(item):recordingSource(item);
    function lockedView(title,message) {
        locked=true;park(true);ui.clear();ui.set(title,message);
    }
    /** The corner control, in `state`. It is created with the share and kept after a stop while the clock still counts. */
    function showIndicator(state) {
        if(!indicator)indicator=createStatusControl({win,countdown,
            onStop:()=>{if(activity)void finish(activity,'sharing_stopped',{cause:'indicator_stop'});}});
        indicator.set(state);
    }
    function removeIndicator(){indicator?.remove();indicator=null;}
    /** A share ended: keep the corner control (stopped, or time ended) while the server's clock is running, else drop it. */
    function endIndicator(reason){
        if(reason==='submitted' || !countdown.started())removeIndicator();
        else showIndicator(reason==='timeout'?'ended':'stopped');
    }
    /**
     * A report of the canonical assignment countdown: the shell route's `clock` action, or the `editor-ready` answer.
     * Redraws the control and applies the server's pause. Only the server starts, pauses or extends this clock: nothing
     * local (checkout, a resize, progress) does, and the media window of the recording (below) never feeds it.
     */
    function applyClock(report){
        if(disposed || !countdown.sync(report))return;
        const item=activity&&!activity.ended&&isHere()?activity:null;
        if(item)applyGate(item);
        else if(!indicator && !over && countdown.started())showIndicator(countdown.state()==='ended'?'ended':'idle');
        indicator?.sync();
    }
    /**
     * The recording's own window (begin / seed confirm / status: `startedAt`, `deadlineAt`, in server time). It bounds the
     * recording only: it moves the recorder's deadline and the share's deadline timer, never the countdown.
     */
    function syncMedia(item,report){
        const deadline=Date.parse(report?.deadlineAt),start=Date.parse(report?.startedAt);
        if(!samePhase(item)||!Number.isFinite(deadline))return;
        if(Number.isFinite(start))item.mediaStart=start;
        item.mediaDeadline=deadline;
        item.recorder?.setDeadline(deadline);
        armDeadline(item);
    }
    async function refreshClock(){
        if(disposed)return;
        try{applyClock(await checkAssignmentClock(attemptId));}catch{/* the next poll asks again; the shown time keeps counting */}
    }
    // Rehydrated after a refresh (once the assignment is verified), while a share is live (so a pause or a start reaches
    // the capture within seconds) and slowly after a share stops, until the time is over.
    function scheduleClock(){
        clearTimeout(clockTimer);
        if(disposed || over || countdown.state()==='ended')return;
        clockTimer=setTimeout(async()=>{await refreshClock();scheduleClock();},activity&&!activity.ended?clockLiveMs:clockIdleMs);
    }
    function armDeadline(item){
        clearTimeout(item.deadline);
        // A server-stopped clock has no deadline to meet; the resume report re-arms it.
        if(countdown.state()==='paused' || item.mediaDeadline===undefined || item.offset===undefined)return;
        item.deadline=setTimeout(()=>void deadlineReached(item),Math.max(0,item.mediaDeadline-item.offset-Date.now()));
    }
    /** The local copy of the recording's deadline passed: ask the server first, since it may have moved it. */
    async function deadlineReached(item){
        if(!samePhase(item))return;
        await Promise.all([refreshClock(),item.transport.status().catch(()=>{})]);
        if(!samePhase(item))return;
        if(countdown.state()==='paused' || item.mediaDeadline-item.offset-Date.now()>1500){armDeadline(item);return;}
        void finish(item,'timeout',{at:new Date(item.mediaDeadline).toISOString(),cause:'deadline'});
    }
    /**
     * The server's pause gates capture. Paused: recording stops (the clip so far is sealed and kept), the editor is
     * covered and the share, the transport and the capture lease stay. Not paused any more: capture resumes once the
     * editor has been re-verified on the assigned checkout; the pause stays a gap on the real timeline.
     */
    function applyGate(item){
        const paused=countdown.state()==='paused';
        if(paused&&!item.gated){
            item.gated=true;item.reverified=false;
            clearTimeout(item.editorTimeout);clearTimeout(item.reconnect);
            item.recorder?.hold(countdown.serverPausedAt());
            showIndicator('paused');
            lockedView('Assignment time paused',
                'Universe paused your assignment time and recording for a system upgrade. Keep this EZiL OS tab shared: your editor opens and recording resumes when it is available again. '
                +'If sharing ends meanwhile, share this tab again to resume. Saved footage and your assignment attempt are kept.');
        }else if(paused&&item.gated)showIndicator('paused');
        else if(!paused&&item.gated)resumeGated(item);
    }
    function resumeGated(item){
        if(!sameTab(item))return;
        if(!item.reverified){
            if(item.reconnect)return;
            lockedView('Waiting for your editor','Assignment time is running again. Recording resumes once your editor is checked on your assigned checkout…');
            // Nothing re-opens an editor that was never disturbed: offer the same open the editor itself uses.
            item.reconnect=setTimeout(()=>{if(samePhase(item)&&item.gated&&!item.reverified)ui.action('Reconnect editor',()=>{if(item.gated&&!item.reverified)open();});},reconnectMs);
            return;
        }
        clearTimeout(item.reconnect);item.reconnect=null;
        item.gated=false;item.reverified=false;
        if(item.recorder?.held()){item.releasing=true;item.recorder.release();}
        else{showIndicator('recording');revealEditor(item);}
    }
    function check(item){if(!sameTab(item))throw failure('source_lost');}
    function revealEditor(item){
        if(!recordingSource(item)||!item.editorFrame?.isConnected)return;
        locked=false;park(false);ui.reveal();item.editor?.resolve();
    }
    function pauseCapture(item){
        if(!sameTab(item)||item.paused)return;
        let resolve;
        const promise=new Promise(done=>{resolve=done;});
        item.paused={promise,resolve};
        lockedView('Recording paused','Waiting for a fresh frame from this EZiL OS tab…');
        showIndicator('interrupted');
    }
    function clearPause(item){
        item.paused?.resolve();
        item.paused=null;
    }
    function resumeCapture(item){
        if(!sameTab(item)||!item.paused)return;
        clearPause(item);
        showIndicator('recording');
        if(item.editorFrame?.isConnected)revealEditor(item);
        else if(item.editorFrame)void finish(item,'connection_lost',{cause:'assigned_checkout_unverified',
            message:causeMessage('assigned_checkout_unverified',null,item)});
        else ui.set('Opening assigned editor','Recording is active. Checking your workspace…');
    }
    function displayConsent(message) {
        lockedView('Record this assignment tab',message || 'Share only this EZiL OS tab to open the assignment. The job creator can review saved work even if you do not submit.');
        if(message)ui.set('Record this assignment tab',message+' The job creator can review saved work even if you do not submit.');
        ui.action('Share this OS tab and open assignment',share);
    }
    function showSignIn(){
        lockedView('Sign in to EZiL OS','Return to this assignment after signing in.');
        const dest='/app/code?'+new URLSearchParams({repo,assignment:attemptId});
        ui.action('Sign in to EZiL OS',()=>win.location.assign('/auth/auth0/login?'+new URLSearchParams({returnUrl:dest})));
    }
    async function eligible(){
        lockedView('Checking assignment','Verifying the assigned repository and OS session…');
        try{
            const result=await retry(()=>checkAssignmentVideoEligibility(attemptId),['media_unavailable','recording_unavailable']);
            if(!isHere())return;
            if(result.status!=='eligible' || result.attemptId!==attemptId || result.repositoryUrl!==repo)throw failure('assignment_mismatch');
            // The same attempt's clock is available while the provider is unavailable or sharing is stopped.
            void refreshClock();scheduleClock();
            if (win.location.origin === 'https://os.ezil.work') {
                const provider = await computerProvider?.();
                if (!isHere()) return;
                const upgradedAssignment = provider === 'aws-ec2'
                    && /^[a-f0-9]{64}$/.test(result.upgradedWorkspaceId ?? '')
                    && uuid.test(result.upgradeOperationId ?? '');
                if (provider !== 'cloudflare' && !upgradedAssignment) {
                    lockedView('Choose an assignment-ready computer',provider === 'aws-ec2'
                        ? 'This AWS computer does not support assignment recording. Select a Cloudflare computer you own in EZiL OS, then reopen the assignment.'
                        : 'EZiL OS could not verify this computer’s assignment support. Check its provider in Settings → System, then try again.');
                    ui.action('Check this computer again',eligible);
                    return;
                }
            }
            picker??=currentTabPicker(win);
            displayConsent();
        }catch(e){
            if(!isHere())return;
            if(e.code==='identity_refresh_required'){showSignIn();return;}
            const unsupported=e.message==='unsupported';
            lockedView('Assignment unavailable',unsupported?'This browser cannot verify sharing of this OS tab.':'The assigned repository or recording service could not be verified.');
            if(!unsupported)ui.action('Retry verification',eligible);
        }
    }
    function share() {
        if(!isHere()||!picker||activity)return;
        const item={id:win.crypto.randomUUID(),expected:0,captureCtl:new AbortController()};
        activity=item;
        // choose invokes the native picker synchronously inside the trusted user's action.
        const selection=picker.choose();
        lockedView('Share this OS tab','Choose this EZiL OS tab in your browser.');
        item.starting=start(item,selection);
    }
    async function start(item,selection) {
        item.startedAt=Date.now();item.stage='share';
        const live=()=>samePhase(item);
        try{
            const source=await selection;
            if(!samePhase(item)){source.stream.getTracks().forEach(t=>t.stop());return;}
            item.source=source;
            const track=source.stream.getVideoTracks()[0];
            track.addEventListener('ended',()=>void finish(item,'sharing_stopped',{cause:'track_ended'}),{once:true});
            track.addEventListener('mute',()=>{
                if(!samePhase(item))return;
                if(item.recorder)item.recorder.pause();
                else report(item.stage,'track_muted',item,{outcome:'skipped'});
            });
            track.addEventListener('capturehandlechange',()=>{if(!sameTab(item))void finish(item,'connection_lost',{cause:'capture_handle_changed'});});
            item.watch=setInterval(()=>{if(!sameTab(item))void finish(item,'connection_lost',{cause:'source_lost'});},1100);
            showIndicator('sharing');lockedView('Preparing assignment','Verifying the assigned repository…');
            item.stage='prepare';item.prepareCtl=new AbortController();
            const result=await retry(()=>prepare(attemptId,{signal:item.prepareCtl.signal}),['sandbox_starting','media_unavailable','assignment_open_unavailable'],3,live);
            check(item);
            const proof=result?.assignmentOpen, meta=result?.repository, name=repo.split('/').at(-1).slice(0,-4);
            if(result.ok!==true||result.codePreviewUrl||result.url||proof?.attemptId!==attemptId||!/^[A-Za-z0-9_-]{48,1700}$/.test(proof.proof)
                ||!meta?.id||typeof meta.workspaceFolder!=='string'||meta.checkoutFolder!==meta.workspaceFolder+'/'+name)
                throw failure('assigned_checkout_unverified');
            item.meta=meta;item.proof=proof.proof;
            // An earlier share's last footage is still being saved: its phase must be checkpointed before this one begins.
            // Waited here, before any transport exists, so a stop meanwhile is still a share that never reached Universe.
            for(let earlier;(earlier=saving);){
                item.stage='wait';
                lockedView('Preparing assignment','Saving your earlier footage before recording resumes…');
                await earlier.done;
                check(item);
            }
            item.stage='begin';
            item.transport=createAssignmentVideoTransport({attemptId,repoOpenProof:item.proof,captureSessionId:item.id,consentVersion:4,
                onClock:report=>syncMedia(item,report),paused:()=>countdown.state()==='paused',
                // The timeline is the real wall clock: time the server gave back after a pause lets a clip end past the first hour.
                maxEndMs:()=>{
                    if(item.mediaStart===undefined)return 0;
                    const media=item.mediaDeadline===undefined?0:item.mediaDeadline-item.mediaStart;
                    const canonicalEnd=countdown.serverDeadlineAt();
                    return Math.max(media,canonicalEnd===null?0:canonicalEnd-item.mediaStart);
                },
                onStop:(why,at)=>void finish(item,why==='submitted'||why==='timeout'?why:'connection_lost',{at,cause:'universe_'+why})});
            // A stop while this is in flight still checkpoints the phase it opens once it lands (`save`), never orphans it.
            item.beginning=retry(()=>item.transport.begin(),['media_unavailable'],2,live);
            item.grant=await item.beginning;
            check(item);
            if(item.grant.captureSessionId!==item.id||item.grant.status!=='awaiting_frame'||!Number.isSafeInteger(item.grant.nextSequence))
                throw failure('recording_phase_changed');
            item.expected=item.grant.nextSequence;
            item.stage='seed';
            const bytes=await seedFrame(source.stream,()=>sameTab(item),
                ()=>{if(samePhase(item))ui.set('Checking recording','Saving the first frame before opening your editor…');},frameMs);
            check(item);
            const upload=part=>retry(()=>item.transport.upload(part),['upload_failed','media_unavailable'],2);
            const ack=await upload({sequence:item.expected,startMs:0,endMs:1,mimeType:'video/webm',bytes});
            check(item);
            if(!ack.phaseReady || ack.captureSessionId!==item.id || ack.nextSequence!==item.expected+1 || !ack.firstFrameAt)
                throw failure('seed_not_confirmed');
            item.expected=ack.nextSequence;item.accepted=true;
            const startAt=Date.parse(ack.startedAt), deadline=Date.parse(ack.deadlineAt), serverNow=Date.parse(ack.serverNow);
            const offset=Number.isFinite(serverNow)?serverNow-Date.now():0;
            if(!Number.isFinite(startAt)||!Number.isFinite(deadline)||deadline<=Date.now()+offset||deadline<=startAt||deadline-startAt>3600000)
                throw failure('recording_closed');
            // The seed's window bounds the recording only; the countdown starts at the verified editor (`ready`).
            item.offset=offset;
            syncMedia(item,ack);
            item.stage='record';
            item.recorder=await encodeTabSegments({win,stream:source.stream,matches:()=>sameTab(item),windowStart:startAt,deadline,
                signal:item.captureCtl.signal,
                firstSequence:item.expected,clockOffset:offset,upload:part=>{item.expected=Math.max(item.expected,part.sequence+1);return upload(part);},
                cutoff:async()=>{
                    const state=await item.transport.status();
                    const cutoffs=[Date.parse(state.stopRequestedAt),countdown.serverPausedAt()].filter(Number.isFinite);
                    return cutoffs.length?new Date(Math.min(...cutoffs)).toISOString():null;
                },
                onFault:(code)=>{
                    const cause=code||'recorder_fault';
                    if(cause==='deadline'){
                        void finish(item,'timeout',{at:new Date(countdown.serverDeadlineAt()).toISOString(),cause});
                        return;
                    }
                    if(samePhase(item))report('record',cause,item);
                    void finish(item,'connection_lost',{cause,message:causeMessage(cause,null,item)});
                },
                onPause:()=>pauseCapture(item),
                onResume:()=>{
                    // The recorder is recording again after a system hold: only now does the editor come back.
                    if(item.releasing){item.releasing=false;showIndicator('recording');revealEditor(item);return;}
                    resumeCapture(item);
                },
                onAwaitFrame:()=>{if(samePhase(item))ui.set('Opening assigned editor','Recording is active. Checking your workspace…');}});
            if(item.gated)item.recorder.hold(countdown.serverPausedAt());
            check(item);
            item.stage='confirm';
            await retry(async()=>{
                const state=await item.transport.status();
                if(state.phaseReady!==true||state.workspaceUnlocked!==true||state.captureSessionId!==item.id||state.startedAt!==ack.startedAt
                  ||state.deadlineAt!==ack.deadlineAt||!state.firstFrameAt)throw failure('seed_not_confirmed');
            },['seed_not_confirmed','media_unavailable'],3,live);
            if(track.muted)item.recorder.pause();
            while(item.paused)await item.paused.promise;
            check(item);
            item.stage='open';
            item.allowMint=true;showIndicator('recording');
            const editor=new Promise((resolve,reject)=>{item.editor={resolve,reject};});
            item.editorTimeout=setTimeout(()=>item.editor?.reject(failure('assigned_checkout_unverified')),80000);
            open();await editor;
        }catch(error){
            if(activity!==item||item.ended)return;
            const cause=error.code||error.message||'unknown';
            report(item.stage,error.name==='NotAllowedError'?'not_allowed':cause,item,{reason:error.reason,correlationId:error.correlationId});
            const identity=cause==='identity_refresh_required'||cause==='IDENTITY_REFRESH_REQUIRED';
            void finish(item,'connection_lost',{message:causeMessage(cause,error,item),signIn:identity,cause});
        }finally{clearTimeout(item.editorTimeout);item.editor=null;}
    }
    function confirmed(frame,frameUrl,actualRoot){
        const item=activity;
        // `item.gated`: a re-open after the server's pause, once the first editor is long open (`item.editor` is gone).
        if(!item?.allowMint||!(item.editor||item.gated)||!sameTab(item)||!frame.isConnected)return;
        const url=new URL(frameUrl), folders=[item.meta.workspaceFolder,item.meta.checkoutFolder];
        if(!folders.includes(actualRoot)||!folders.includes(url.searchParams.get('folder'))){
            if(item.editor)item.editor.reject(failure('assigned_checkout_unverified'));
            else void finish(item,'connection_lost',{cause:'assigned_checkout_unverified',message:causeMessage('assigned_checkout_unverified',null,item)});
            return;
        }
        item.editorFrame=frame;
        void ready(item,frame);
    }
    /**
     * The interactive assigned editor was validated. Before it is shown, Universe is told (`editor-ready`): that is what
     * starts the canonical countdown (and, after a pause, lets the server resume it). The answer is the clock; the browser
     * sends no time. A transient failure is retried with the editor still covered, never released unverified. While the
     * server's clock is paused the gate stays; once it allows, capture resumes.
     */
    async function ready(item,frame){
        if(item.readying===frame)return;
        item.readying=frame;
        const live=()=>samePhase(item)&&item.editorFrame===frame&&frame.isConnected;
        ui.clear();
        if(!item.gated)ui.set('Checking your editor','Confirming your editor with Universe before it opens…');
        try{
            const clock=await retry(()=>item.transport.editorReady(),EDITOR_READY_TRANSIENT,EDITOR_READY_TRIES,live);
            if(!live())return;
            if(item.gated)item.reverified=true;
            const wasGated=item.gated;
            applyClock(clock);
            if(wasGated){
                // Still paused: stay covered. Allowed: capture is resuming and the recorder's first fresh frame reveals the editor.
                if(item.gated&&countdown.state()!=='paused')resumeGated(item);
                return;
            }
            revealEditor(item);
        }catch(error){
            if(!live())return;
            const cause=error.code||'editor_ready_failed';
            if(EDITOR_READY_TRANSIENT.includes(cause)){
                ui.set('Checking your editor','Universe could not confirm your editor yet. Your editor stays closed until it does.');
                ui.action('Check again',()=>{if(live()){item.readying=null;void ready(item,frame);}});
                return;
            }
            report('editor-ready',cause,item,{reason:error.reason,correlationId:error.correlationId});
            void finish(item,'connection_lost',{cause,message:causeMessage(cause,error,item)});
        }finally{if(item.readying===frame)item.readying=null;}
    }
    /** The gate's screen for an ended share. `saved` null: its footage is still being saved, so nothing is claimed yet. */
    function showEnded(item,reason,saved){
        shown=item;
        if(reason==='submitted'||reason==='timeout'){lockedView('Assignment closed',reason==='submitted'?'Assignment submitted. Recording ended.':'The assignment time has ended.');return;}
        if(item.signIn){showSignIn();return;}
        const stopped=!item.accepted?'Sharing stopped. Share this OS tab again to open your assignment.'
            :saved===null?'Sharing stopped. Your last footage is still uploading. Share this OS tab again to resume.'
            :saved?'Sharing stopped. Share this OS tab again to resume.':'Sharing was interrupted. Your recording may contain a gap.';
        displayConsent(item.message||stopped);
    }
    function settled(item,reason,saved,cause,late=false){
        // `cause` tells a participant's stop from a self-fault; the detail says how far the share got. `late`: the gate
        // was handed back before the footage finished saving.
        report('finish',cause,item,{outcome:DELIBERATE.includes(cause)?'skipped':'error',
            detail:'stage:'+item.stage+';reason:'+reason+';began:'+(item.transport?1:0)+';accepted:'+(item.accepted?1:0)
                +';saved:'+(saved?1:0)+';late:'+(late?1:0)});
        // A late result refreshes only its own screen: never a newer share, or the screen of one that ended since.
        if(!isHere()||(late&&(activity||shown!==item)))return;
        showEnded(item,reason,saved);
    }
    /**
     * Save a stopped share's footage, strictly in order: the start pipeline settles (a begin in flight lands, the seed's
     * confirm answers), the recorder joins its in-flight segment and seals and confirms the last one, and only then is
     * the phase checkpointed (or finalized) and the transport released. A checkpoint that overtook a confirm would
     * refuse it. Each step is bounded by the transport's own timeouts, the whole by `saveCeilingMs`. Never rejects.
     */
    async function save(item,reason,effectiveAt){
        const transport=item.transport;
        let saved=true;
        try{
            const drained=await settle((async()=>{await item.starting;return item.recorder?.stop(effectiveAt);})(),saveCeilingMs);
            if(!drained.done||!drained.ok)saved=false;
            else if(drained.value)item.expected=drained.value.expectedSegments;
            // A phase this share opened is checkpointed even past the ceiling (begin is bounded by its own timeouts).
            await item.beginning?.catch(()=>{});
            if(item.grant){
                if(reason==='submitted'||reason==='timeout')await transport.finalize({reason,expectedSegments:item.expected});
                else await retry(()=>transport.checkpoint(reason==='sharing_stopped'?'sharing_stopped':'connection_lost'),['media_unavailable']);
            }
        }catch{saved=false;}
        finally{transport.dispose();}
        return saved;
    }
    /**
     * End this share. Never leaves the gate on "Checking saved assignment footage…": a share that never reached Universe
     * (no begin sent) is released at once; otherwise the gate is handed back within `settleMs` while `save` finishes
     * the footage in the background, and the screen is refreshed with its result.
     */
    function finish(item,reason='sharing_stopped',{at:effectiveAt=null,message,signIn=false,cause=reason}={}){
        if(activity!==item)return Promise.resolve();
        if(item.ending)return item.ending;
        item.ended=true;item.allowMint=false;item.message=message;item.signIn=signIn;
        clearInterval(item.watch);clearTimeout(item.deadline);clearTimeout(item.editorTimeout);
        // Ended first, so the aborted mint's `cancelled` lands in start()'s silent return.
        item.prepareCtl?.abort();
        item.captureCtl.abort();
        clearPause(item);
        item.editor?.reject(failure('workspace_locked'));
        item.source?.stream.getTracks().forEach(t=>t.stop());
        clearTimeout(item.reconnect);item.gated=false;item.reverified=false;item.releasing=false;
        // The corner control stays while the server's clock counts: a stop ends the share, never the time.
        endIndicator(reason);
        // The assignment closed (submitted, or its time ended): nothing is left to ask the server about.
        if(reason==='submitted'||reason==='timeout'){over=true;clearTimeout(clockTimer);}
        else{void refreshClock();scheduleClock();}
        if(!item.transport){
            // Nothing reached Universe: there is no capture phase to checkpoint and nothing was recorded.
            activity=null;
            item.ending=Promise.resolve();
            settled(item,reason,true,cause);
            return item.ending;
        }
        lockedView('Sharing stopped','Checking saved assignment footage…');
        const entry={item,done:save(item,reason,effectiveAt)};
        saving=entry;
        void entry.done.finally(()=>{if(saving===entry)saving=null;});
        item.ending=(async()=>{
            const quick=await settle(entry.done,settleMs);
            if(activity===item)activity=null;
            if(!quick.done&&isHere())showEnded(item,reason,null);
            settled(item,reason,await entry.done,cause,!quick.done);
        })();
        return item.ending;
    }
    /** Closing hands the screen back at once; a share's footage keeps saving, and the returned promise waits for it. */
    function close(){
        if(disposePromise)return disposePromise;
        disposed=true;const item=activity;
        win.removeEventListener('pagehide',pageHide);
        const ended=item?finish(item,'connection_lost',{cause:'window_closed'}):Promise.resolve();
        clearTimeout(clockTimer);
        picker?.dispose();removeIndicator();ui.remove();if(current===gate)current=null;
        disposePromise=Promise.all([ended,saving?.done]).then(()=>{});
        return disposePromise;
    }
    // A closing document cannot finish an upload: keep the accepted clips of the live share and of one still saving.
    function pageHide(){
        for(const item of new Set([activity,saving?.item]))if(item?.grant)item.transport.checkpointOnExit('connection_lost');
        void close();
    }
    /** Code's open-phase mint failed (`apps/code.js`): end the wait for the editor now, with the real cause. */
    function failOpen(res){
        const item=activity;if(!item?.editor)return;
        item.editor.reject(Object.assign(failure(res?.errorCode||'unknown'),{reason:res?.reason,correlationId:res?.correlationId}));
    }
    const gate={repo,locked:()=>locked,confirm:confirmed,close,fail:failOpen,
        access:()=>activity?.allowMint&&mintSource(activity)?{attemptId,phase:'open',repoOpenProof:activity.proof,captureSessionId:activity.id}:null};
    current=gate;
    if(!attemptId||!isOwner()||win!==win.top){
        lockedView('Open your assigned OS tab','Use the assignment link in Universe to open the verified workspace in its own OS tab.');
    }else{win.addEventListener('pagehide',pageHide,{once:true});void eligible();}
    return gate;
}

export function confirmAssignmentFolder(project,_receipt,frame,frameUrl,actualRoot){
    if(current?.repo===project?.repoUrl)current.confirm(frame,frameUrl,actualRoot);
}
