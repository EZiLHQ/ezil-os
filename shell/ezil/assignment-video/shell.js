import {checkAssignmentClock,checkAssignmentVideoEligibility,createAssignmentVideoTransport} from './transport.js';
import { currentTabPicker, assignmentOsOrigin } from './current-tab.js';
import { encodeTabSegments, seedFrame } from './tab-segments.js';
import { createCountdown } from './countdown.js';
import { createStatusControl } from './status-control.js';
import { embeddedWorkHost, respondToWorkDiscover, WORK_PROTOCOL } from './work-protocol.js';
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
    if(cause==='assignment_aws_unverified')return 'This AWS computer is not verified for this assignment. Reopen it from Universe on the computer you started with, or select a Cloudflare computer you own.';
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

/**
 * Why this production computer may not hold the assignment yet, or null when it may. Cloudflare always may. AWS only as
 * a committed upgrade of this workspace (`upgradedWorkspaceId` + `upgradeOperationId`) or a direct start: Universe's
 * trusted `boundWorkspaceId` must be present, null only before a window started, or the workspace it bound. The server
 * alone checks it against this computer's own workspace.
 * `workspaceStart`: the embedded workspace also accepts the one other first opening, the window Universe itself started
 * in its workspace page before any computer opened the attempt (`startMode:'workspace'`, still unbound). The top-level
 * tab keeps refusing a running window without a binding.
 */
function computerRefusal(result,info,workspaceStart=false) {
    const provider = info?.provider;
    const upgradedAssignment = provider === 'aws-ec2'
        && /^[a-f0-9]{64}$/.test(result.upgradedWorkspaceId ?? '')
        && uuid.test(result.upgradeOperationId ?? '');
    const bound = result.boundWorkspaceId;
    const startedByWorkspace = workspaceStart && result.startMode === 'workspace'
        && Number.isFinite(Date.parse(result.windowStartedAt)) && Number.isFinite(Date.parse(result.deadlineAt));
    const directAssignment = provider === 'aws-ec2'
        && ((bound === null && ((!result.windowStartedAt && !result.deadlineAt) || startedByWorkspace)) || /^[a-f0-9]{64}$/.test(bound ?? ''));
    if (provider !== 'cloudflare' && !upgradedAssignment && !directAssignment) return provider === 'aws-ec2' ? 'aws_unverified' : 'provider_unknown';
    if (provider === 'aws-ec2' && ['STOPPING','DRAINING','RETIRING'].includes(info.lifecycleState)) return 'stopping';
    if (provider === 'aws-ec2' && info.lifecycleState === 'RUNNING' && info.assignmentSession === 'stop_then_reopen') return 'stop_then_reopen';
    return null;
}
const COMPUTER_REFUSAL={
    aws_unverified:['Choose an assignment-ready computer','Universe has not verified this AWS computer for this assignment. Reopen the assignment from Universe, or select a Cloudflare computer you own in EZiL OS.'],
    provider_unknown:['Choose an assignment-ready computer','EZiL OS could not verify this computer’s assignment support. Check its provider in Settings → System, then try again.'],
    stopping:['Stopping your computer','Wait until Settings → Computer shows Stopped, then reopen this assignment on this same computer.'],
    stop_then_reopen:['Update this computer for your assignment',
        'Save your work, then choose Stop in Settings → Computer. Wait until it says Stopped and reopen this assignment from Universe on this same computer. Your files stay on its disk.'],
};

const EMBED_SIGN_IN='Continue to EZiL OS sign-in from your Universe assignment tab.';
const EMBED_UNAVAILABLE='This assignment workspace could not be verified here. Return to your Universe assignment to try again.';
const EMBED_AGAIN='Share this tab again from Universe to resume your assignment.';
const EMBED_PAUSED=['Sharing paused',EMBED_AGAIN];
const EMBED_HELD=['Assignment time paused',
    'Universe paused your assignment time and recording for a system upgrade. Saved footage and your assignment attempt are kept. Share this tab again from Universe when your time is running again.'];
/** The parent's heartbeat: checked every `EMBED_WATCH_MS`, and a share whose parent has been silent for `EMBED_SILENT_MS` is saved as interrupted. */
export const EMBED_WATCH_MS=2800;
export const EMBED_SILENT_MS=14000;
/** Two reports of the canonical start are the same clock within this (the same instant serialized at another precision). */
const SAME_START_MS=1000;
const identityCodes=['identity_refresh_required','IDENTITY_REFRESH_REQUIRED','assignment_identity_mismatch'];
const replyCode=error=>typeof error?.code==='string' && /^[A-Za-z_]{1,64}$/.test(error.code) ? error.code : 'workspace_unavailable';
const isoOrNull=value=>typeof value==='string' && Number.isFinite(Date.parse(value)) ? value : null;
/** The frame's copy for a share that failed: the cause's own sentence, then how to resume (the picker is Universe's). */
function embedMessage(cause) {
    if(cause==='assignment_paused')return EMBED_HELD[1];
    if(cause==='repo_open_unsupported_provider')return 'This computer does not support assignment recording. Select a Cloudflare computer you own in EZiL OS, then reopen the assignment.';
    if(cause==='assignment_aws_unverified')return 'This AWS computer is not verified for this assignment. Reopen it from Universe on the computer you started with, or select a Cloudflare computer you own.';
    if(cause==='assigned_checkout_unverified')return 'The assigned checkout could not be verified. '+EMBED_AGAIN;
    if(WAKING.includes(cause))return 'Your computer is still starting. '+EMBED_AGAIN;
    if(UNREACHABLE.includes(cause))return 'EZiL OS could not reach Universe to verify your assignment. '+EMBED_AGAIN;
    if(/^billing_/.test(cause))return 'This computer could not start under your EZiL OS plan. Check Settings, then try again. '+EMBED_AGAIN;
    if(/^capacity_/.test(cause))return 'No computer is available to start right now. '+EMBED_AGAIN;
    return EMBED_AGAIN;
}
/** A parent that has not asked by now is told so; until then the Code window's own loader is the only surface. */
const SILENT_PARENT_MS=20000;
/** The media window's bound before any pause: the hour, or 64 minutes for a preparation window Universe manages. */
const WINDOW_MS=3600000;
const MEDIA_WINDOW_MS=3840000;
const isoTime=value=>typeof value==='string' && value.length<=40 && Number.isFinite(Date.parse(value)) ? value : null;
const REFUSALS={
    identity:[...identityCodes,'UNAUTHORIZED','unauthorized'],
    checkout:['assigned_checkout_unverified','assignment_open_unavailable','assignment_open_required','repo_open_failed','sandbox_starting','assignment_aws_unverified','workspace_disconnected'],
    phase:['recording_phase_changed','recording_in_use','recording_closed','recording_changed','recording_unavailable','seed_not_confirmed','assignment_not_ready','workspace_locked','cancelled',
        'assignment_paused','assignment_clock_changed','recording_state_changed'],
    media:['media_unavailable','upload_failed','upload_unconfirmed','invalid_segment','invalid_upload_target'],
    timeout:['timeout','workspace_timeout'],
    protocol:['invalid_request','invalid_assignment','assignment_mismatch','editor_ready_failed'],
};
/** A coarse class for a refusal: the only thing a diagnostic says about why. */
export function refusalClass(error) {
    const cause=error?.code||error?.message;
    if(error?.name==='TimeoutError')return 'timeout';
    return Object.keys(REFUSALS).find(kind=>REFUSALS[kind].includes(cause))??'other';
}
/**
 * Console-only diagnostics for one attempt, as `assignment.workspace.<event> stage=<tag>[ refusal=<class>]`. The tag is
 * the first 16 hex of SHA-256(`ezil.assignment.stage.v1\0` + attempt id), which the server logs too. A line names no
 * person, account, repository, session, challenge or capture. Without Web Crypto nothing is written; nothing waits on it.
 */
export function stageDiagnostics(attemptId, {subtle=globalThis.crypto?.subtle, log=globalThis.console}={}) {
    let tag;
    try{
        tag=subtle.digest('SHA-256',new TextEncoder().encode('ezil.assignment.stage.v1\0'+attemptId))
            .then(bytes=>Array.from(new Uint8Array(bytes).subarray(0,8),n=>n.toString(16).padStart(2,'0')).join(''),()=>null);
    }catch{return ()=>{};}
    return (event,error)=>{
        const refusal=error===undefined?'':' refusal='+refusalClass(error);
        void tag.then(value=>{if(value)try{log.info('assignment.workspace.'+event+' stage='+value+refusal);}catch{/* diagnostics never matter */}});
    };
}

/**
 * The assignment framed by its own Universe workspace page, which records ITS tab (`ezil.assignment.work/v2`). Only the
 * exact paired origins (`./work-protocol.js`): os.ezil.work inside universe.ezil.work, os-staging inside
 * universe-staging. The top-level assignment tab above is untouched.
 *
 * WINDOW (exact origin and the actual parent window only): the parent's `discover {challenge}` is answered with one of
 * `authentication_required | preparing | ready | unavailable`, echoing that challenge. `preparing` while no port is
 * bound invites ONE `bind {challenge}` carrying exactly one MessagePort, for the latest answered challenge. Nothing is
 * fetched before a valid discover; one bind per document.
 *
 * PORT (the Universe `assignment-work-capture.js` vocabulary): parent `request {id, method}` for `begin | upload |
 * status | unlock | end`, plus `pulse | lock | cancel`; child `ready` (bound, eligible, computer-checked and the server's
 * clock not paused: `begin` may start), `reply {id, ok, value | code}`, `pause {reason, effectiveAt}` and `reopen`. The
 * parent owns consent, the browser picker and the encoder, and sends only frame bytes. This document keeps the sealed
 * repository proof, the recording transport and every Universe answer; replies carry only the fields the parent reads.
 *
 * Two additive port events (an older parent ignores both): `capture-ready` once, as soon as the exact parent's bind is
 * accepted for a signed-in owner (the parent may offer its picker while this document still verifies; `ready` is still
 * what allows `begin`), and `editor-usable {captureSessionId[, deadlineAt, serverNow]}` when the assigned editor is on
 * screen on the verified checkout. `deadlineAt` and `serverNow` there are the assignment's own clock as `editor-ready`
 * answered it; the media window stays in `upload`, `status` and `unlock`.
 *
 * THREE TIMES, never mixed:
 *  - encoder time is the parent's: each part's `startMs`/`endMs`, relative to the media window's start;
 *  - the media window (`startedAt`, `deadlineAt`, `serverNow` in the seed's reply, in `status` and in `unlock`) is the
 *    recording's own and bounds the footage only. Before any pause it is at most the hour, or 64 minutes when
 *    Universe's signed preflight says it manages a preparation window (`editorReadySupported`); its cutoff may then
 *    move, always from the seed's own start;
 *  - the assignment's clock is the server's (`clock`, and the `editor-ready` answer returned as `unlock`'s `clock` and
 *    in `editor-usable`). Nothing here starts, restarts or extends it. Its start, once reported (Universe's preflight
 *    window for an attempt its workspace page started, a `clock` report or `editor-ready`), is the original: a later
 *    answer naming another start is ignored, and an `editor-ready` that names one never opens the editor.
 *
 * The server gate is production's own: `prepare` seals the checkout, `begin` binds that receipt to the parent's capture
 * session, the seed must be confirmed phase-ready, the `open` mint re-checks the same session, receipt, unlock and
 * deadline and commits `editor-ready`, and the editor is shown only after Code reports the verified folder AND
 * `editor-ready` answers here. Under a managed preparation that call starts the work hour, so it waits for the
 * editor's mounted workbench, not only the folder its address names. Window `ready` = the editor is open on the
 * verified folder.
 *
 * SCREEN: while the workspace prepares this gate draws nothing. The Code window's own loader is the one surface from
 * launch to editor (`park(true,true)`), with the editor frame parked and inert under it. The gate's panel is for a
 * state the person must act on (sign in, unavailable, another computer, sharing or time paused, closed), or a parent
 * that never answers.
 *
 * PAUSE / RE-SHARE: a server pause (`clock`) covers the editor, ends the live capture phase at the pause's own time
 * (`pause {reason:'paused', effectiveAt}`; the parent seals and ends it, or the heartbeat watch does) and refuses a new
 * `begin` (`assignment_paused`) until the clock runs again, when the port says `ready` once more. The port, the
 * eligibility and the clock outlive every share: stopping, a pause or a failure never needs a new document.
 */
function openEmbeddedAssignment({attemptId, repo, computerId, actor, open, body, park, prepare, computerInfo, wake, transport, win, host, clockLiveMs, clockIdleMs,
    watchMs=EMBED_WATCH_MS, silentMs=EMBED_SILENT_MS}) {
    const owner=actor(), ui=buildGate(body), name=repo.split('/').at(-1).slice(0,-4);
    // The server's clock for this assignment. Universe draws it; here it only gates capture and the editor.
    const countdown=createCountdown();
    let state='preparing', locked=true, armed=false, eligible=false, closing=false, closePromise, port=null, challenge=null;
    let active=null, clockStart, pulseAt=0, watch, drained, clockTimer, over=false, held=false, managed=false, woken=false, silent;
    const inflight=new Set(), note=stageDiagnostics(attemptId);
    const owned=()=>Boolean(owner) && actor()===owner;
    const isHere=()=>!closing && current===gate && owned();
    const terminal=()=>state==='unavailable' || state==='authentication_required';
    const live=item=>isHere() && active===item && !item.ending && !item.shareEnded;
    const check=item=>{if(!live(item))throw failure('recording_phase_changed');};
    const send=(type,fields={})=>{try{port?.postMessage({protocol:WORK_PROTOCOL,attemptId,type,...fields});}catch{/* closed by the parent */}};
    const reply=respondToWorkDiscover(attemptId,win,()=>state,arm);
    function cover(loading){locked=true;park(true,loading);ui.clear();}
    function lock(title,message){cover(false);ui.set(title,message);}
    // Preparing: the Code window's own loader stays the one surface; this gate draws nothing over it.
    function prep(){cover(true);ui.reveal();}
    function setState(next,announce=true){if(state===next)return;state=next;if(announce)reply.push();}
    // `announce`: false only inside a discover, whose own reply follows and carries the new state.
    function settle(next,title,message,announce=true){
        if(closing)return;
        if(active){const item=active;suspend(item,false);send('pause',{reason:'connection_lost',effectiveAt:null});void end(item,'connection_lost',item.expected);}
        clearTimeout(clockTimer);
        lock(title,message);setState(next,announce);
    }
    function failed(error,announce=true){
        const cause=error?.code||error?.message;
        if(!owned() || identityCodes.includes(cause))settle('authentication_required','Sign in to EZiL OS',EMBED_SIGN_IN,announce);
        else settle('unavailable','Assignment unavailable',EMBED_UNAVAILABLE,announce);
    }
    function arm(latest){
        if(closing)return;
        clearTimeout(silent);
        if(challenge!==latest)note('discover.accepted');
        challenge=latest;
        if(!owned()){if(state!=='authentication_required')settle('authentication_required','Sign in to EZiL OS',EMBED_SIGN_IN,false);return;}
        if(!armed){armed=true;void eligibility();}
    }
    /** True unless `report` names a start other than the original one. The first start reported is the original. */
    function originalStart(report){
        const start=typeof report?.startedAt==='string'?Date.parse(report.startedAt):NaN;
        if(!Number.isFinite(start))return true;
        if(clockStart===undefined){clockStart=start;return true;}
        return Math.abs(start-clockStart)<SAME_START_MS;
    }
    /** A report of the canonical clock (`clock`, `editor-ready`). Only the server pauses or resumes; this follows it. */
    function applyClock(report){
        if(closing || over || !originalStart(report) || !countdown.sync(report))return;
        if(countdown.state()==='paused')hold();else if(held)release();
    }
    async function refreshClock(){
        if(closing || over)return;
        try{applyClock(await checkAssignmentClock(attemptId));}catch{/* the next poll asks again */}
    }
    function scheduleClock(){
        clearTimeout(clockTimer);
        if(closing || over || terminal() || countdown.state()==='ended')return;
        clockTimer=setTimeout(async()=>{await refreshClock();scheduleClock();},active&&!active.ending?clockLiveMs:clockIdleMs);
    }
    /** The server stopped the assignment's time: the editor is covered at once and the live capture phase ends at that time. */
    function hold(){
        if(held)return;
        held=true;
        const item=active;
        if(item && !item.ending && !item.shareEnded){
            const at=countdown.serverPausedAt();
            suspend(item,true,EMBED_HELD);
            send('pause',{reason:'paused',effectiveAt:at===null?null:new Date(at).toISOString()});
        }else if(!terminal() && !active)lock(...EMBED_HELD);
    }
    function release(){
        held=false;
        if(terminal() || active || !eligible)return;
        lock('Assignment time is running again',EMBED_AGAIN);
        if(port)send('ready');
    }
    async function eligibility(){
        prep();
        try{
            const result=await retry(()=>checkAssignmentVideoEligibility(attemptId,{repositoryUrl:repo}),['media_unavailable','recording_unavailable'],2,isHere);
            if(!isHere())return;
            if(result.status!=='eligible' || result.attemptId!==attemptId || result.repositoryUrl!==repo)throw failure('assignment_mismatch');
            // An attempt whose window already runs (Universe's workspace page started it) keeps that start for good.
            originalStart({startedAt:result.windowStartedAt});
            // Asked before the port may say `ready`: a share is never offered into a pause that is already there. A
            // clock that does not answer delays nothing (the broker refuses a `begin` into a pause anyway).
            await refreshClock();scheduleClock();
            if(!isHere())return;
            if(win.location.origin==='https://os.ezil.work'){
                const info=await Promise.resolve(computerInfo?.()).catch(()=>null);
                if(!isHere())return;
                const refusal=computerRefusal(result,info,true);
                if(refusal){
                    // Not a refusal of the attempt: the frame says what to do, and the same check runs again on request.
                    lock(...COMPUTER_REFUSAL[refusal]);
                    ui.action('Check this computer again',()=>{if(isHere() && !eligible && !terminal())void eligibility();});
                    return;
                }
            }
            eligible=true;
            // Only Universe's own signed answer says it manages this attempt's preparation window: the media bound
            // widens and the work hour starts at `editor-ready`. An older Universe keeps today's release.
            managed=result.editorReadySupported===true;
            // The ordinary wake of this person's own computer, once, so a cold start overlaps the brief and the picker.
            // It opens no editor and no checkout; every compute and billing rule is the wake's own.
            if(!woken){woken=true;try{wake?.();}catch{/* the checkout's own wake still runs */}}
            if(held)lock(...EMBED_HELD);
            else{prep();if(port)send('ready');}
        }catch(error){if(!closing && current===gate){note('prepare.refused',error);failed(error);}}
    }
    function onWindow(event){
        const data=event.data;
        if(event.source!==win.parent || event.origin!==host || data?.protocol!==WORK_PROTOCOL || data.type!=='bind' || data.attemptId!==attemptId
            || !challenge || data.challenge!==challenge || event.ports?.length!==1 || port || terminal() || !isHere())return;
        port=event.ports[0];port.onmessage=onPort;port.start?.();
        note('bind.accepted');
        send('capture-ready');
        if(eligible && !held)send('ready');
    }
    // The parent's sharing stopped, the server paused or this document lost it: the editor locks at once; the phase is then ended.
    function suspend(item,announce=true,copy=EMBED_PAUSED){
        item.shareEnded=true;item.allowMint=false;item.ctl.abort();item.editor?.reject(failure('workspace_locked'));
        lock(...copy);if(state==='ready')setState('preparing',announce);
    }
    function startIdleWatch(){
        clearInterval(watch);pulseAt=Date.now();
        watch=setInterval(()=>{
            const item=active;if(!item || item.ending)return;
            if(!owned()){failed(failure('identity_refresh_required'));return;}
            if(Date.now()-pulseAt>silentMs){
                if(!item.shareEnded){suspend(item);send('pause',{reason:'connection_lost',effectiveAt:null});}
                void end(item,'connection_lost',item.expected);
            }
        },watchMs);
    }
    /** The recording's own media window (seed confirm, status). It bounds how far a clip may end, never the assignment's clock. */
    function syncMedia(item,report){
        const deadline=Date.parse(report?.deadlineAt),start=Date.parse(report?.startedAt),revision=report?.revision??0;
        if(active!==item || !Number.isFinite(deadline) || !Number.isSafeInteger(revision) || revision<(item.mediaRevision??0)
            || (item.mediaDeadline!==undefined && deadline<item.mediaDeadline))return;
        if(Number.isFinite(start)){
            if(item.mediaStart!==undefined && item.mediaStart!==start)return;
            item.mediaStart=start;
        }
        item.mediaRevision=revision;item.mediaDeadline=deadline;
    }
    async function begin(d){
        if(!eligible || d.consentVersion!==4 || !uuid.test(d.captureSessionId??''))throw failure('assignment_not_ready');
        if(active){
            if(active.id===d.captureSessionId && active.grant && !active.ending && !active.shareEnded)
                return {captureSessionId:active.id,status:active.grant.status,nextSequence:active.grant.nextSequence};
            throw failure('recording_in_use');
        }
        // A paused assignment starts no phase: the broker would refuse it, and the checkout must not be re-sealed for it.
        if(held || countdown.state()==='paused')throw failure('assignment_paused');
        const item=active={id:d.captureSessionId,expected:0,ctl:new AbortController(),startedAt:Date.now(),stage:'prepare'};
        startIdleWatch();scheduleClock();prep();note('prepare.start');
        try{
            const result=await retry(()=>prepare(attemptId,{signal:item.ctl.signal}),['sandbox_starting','media_unavailable','assignment_open_unavailable'],3,
                ()=>live(item) && !item.ctl.signal.aborted);
            check(item);
            const sealed=result?.assignmentOpen, meta=result?.repository;
            if(result?.ok!==true || result.codePreviewUrl || result.url || sealed?.attemptId!==attemptId || !/^[A-Za-z0-9_-]{48,1700}$/.test(sealed.proof)
                || !meta?.id || typeof meta.workspaceFolder!=='string' || meta.checkoutFolder!==meta.workspaceFolder+'/'+name)
                throw failure('assigned_checkout_unverified');
            item.meta=meta;item.proof=sealed.proof;item.stage='begin';
            item.transport=(transport??createAssignmentVideoTransport)({attemptId,repoOpenProof:item.proof,captureSessionId:item.id,consentVersion:4,
                onClock:report=>syncMedia(item,report),paused:()=>countdown.state()==='paused',
                // The timeline is the real wall clock: time the server gave back after a pause lets a clip end past the first hour.
                maxEndMs:()=>{
                    if(item.mediaStart===undefined)return 0;
                    const media=item.mediaDeadline===undefined?0:item.mediaDeadline-item.mediaStart;
                    const canonicalEnd=countdown.serverDeadlineAt();
                    return Math.max(media,canonicalEnd===null?0:canonicalEnd-item.mediaStart);
                },
                onStop:(why,at)=>{
                    if(active!==item || item.ending)return;
                    if(!item.shareEnded)suspend(item);
                    send('pause',{reason:why==='submitted'||why==='timeout'?why:'connection_lost',effectiveAt:at??null});
                }});
            item.grant=await retry(()=>item.transport.begin(),['media_unavailable'],2,()=>live(item));
            check(item);
            if(item.grant.captureSessionId!==item.id || item.grant.status!=='awaiting_frame' || !Number.isSafeInteger(item.grant.nextSequence))
                throw failure('recording_phase_changed');
            item.expected=item.grant.nextSequence;item.stage='seed';
            note('prepare.ready');
            return {captureSessionId:item.id,status:item.grant.status,nextSequence:item.grant.nextSequence};
        }catch(error){
            note('prepare.refused',error);
            if(identityCodes.includes(error?.code))failed(error);
            else{
                await end(item,'connection_lost',item.expected).catch(()=>{});
                if(isHere() && !terminal() && !active)lock(held?EMBED_HELD[0]:EMBED_PAUSED[0],held?EMBED_HELD[1]:embedMessage(error?.code||error?.message));
            }
            throw error;
        }
    }
    const digestOf=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
    async function upload(d){
        const item=active,p=d.part;
        // A stopping share may still deliver its final clip (`lock` precedes `end`); a seed may not.
        if(!item || item.id!==d.captureSessionId || item.ending || !item.grant || !owned())throw failure('recording_phase_changed');
        if(!p || !(p.bytes instanceof ArrayBuffer) || !p.bytes.byteLength || p.bytes.byteLength>8*1024*1024 || p.mimeType!=='video/webm'
            || !Number.isSafeInteger(p.sequence) || p.sequence<0 || p.sequence>=600 || !Number.isSafeInteger(p.startMs) || !Number.isSafeInteger(p.endMs))
            throw failure('invalid_segment');
        const seedShape=p.startMs===0 && p.endMs===1 && p.bytes.byteLength<=1024*1024;
        // A retransmitted first frame (the parent missed the reply) gets the same acknowledgement again, without a new
        // request: only the identical bytes, by SHA-256 against the frame this document already sent, are accepted.
        if(item.seedTask && p.sequence===item.seedTask.sequence){
            const task=item.seedTask;
            if(!seedShape || await digestOf(p.bytes)!==await task.digest || active!==item || item.ending)throw failure('invalid_segment');
            return task.reply(true);
        }
        if(item.seedTask){
            if(!item.seed)throw failure('seed_not_confirmed');
            const ack=await item.transport.upload({sequence:p.sequence,startMs:p.startMs,endMs:p.endMs,mimeType:'video/webm',bytes:p.bytes});
            if(active!==item || item.ending || !ack?.confirmed)throw failure('recording_phase_changed');
            item.expected=Math.max(item.expected,p.sequence+1);return {confirmed:true,sequence:p.sequence};
        }
        if(item.shareEnded || p.sequence!==item.expected || !seedShape)throw failure('invalid_segment');
        // Registered before any await, so a concurrent retransmit joins this attempt instead of starting another.
        const task=item.seedTask={sequence:p.sequence,digest:digestOf(p.bytes)};
        task.done=(async()=>{
            await task.digest;
            const ack=await item.transport.upload({sequence:p.sequence,startMs:0,endMs:1,mimeType:'video/webm',bytes:p.bytes});
            const receivedAt=Date.now();
            if(active!==item || item.ending)throw failure('recording_phase_changed');
            if(!ack.phaseReady || ack.captureSessionId!==item.id || ack.nextSequence!==task.sequence+1 || !ack.firstFrameAt)throw failure('seed_not_confirmed');
            const startAt=Date.parse(ack.startedAt), deadline=Date.parse(ack.deadlineAt), serverNow=Date.parse(ack.serverNow);
            const offset=Number.isFinite(serverNow)?serverNow-receivedAt:0;
            // Confirm bounds remaining time; trusted pauses (a revised window) can make the elapsed media window longer
            // than its first bound.
            if(!Number.isFinite(startAt) || !Number.isFinite(deadline) || deadline<=receivedAt+offset || deadline<=startAt
                || (!(ack.revision>0) && deadline-startAt>(managed?MEDIA_WINDOW_MS:WINDOW_MS)))throw failure('recording_closed');
            item.seed=ack;item.accepted=true;item.expected=Math.max(item.expected,ack.nextSequence);item.stage='record';
            return {ack,serverNow,receivedAt};
        })();
        // A refused first frame leaves no acknowledgement to replay: the parent's next attempt is a real upload.
        task.done.catch(()=>{if(item.seedTask===task)item.seedTask=null;});
        task.reply=async replay=>{
            const {ack,serverNow,receivedAt}=await task.done;
            // The broker's own clock at confirmation: the parent's encoder offsets its segment times by it. A replay
            // advances it by the time elapsed here, so the parent's offset stays the broker's.
            const now=!Number.isFinite(serverNow) ? null : replay ? new Date(serverNow+Math.max(0,Date.now()-receivedAt)).toISOString() : ack.serverNow;
            // The MEDIA window, for the encoder alone. `revision` > 0 marks a window the server extended past an hour.
            return {confirmed:true,phaseReady:true,captureSessionId:item.id,nextSequence:ack.nextSequence,startedAt:ack.startedAt,deadlineAt:ack.deadlineAt,serverNow:now,
                ...(Number.isSafeInteger(ack.revision)?{revision:ack.revision}:{})};
        };
        return task.reply(false);
    }
    async function status(d){
        const item=active;
        if(!item || item.id!==d.captureSessionId || item.ending || !item.grant || !owned())throw failure('recording_phase_changed');
        const s=await item.transport.status();
        // The parent cuts its last clip here: Universe's stop, or the server's pause, whichever came first.
        const cutoffs=[Date.parse(s.stopRequestedAt),countdown.serverPausedAt()].filter(Number.isFinite);
        return {captureSessionId:s.captureSessionId,status:s.status,stopRequestedAt:cutoffs.length?new Date(Math.min(...cutoffs)).toISOString():null,
            ...(mediaClock(item,s)??{})};
    }
    /**
     * The media window as the broker last stated it, relayed only when it is this capture's, starts exactly where the
     * confirmed seed did, and ends inside its bound: the hour, 64 minutes under a managed preparation (its cutoff may
     * then move), or whatever a revised window (the server gave paused time back) names. Never the assignment's clock.
     */
    function mediaClock(item,s){
        const start=Date.parse(item.seed?.startedAt), deadline=Date.parse(isoTime(s?.deadlineAt)??'');
        if(!item.seed || s?.captureSessionId!==item.id || s.startedAt!==item.seed.startedAt || !Number.isFinite(deadline) || deadline<=start
            || (!(s.revision>0) && deadline-start>(managed?MEDIA_WINDOW_MS:WINDOW_MS)))return null;
        const serverNow=isoTime(s.serverNow);
        return {deadlineAt:s.deadlineAt,...(serverNow?{serverNow}:{})};
    }
    async function unlock(d){
        const item=active;
        if(!item || item.id!==d.captureSessionId)throw failure('recording_phase_changed');
        check(item);
        if(!item.seed)throw failure('seed_not_confirmed');
        item.stage='confirm';
        try{
            await retry(async()=>{
                const s=await item.transport.status();
                // A managed preparation lets the broker move the media cutoff inside its bound; the start never moves.
                if(s.phaseReady!==true || s.workspaceUnlocked!==true || s.captureSessionId!==item.id || s.startedAt!==item.seed.startedAt
                    || (managed ? !mediaClock(item,s) : s.deadlineAt!==item.seed.deadlineAt) || !s.firstFrameAt)throw failure('seed_not_confirmed');
            },['seed_not_confirmed','media_unavailable'],3,()=>live(item));
            check(item);
            item.stage='open';item.allowMint=true;
            const editor=new Promise((resolve,reject)=>{item.editor={resolve,reject};});
            const timer=setTimeout(()=>item.editor?.reject(failure('assigned_checkout_unverified')),80000);
            let clock;
            try{open();clock=await editor;}finally{clearTimeout(timer);item.editor=null;}
            check(item);
            // The seed's start stays the media anchor. Under a managed preparation the work clock has just started and
            // the broker may have moved the media cutoff, so its latest valid statement for this capture is preferred.
            let media=null;
            if(managed){
                media=mediaClock(item,await Promise.race([item.transport.status(),new Promise(resolve=>setTimeout(resolve,4000))]).catch(()=>null));
                check(item);
            }
            // `startedAt`/`deadlineAt`: the media window (encoder). `clock`: the assignment's own, exactly as `editor-ready` answered.
            return {status:'ready',captureSessionId:item.id,startedAt:item.seed.startedAt,...(media??{deadlineAt:item.seed.deadlineAt}),clock};
        }catch(error){
            if(identityCodes.includes(error?.code))failed(error);
            else if(active===item && !item.ending){item.allowMint=false;lock(held?EMBED_HELD[0]:EMBED_PAUSED[0],held?EMBED_HELD[1]:embedMessage(error?.code));}
            throw error;
        }
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
                    over=true;clearTimeout(clockTimer);
                    lock('Assignment closed',reason==='submitted'?'Assignment submitted. Recording ended.':'The assignment time has ended.');setState('unavailable');
                }else if(!closing){
                    // A share that ended inside a pause says so, instead of inviting a share the server would refuse.
                    if(held && isHere() && !terminal())lock(...EMBED_HELD);
                    // The clock outlives the share: ask now, then on the idle schedule.
                    void refreshClock();scheduleClock();
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
        const task=run().then(value=>send('reply',{id:d.id,ok:true,value}),error=>{
            const code=replyCode(error);
            // Codes and stages only, as the top-level gate reports them.
            if(['begin','unlock'].includes(d.method) && code!=='recording_in_use')
                report('embed-'+d.method,code,active,{reason:error?.reason,correlationId:error?.correlationId});
            send('reply',{id:d.id,ok:false,code});
        });
        inflight.add(task);void task.finally(()=>inflight.delete(task));
    }
    // The same folder rule as the OS tab: the editor must show the verified workspace or its checkout, and nothing else.
    // `workbench`: this report is the editor's mounted workbench (`../apps/code-folder.js` `onWorkbench`), not the
    // folder echo read from the document's address. Under the acknowledged release only that one goes on: the echo
    // still refuses a wrong folder at once, but an editor document whose workbench never starts stays parked, tells
    // Universe nothing and fails `unlock` on its own timer. Without the flag the echo releases as before.
    function confirm(frame,frameUrl,actualRoot,workbench=false){
        const item=active;
        if(!item?.allowMint || !item.editor || !live(item) || !frame.isConnected)return;
        const url=new URL(frameUrl), folders=[item.meta.workspaceFolder,item.meta.checkoutFolder];
        if(!folders.includes(actualRoot) || !folders.includes(url.searchParams.get('folder'))){item.editor.reject(failure('assigned_checkout_unverified'));return;}
        if(workbench!==managed)return;
        void editorReady(item,frame);
    }
    /**
     * The real Code folder was validated (under a managed preparation: its workbench is mounted). Before the editor is
     * shown, Universe is told (`editor-ready`, signed with this phase's repository-open proof): its answer is the
     * assignment's clock, and the browser sends no time. An answer that names a start other than the original one never
     * opens the editor; neither does a paused clock. Then, in this order: the editor is shown, the port hears
     * `editor-usable`, `unlock` is answered and the window state becomes `ready`.
     */
    async function editorReady(item,frame){
        const pending=item.editor;
        if(item.readying===pending)return;
        item.readying=pending;
        const here=()=>live(item) && item.editor===pending && item.allowMint && frame.isConnected;
        try{
            const clock=await retry(()=>item.transport.editorReady(),EDITOR_READY_TRANSIENT,EDITOR_READY_TRIES,here);
            if(!here())return;
            note('editor_ready.reported');
            if(typeof clock.startedAt!=='string' || !originalStart(clock))throw failure('assignment_clock_changed');
            applyClock(clock);
            if(!here())return;
            if(held || countdown.state()==='paused')throw failure('assignment_paused');
            locked=false;park(false,false);ui.reveal();
            note('editor.usable');
            const deadlineAt=isoTime(clock.deadlineAt), serverNow=isoTime(clock.serverNow);
            send('editor-usable',{captureSessionId:item.id,...(deadlineAt?{deadlineAt}:{}),...(serverNow?{serverNow}:{})});
            pending.resolve({startedAt:clock.startedAt,deadlineAt:isoOrNull(clock.deadlineAt),serverNow:isoOrNull(clock.serverNow),
                pausedAt:null,remainingMs:Number.isFinite(clock.remainingMs)?clock.remainingMs:null,revision:clock.revision});
            setState('ready');
        }catch(error){
            if(!here())return;
            note('editor_ready.refused',error);
            pending.reject(error?.code?error:failure('editor_ready_failed'));
        }finally{if(item.readying===pending)item.readying=null;}
    }
    /** Code's open-phase mint failed (`apps/code.js`): end the wait for the editor now, with the real cause. */
    function failOpen(res){
        const item=active;if(!item?.editor)return;
        item.editor.reject(Object.assign(failure(res?.errorCode||'unknown'),{reason:res?.reason,correlationId:res?.correlationId}));
    }
    function close(){
        if(closePromise)return closePromise;
        closing=true;reply.dispose();clearInterval(watch);clearTimeout(clockTimer);clearTimeout(silent);
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
    // `requiresWorkbench`: Universe signed a managed preparation, so the Code window asks its editor for the mounted
    // workbench and reports it through `confirm(…, true)`. Only this gate has it; without the flag nothing is asked.
    const gate={repo,locked:()=>locked,confirm,close,fail:failOpen,requiresWorkbench:()=>managed,
        access:()=>active?.allowMint && live(active) ? {attemptId,phase:'open',repoOpenProof:active.proof,captureSessionId:active.id} : null};
    current=gate;
    prep();
    // Said only once the parent has really been silent, never as the first screen of a page that is about to answer.
    silent=setTimeout(()=>{if(!closing && !challenge && current===gate)lock('Open this assignment from Universe','Waiting for your Universe assignment page…');},SILENT_PARENT_MS);
    silent?.unref?.();
    win.addEventListener('message',onWindow);win.addEventListener('pagehide',pageHide,{once:true});
    return gate;
}

/** The page's assignment entry: the address while it names one, else the address this document was loaded with. */
function assignmentEntry(win) {
    const address=new URL(win.location.href);
    return address.searchParams.has('repo')||address.searchParams.has('assignment')?address.href:initialEntry;
}
/**
 * True only for the Code window of an assignment framed by its own paired Universe work page: exactly the case the
 * embedded gate below takes. That window keeps the ordinary window controls a framed shell otherwise drops.
 */
export function embeddedAssignmentWindow(project, win=globalThis.window) {
    try{return Boolean(win) && assignmentOsOrigin(win.location.origin) && Boolean(assignmentIntent(assignmentEntry(win),project?.repoUrl)) && Boolean(embeddedWorkHost(win));}
    catch{return false;}
}

export function openWithAssignmentConsent({project, computerId, actor, open, body, park, prepare, computerInfo, wake, transport, settleMs=STOP_SETTLE_MS,
    saveCeilingMs=STOP_SAVE_CEILING_MS, frameMs=FRESH_FRAME_MS, clockLiveMs=CLOCK_LIVE_MS, clockIdleMs=CLOCK_IDLE_MS, reconnectMs=RECONNECT_OFFER_MS,
    embedWatchMs=EMBED_WATCH_MS, embedSilentMs=EMBED_SILENT_MS}) {
    const win=globalThis.window, repo=project?.repoUrl;
    if(!win || !assignmentOsOrigin(win.location.origin)){queueMicrotask(open);return null;}
    const address=new URL(win.location.href);
    const entry=assignmentEntry(win);
    const attemptId=assignmentIntent(entry,repo);
    const explicit=address.pathname==='/app/code' && address.searchParams.has('assignment');
    if(!canonical.test(repo) && !explicit){queueMicrotask(open);return null;}
    // Framed by its own paired Universe workspace: a separate gate that waits for that exact parent and never uses the picker.
    const host=attemptId?embeddedWorkHost(win):null;
    if(host)return openEmbeddedAssignment({attemptId,repo,computerId,actor,open,body,park,prepare,computerInfo,wake,transport,win,host,clockLiveMs,clockIdleMs,
        watchMs:embedWatchMs,silentMs:embedSilentMs});

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
        if(item){
            // Universe publishes the new deadline after Works acknowledges it. Move the recorder before releasing hold.
            if(item.mediaStart!==undefined)syncMedia(item,report,true);
            applyGate(item);
        }else if(!indicator && !over && countdown.started())showIndicator(countdown.state()==='ended'?'ended':'idle');
        indicator?.sync();
    }
    /**
     * The recording's own window (begin / seed confirm / status: `startedAt`, `deadlineAt`, in server time). It bounds the
     * recording only: it moves the recorder's deadline and the share's deadline timer, never the countdown.
     */
    function syncMedia(item,report,canonical=false){
        const deadline=Date.parse(report?.deadlineAt),start=canonical?NaN:Date.parse(report?.startedAt);
        const revision=report?.revision??0;
        if(!samePhase(item)||!Number.isFinite(deadline)||!Number.isSafeInteger(revision)
            ||revision<(item.mediaRevision??0)||(item.mediaDeadline!==undefined&&deadline<item.mediaDeadline))return;
        if(Number.isFinite(start)){
            if(item.mediaStart!==undefined&&item.mediaStart!==start)return;
            item.mediaStart=start;
        }
        item.mediaRevision=revision;
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
            // The same attempt's clock is available while the provider is unavailable or sharing is stopped.
            void refreshClock();scheduleClock();
            if (win.location.origin === 'https://os.ezil.work') {
                const info = await computerInfo?.();
                if (!isHere()) return;
                const refusal = computerRefusal(result,info);
                if (refusal) {
                    lockedView(...COMPUTER_REFUSAL[refusal]);
                    ui.action('Check this computer again',eligible);
                    return;
                }
            }
            picker??=currentTabPicker(win);
            displayConsent();
        }catch(e){
            if(!isHere())return;
            if(e.code==='identity_refresh_required'){showSignIn();return;}
            if(e.code==='assignment_identity_mismatch'){showAccountSignIn();return;}
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
                ()=>{if(samePhase(item)&&!item.gated)ui.set('Checking recording','Waiting for a fresh frame from this OS tab…');},
                frameMs,item.captureCtl.signal);
            check(item);
            if(!item.gated)ui.set('Checking recording','Saving the first frame before opening your editor…');
            const upload=part=>retry(()=>item.transport.upload(part),['upload_failed','media_unavailable'],2);
            const ack=await upload({sequence:item.expected,startMs:0,endMs:1,mimeType:'video/webm',bytes});
            check(item);
            if(!ack.phaseReady || ack.captureSessionId!==item.id || ack.nextSequence!==item.expected+1 || !ack.firstFrameAt)
                throw failure('seed_not_confirmed');
            item.expected=ack.nextSequence;item.accepted=true;
            const startAt=Date.parse(ack.startedAt), deadline=Date.parse(ack.deadlineAt), serverNow=Date.parse(ack.serverNow);
            const offset=Number.isFinite(serverNow)?serverNow-Date.now():0;
            // Confirm bounds remaining time; trusted pauses can make the elapsed media window longer than an hour.
            if(!Number.isFinite(startAt)||!Number.isFinite(deadline)||deadline<=Date.now()+offset||deadline<=startAt)
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
                onAwaitFrame:()=>{if(samePhase(item)&&!item.gated)ui.set('Opening assigned editor','First frame saved. Checking your workspace…');}});
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

/** `workbench`: true only for the editor's own mounted-workbench report; the folder echo passes nothing. */
export function confirmAssignmentFolder(project,_receipt,frame,frameUrl,actualRoot,workbench){
    if(current?.repo===project?.repoUrl)current.confirm(frame,frameUrl,actualRoot,workbench===true);
}
