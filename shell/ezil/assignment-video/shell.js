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
/** `editor-ready` is asked again, with the editor still parked, only on these answers. */
const EDITOR_READY_TRANSIENT=['media_unavailable','recording_unavailable','assignment_open_unavailable'];
const SILENT_PARENT_MS=20000;
/** The media window's bound once Universe acknowledges editors: its cutoff may move, within 64 minutes of the seed. */
const MEDIA_WINDOW_MS=3840000;
const isoTime=value=>typeof value==='string' && value.length<=40 && Number.isFinite(Date.parse(value)) ? value : null;
const REFUSALS={
    identity:[...identityCodes,'UNAUTHORIZED','unauthorized','assignment_video_creator_unlinked'],
    checkout:['assigned_checkout_unverified','assignment_open_unavailable','assignment_open_required','repo_open_failed','sandbox_starting','assignment_aws_unverified','workspace_disconnected'],
    phase:['recording_phase_changed','recording_in_use','recording_closed','recording_changed','recording_unavailable','seed_not_confirmed','assignment_not_ready','workspace_locked','cancelled'],
    media:['media_unavailable','upload_failed','upload_unconfirmed','invalid_segment','invalid_upload_target'],
    timeout:['timeout','workspace_timeout'],
    protocol:['invalid_request','invalid_assignment','assignment_mismatch','editor_ready_unsupported'],
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
 * The assignment framed by its own Universe work page, which records ITS tab (`ezil.assignment.work/v2`).
 *
 * WINDOW (exact origins and actual windows only, `./work-protocol.js`): the parent's `discover {challenge}` is answered
 * with one of `authentication_required | preparing | ready | unavailable`, echoing that challenge. `preparing` while no
 * port is bound invites ONE `bind {challenge}` carrying exactly one MessagePort, for the latest answered challenge.
 * Nothing is fetched before a valid discover; one bind per document.
 *
 * PORT (byte-for-byte the Universe 994b90ac `assignment-work-capture.js` vocabulary; the shell's top-level
 * 6ef24888^ bridge, adapted to this base's checks): parent `request {id, method}` for `begin | upload | status | unlock
 * | end`, plus `pulse | lock | cancel`; child `ready` (bound, eligible and AWS-checked: the RPC may start), `reply {id,
 * ok, value | code}`, `pause {reason, effectiveAt}` and `reopen`. The parent owns consent and the browser picker and
 * sends only frame bytes. This document keeps the sealed repository proof, the recording transport and every Universe
 * answer; replies carry only the fields the parent reads. `begin` runs only in reply to a request on the bound port.
 *
 * Two additive port events (an older parent ignores both): `capture-ready` once, as soon as the exact parent's bind is
 * accepted for a signed-in owner (the parent may offer its picker while this document still verifies; `ready` is still
 * what allows `begin`), and `editor-usable {captureSessionId[, deadlineAt, serverNow]}` when the assigned editor is on
 * screen on the verified checkout. `deadlineAt` and `serverNow` there are Universe's work clock, present only when
 * Universe acknowledged `editor-ready`; the media window stays in `upload`, `status` and `unlock`, never mixed.
 *
 * The server gate is unchanged: `prepare` seals the checkout, `begin` binds that receipt to the parent's capture
 * session, the seed must be confirmed phase-ready, and only then may the `open` mint ask `code-preview-url`, which
 * re-checks the same session, receipt, unlock and deadline. When the signed preflight says `editorReadySupported`, the
 * verified editor stays parked until Universe acknowledges `editor-ready` for this capture and proof (no time is sent);
 * without that flag the editor is released as before. Window `ready` = the editor is released on the verified folder.
 *
 * DOCUMENT SCOPE: this gate belongs to the OS document, not to the Code window that first opened it. Closing that
 * window (its native X) only detaches the window's own hooks (`detach`): the port, the capture, its receipt, both
 * clocks and the accepted media stay as they are, and nothing is said on the window or the port. The next Code window
 * of this same person, computer and Universe frame takes the gate back (`attach`, through `openWithAssignmentConsent`;
 * a projectless dock launch finds its repository in `assignedProject`). Its editor is a fresh mint that names the
 * ORIGINAL receipt and capture as phase `reopen` (`access`; no `prepare`, no `begin`, no new receipt), parked until
 * that window reports the verified folder (and the mounted workbench under the acknowledged release). Universe hears
 * no second `editor-ready` and the port no second `editor-usable`. `begin` or `unlock` arriving while no Code window
 * is open asks the document for one (`summon`). Stop, `pagehide`, a lost owner, a refusal and any other Code launch in
 * this document still end the phase exactly as before.
 *
 * SCREEN: while the workspace prepares this gate draws nothing. The Code window's own loader is the one surface from
 * launch to editor (`park(true,true)`), with the editor frame parked and inert under it. The gate's panel is for a
 * state the person must act on (sign in, unavailable, sharing paused, closed), or a parent that never answers.
 */
function openEmbeddedAssignment({attemptId, repo, computerId, actor, transport, win, ...hooks}) {
    const owner=actor(), name=repo.split('/').at(-1).slice(0,-4);
    let state='preparing', locked=true, armed=false, eligible=false, closing=false, closePromise, port=null, challenge=null;
    let active=null, windowStart, pulseAt=0, watch, drained, editorReady=false, woken=false, silent;
    // `surface`: the open Code window's own hooks (`body`, `park`, `open`, `prepare`), null while that window is closed.
    // `shown`: the message the gate last locked with, drawn again in the next window; null while it only prepares.
    let surface=hooks, ui=buildGate(hooks.body), shown=null;
    // What outlives a window: its computer's provider check, its wake, and the document's own way to open Code.
    const kept={computerProvider:hooks.computerProvider,wake:hooks.wake,summon:hooks.summon};
    const inflight=new Set(), waiters=new Set(), note=stageDiagnostics(attemptId);
    const park=(...args)=>surface?.park(...args);
    const summon=()=>{try{kept.summon?.();}catch{/* the dock still opens it */}};
    /** The open Code window's hooks: at once, or when the document's next Code window attaches (asked for here). */
    function codeWindow(signal){
        if(surface)return Promise.resolve(surface);
        return new Promise((resolve,reject)=>{
            waiters.add(resolve);
            signal?.addEventListener('abort',()=>{waiters.delete(resolve);reject(failure('cancelled'));},{once:true});
            summon();
        });
    }
    const owned=()=>Boolean(owner) && actor()===owner;
    const isHere=()=>!closing && current===gate && owned();
    const terminal=()=>state==='unavailable' || state==='authentication_required';
    const live=item=>isHere() && active===item && !item.ending && !item.shareEnded;
    const check=item=>{if(!live(item))throw failure('recording_phase_changed');};
    const send=(type,fields={})=>{try{port?.postMessage({protocol:WORK_PROTOCOL,attemptId,type,...fields});}catch{/* closed by the parent */}};
    const reply=respondToWorkDiscover(attemptId,win,()=>state,arm);
    function cover(loading){
        locked=true;park(true,loading);ui.clear();
    }
    function lock(title,message){shown=[title,message];cover(false);ui.set(title,message);}
    // Preparing: the Code window's own loader stays the one surface; this gate draws nothing over it.
    function prep(){shown=null;cover(true);ui.reveal();}
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
        clearTimeout(silent);
        if(challenge!==latest)note('discover.accepted');
        challenge=latest;
        if(!owned()){if(state!=='authentication_required')settle('authentication_required','Sign in to EZiL OS',EMBED_SIGN_IN,false);return;}
        if(!armed){armed=true;void eligibility();}
    }
    async function eligibility(){
        prep();
        try{
            const result=await retry(()=>checkAssignmentVideoEligibility(attemptId,{repositoryUrl:repo}),['media_unavailable','recording_unavailable'],2,isHere);
            if(!isHere())return;
            if(result.status!=='eligible' || result.attemptId!==attemptId || result.repositoryUrl!==repo)throw failure('assignment_mismatch');
            const provider=await Promise.resolve(kept.computerProvider?.()).catch(()=>null);
            if(!isHere())return;
            if(provider==='aws-ec2' && !awsAssignmentAnswer(result))throw failure('assignment_aws_unverified');
            eligible=true;
            // Only Universe's own signed answer turns the acknowledged release on; an older stage keeps today's.
            editorReady=result.editorReadySupported===true;
            // The ordinary wake of this person's own computer, once, so a cold start overlaps the brief and the picker.
            // It opens no editor and no checkout; every compute and billing rule is the wake's own.
            if(!woken){woken=true;try{kept.wake?.();}catch{/* the checkout's own wake still runs */}}
            if(port)send('ready');
        }catch(error){if(!closing && current===gate){note('prepare.refused',error);failed(error);}}
    }
    function onWindow(event){
        const data=event.data;
        if(event.source!==win.parent || event.origin!==WORK_HOST || data?.protocol!==WORK_PROTOCOL || data.type!=='bind' || data.attemptId!==attemptId
            || !challenge || data.challenge!==challenge || event.ports?.length!==1 || port || terminal() || !isHere())return;
        port=event.ports[0];port.onmessage=onPort;port.start?.();
        note('bind.accepted');
        send('capture-ready');
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
        startIdleWatch();prep();note('prepare.start');
        try{
            // The checkout is prepared through the open Code window. One closed under it is not a refusal: the same
            // preparation runs again through the document's next Code window, while this phase is still live.
            const prepareHere=async()=>{
                for(;;){
                    const at=await codeWindow(item.ctl.signal);
                    try{return await at.prepare(attemptId,{signal:item.ctl.signal});}
                    catch(error){if(surface===at || !live(item) || item.ctl.signal.aborted)throw error;}
                }
            };
            const result=await retry(prepareHere,['sandbox_starting','media_unavailable','assignment_open_unavailable'],3,
                ()=>live(item) && !item.ctl.signal.aborted);
            check(item);
            const sealed=result?.assignmentOpen, meta=result?.repository;
            if(result?.ok!==true || result.codePreviewUrl || result.url || sealed?.attemptId!==attemptId || !/^[A-Za-z0-9_-]{48,1700}$/.test(sealed.proof)
                || !meta?.id || typeof meta.workspaceFolder!=='string' || meta.checkoutFolder!==meta.workspaceFolder+'/'+name)
                throw failure('assigned_checkout_unverified');
            item.meta=meta;item.proof=sealed.proof;
            item.transport=(transport??createAssignmentVideoTransport)({attemptId,repoOpenProof:item.proof,captureSessionId:item.id,consentVersion:4,
                onStop:(why,at)=>{
                    if(active!==item || item.ending)return;
                    suspend(item);send('pause',{reason:why==='submitted'||why==='timeout'?why:'connection_lost',effectiveAt:at??null});
                }});
            // `granting`: the signed begin while it is in flight. A phase ended under it answers this call at once
            // (`quit`) and leaves that request, and its transport, to `retire`. `signal`: a stop that lands before the
            // request is sent sends none.
            const granting=item.granting=retry(()=>item.transport.begin({signal:item.ctl.signal}),['media_unavailable'],2,()=>live(item));
            const grant=await Promise.race([granting,new Promise((_,reject)=>{item.quit=reject;})]).finally(()=>{item.granting=item.quit=null;});
            check(item);
            if(!granted(item,grant))throw failure('recording_phase_changed');
            item.grant=grant;item.expected=grant.nextSequence;
            note('prepare.ready');
            return {captureSessionId:item.id,status:item.grant.status,nextSequence:item.grant.nextSequence};
        }catch(error){
            note('prepare.refused',error);
            // A phase already ended answers its own request only: its refusal never signs out or ends a successor.
            if(identityCodes.includes(error?.code)){if(active===item && !item.ending)failed(error);}
            else await end(item,'connection_lost',item.expected).catch(()=>{});
            throw error;
        }
    }
    /** The grant this document accepts for a phase: its own capture, awaiting the first frame, at a real sequence. */
    const granted=(item,grant)=>grant?.captureSessionId===item.id && grant.status==='awaiting_frame' && Number.isSafeInteger(grant.nextSequence);
    /**
     * A phase ended while its signed begin was still in flight (Stop, a lost parent or owner, the window or page
     * closing). The phase is released and its `begin` call refused at once; its transport, bound to that attempt,
     * proof and capture, is kept apart until that one request settles. Only a grant it then returns for that same
     * capture is checkpointed as an interrupted phase. A retry targets the same capture. A refusal, a missing
     * response, or another capture or status cannot change the current gate or authorize a checkpoint.
     */
    function retire(item){
        const {transport,granting,quit}=item;item.granting=null;
        quit(failure('recording_phase_changed'));
        void granting.then(grant=>granted(item,grant)
            ? retry(()=>transport.checkpoint('connection_lost'),['media_unavailable']) : null)
            .catch(()=>{})
            .finally(()=>transport.dispose());
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
            if(!Number.isFinite(startAt) || !Number.isFinite(deadline) || deadline<=receivedAt+offset || deadline<=startAt
                || deadline-startAt>(editorReady?MEDIA_WINDOW_MS:WINDOW_MS))throw failure('recording_closed');
            // Reopening after a stop resumes the attempt's own window; a different start is never a new clock.
            if(windowStart!==undefined && windowStart!==startAt)throw failure('recording_closed');
            windowStart=startAt;item.seed=ack;item.expected=Math.max(item.expected,ack.nextSequence);
            return {ack,serverNow,receivedAt};
        })();
        // A refused first frame leaves no acknowledgement to replay: the parent's next attempt is a real upload.
        task.done.catch(()=>{if(item.seedTask===task)item.seedTask=null;});
        task.reply=async replay=>{
            const {ack,serverNow,receivedAt}=await task.done;
            // The broker's own clock at confirmation: the parent's recorder offsets its segment and deadline timing by
            // it. A replay advances it by the time elapsed here, so the parent's offset stays the broker's.
            const now=!Number.isFinite(serverNow) ? null : replay ? new Date(serverNow+Math.max(0,Date.now()-receivedAt)).toISOString() : ack.serverNow;
            return {confirmed:true,phaseReady:true,captureSessionId:item.id,nextSequence:ack.nextSequence,startedAt:ack.startedAt,deadlineAt:ack.deadlineAt,serverNow:now};
        };
        return task.reply(false);
    }
    async function status(d){
        const item=active;
        if(!item || item.id!==d.captureSessionId || item.ending || !item.grant || !owned())throw failure('recording_phase_changed');
        const s=await item.transport.status();
        return {captureSessionId:s.captureSessionId,status:s.status,stopRequestedAt:s.stopRequestedAt??null,...(mediaClock(item,s)??{})};
    }
    /**
     * The media window as the broker last stated it, relayed only when it is this capture's, starts exactly where the
     * confirmed seed did, and ends inside the bound: the hour, or 64 minutes once Universe acknowledges editors (its
     * cutoff may then move). Never the work clock, which travels only in `editor-usable`.
     */
    function mediaClock(item,s){
        const start=Date.parse(item.seed?.startedAt), deadline=Date.parse(isoTime(s?.deadlineAt)??'');
        if(!item.seed || s?.captureSessionId!==item.id || s.startedAt!==item.seed.startedAt || !Number.isFinite(deadline) || deadline<=start
            || deadline-start>(editorReady?MEDIA_WINDOW_MS:WINDOW_MS))return null;
        const serverNow=isoTime(s.serverNow);
        return {deadlineAt:s.deadlineAt,...(serverNow?{serverNow}:{})};
    }
    async function unlock(d){
        const item=active;
        if(!item || item.id!==d.captureSessionId)throw failure('recording_phase_changed');
        check(item);
        if(!item.seed)throw failure('seed_not_confirmed');
        await retry(async()=>{
            const s=await item.transport.status();
            // The acknowledged release lets the broker move the media cutoff inside its bound; the start never moves.
            if(s.phaseReady!==true || s.workspaceUnlocked!==true || s.captureSessionId!==item.id || s.startedAt!==item.seed.startedAt
                || (editorReady ? !mediaClock(item,s) : s.deadlineAt!==item.seed.deadlineAt) || !s.firstFrameAt)throw failure('seed_not_confirmed');
        },['seed_not_confirmed','media_unavailable'],3,()=>live(item));
        check(item);
        item.allowMint=true;
        let pending;
        const editor=new Promise((resolve,reject)=>{item.editor=pending={resolve,reject};});
        const timer=setTimeout(()=>pending.reject(failure('assigned_checkout_unverified')),80000);
        // No Code window open: the document is asked for one, and `attach` opens the editor in it.
        try{if(surface)surface.open();else summon();await editor;}
        catch(error){if(active===item && !item.ending){item.allowMint=false;lock(...EMBED_PAUSED);}throw error;}
        finally{clearTimeout(timer);if(item.editor===pending)item.editor=null;}
        check(item);
        // The seed's start stays the media anchor. Under the acknowledged release the broker may since have moved the
        // media cutoff, so its latest valid statement for this same capture and start is preferred when it answers.
        let media=null;
        if(item.acknowledged){
            media=mediaClock(item,await Promise.race([item.transport.status(),new Promise(resolve=>setTimeout(resolve,4000))]).catch(()=>null));
            check(item);
        }
        return {status:'ready',captureSessionId:item.id,startedAt:item.seed.startedAt,...(media??{deadlineAt:item.seed.deadlineAt})};
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
                if(item.granting)retire(item);else item.transport?.dispose();
                if(active===item)active=null;drained?.();
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
        // A granted phase may still deliver its final clip, so it only locks; one with no grant yet has nothing to
        // deliver and is released at once, as `cancel` releases it.
        if(d.type==='lock'){
            if(active && active.id===d.captureSessionId && !active.shareEnded){
                if(active.grant)suspend(active);else void end(active,'connection_lost',active.expected);
            }
            return;
        }
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
    // `workbench`: this report is the editor's mounted workbench (`../apps/code-folder.js` `onWorkbench`), not the
    // folder echo read from the document's address. Under the acknowledged release only that one goes on: the echo
    // still refuses a wrong folder at once, but an editor document whose workbench never starts stays parked, tells
    // Universe nothing and fails `unlock` on its own timer. Without the flag the echo releases as before.
    function confirm(frame,frameUrl,actualRoot,workbench=false){
        const item=active;
        if(!item?.allowMint || !item.editor || !live(item) || !frame.isConnected)return;
        const url=new URL(frameUrl), folders=[item.meta.workspaceFolder,item.meta.checkoutFolder];
        if(!folders.includes(actualRoot) || !folders.includes(url.searchParams.get('folder'))){item.editor.reject(failure('assigned_checkout_unverified'));return;}
        if(workbench!==editorReady)return;
        void release(item,frame);
    }
    /**
     * The verified editor document is loaded and still parked. Under the acknowledged release Universe is told first
     * (`editor-ready`: this capture and its open proof, no time) and only its answer releases the editor; a refusal
     * leaves it parked and fails `unlock`. Then, in this order: the editor is shown, the port hears `editor-usable`,
     * `unlock` is answered and the window state becomes `ready`.
     */
    async function release(item,frame){
        const pending=item.editor;
        if(pending.frame===frame)return;
        pending.frame=frame;
        const waiting=()=>live(item) && item.allowMint && item.editor===pending;
        const still=()=>waiting() && pending.frame===frame && frame.isConnected;
        try{
            // Asked once per capture, whichever Code window's editor reports first: a window closed while Universe
            // answers leaves the answer here, and the next window's editor is released on it without asking again.
            if(editorReady && !item.acknowledged){
                if(typeof item.transport.editorReady!=='function')throw failure('editor_ready_unsupported');
                item.asked??=retry(()=>item.transport.editorReady(),EDITOR_READY_TRANSIENT,3,()=>live(item) && item.allowMint)
                    .then(answer=>{
                        note('editor_ready.reported');
                        item.acknowledged=true;
                        const deadlineAt=isoTime(answer?.deadlineAt), serverNow=isoTime(answer?.serverNow);
                        item.clock={...(deadlineAt?{deadlineAt}:{}),...(serverNow?{serverNow}:{})};
                    });
                await item.asked;
            }
        }catch(error){
            if(!waiting())return;
            note('editor_ready.refused',error);
            pending.reject(error);
            if(identityCodes.includes(error?.code))failed(error);
            return;
        }
        if(!still())return;
        locked=false;park(false,false);ui.reveal();
        // Universe and the port hear of this capture's editor once: a reopened Code window only shows it again.
        if(item.released){pending.resolve();return;}
        note('editor.usable');
        send('editor-usable',{captureSessionId:item.id,...(item.clock??{})});
        item.released=true;pending.resolve();setState('ready');
    }
    /**
     * The editor of a Code window opened again under this live, already released capture. Its mint is a `reopen` of
     * the same receipt and capture (`access`), and it stays parked under the window's loader until `confirm` verifies
     * its folder (and its mounted workbench under the acknowledged release). There is no timer: the capture is the
     * tab's, not the window's. A wrong folder ends the phase as a lost workspace does.
     */
    function reopenEditor(item){
        const pending={again:true};
        void new Promise((resolve,reject)=>Object.assign(pending,{resolve,reject})).catch(()=>{
            if(active!==item || item.ending || item.shareEnded)return;
            suspend(item);send('pause',{reason:'connection_lost',effectiveAt:null});void end(item,'connection_lost',item.expected);
        }).finally(()=>{if(item.editor===pending)item.editor=null;});
        item.editor=pending;
    }
    /** The Code window closed (its native X), and only that: nothing ends, nothing is sent, nothing is reset. */
    function detach(){
        if(closing || !surface)return;
        surface=null;locked=true;ui.remove();
        const pending=active?.editor;
        if(pending?.again){active.editor=null;pending.resolve();}
    }
    /** This document's next Code window for the same assignment: the gate's screen, and its editor where one is due. */
    function attach(next){
        surface=next;ui=buildGate(next.body);
        Object.assign(kept,{computerProvider:next.computerProvider,wake:next.wake,summon:next.summon});
        const item=active;
        if(shown)lock(...shown);
        else{
            prep();
            if(item?.allowMint && live(item)){
                if(!item.editor && item.released)reopenEditor(item);
                // After this call returns: the window's own `open` reads the gate it is handed here.
                if(item.editor)queueMicrotask(()=>{if(surface===next && active===item && item.editor && live(item))next.open();});
            }
        }
        for(const resolve of [...waiters]){waiters.delete(resolve);resolve(next);}
    }
    // This same document, person and computer, still framed by its Universe work page for this attempt.
    const held=(inWin,computer,who)=>!closing && current===gate && inWin===win && computer===computerId && owned() && who===owner
        && embeddedWorkFrame(win) && assignmentIntent(assignmentEntry(win),repo)===attemptId;
    function close(){
        if(closePromise)return closePromise;
        closing=true;reply.dispose();clearInterval(watch);clearTimeout(silent);
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
    // `requiresWorkbench`: Universe signed the acknowledged release, so the Code window asks its editor for the mounted
    // workbench and reports it through `confirm(…, true)`. Only this gate has it; a stage without the flag asks nothing.
    const gate={repo,locked:()=>locked,confirm,close,requiresWorkbench:()=>editorReady,detach,attach,held,windowless:()=>!closing && !surface,
        // `open` until this capture's editor is first released; every mint after that (the Code window opened again, at
        // any age of the capture) is `reopen`, with the ORIGINAL receipt and capture. No new checkout is prepared for it.
        access:()=>active?.allowMint && live(active)
            ? {attemptId,phase:active.released?'reopen':'open',repoOpenProof:active.proof,captureSessionId:active.id} : null};
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
 * True only for the Code window of an assignment framed by its own Universe work page: exactly the case the embedded
 * gate below takes. That window keeps the ordinary window controls a framed shell otherwise drops.
 */
export function embeddedAssignmentWindow(project, win=globalThis.window) {
    try{return Boolean(win) && win.location.origin===OS && Boolean(assignmentIntent(assignmentEntry(win),project?.repoUrl)) && embeddedWorkFrame(win);}
    catch{return false;}
}

/** The embedded assignment this document holds with no Code window, only for this same window, computer and owner. */
function heldAssignment(win,computerId,actor) {
    try{return current?.windowless?.() && current.held(win,computerId,actor?.()) ? current : null;}catch{return null;}
}
/**
 * The repository a Code launch that names none opens in this document: the one assignment its Universe work page
 * framed here, while this document still holds it for this person and computer. The dock and the launcher carry no
 * project, so a Code window closed under an assignment comes back on that assignment, never on the person's own files.
 */
export function assignedProject({computerId, actor, win=globalThis.window}={}) {
    const gate=heldAssignment(win,computerId,actor);
    return gate ? {repoUrl:gate.repo} : null;
}

export function openWithAssignmentConsent({project, computerId, actor, open, body, park, prepare, computerProvider, wake, summon, transport}) {
    const win=globalThis.window, repo=project?.repoUrl;
    // An assignment this document holds with no Code window: this launch takes it back when it is for that repository,
    // person and computer. Any other Code launch ends its phase, as relaunching its window for another project did.
    const windowless=current?.windowless?.() ? current : null;
    const mine=repo && heldAssignment(win,computerId,actor)?.repo===repo ? windowless : null;
    if(windowless && !mine)void windowless.close();
    if(!win || win.location.origin!==OS){queueMicrotask(open);return null;}
    const address=new URL(win.location.href);
    const entry=assignmentEntry(win);
    const attemptId=assignmentIntent(entry,repo);
    const explicit=address.pathname==='/app/code' && address.searchParams.has('assignment');
    if(!canonical.test(repo) && !explicit){queueMicrotask(open);return null;}
    // Framed by its own Universe workspace: a separate gate that waits for that exact parent and never uses the picker.
    if(attemptId && embeddedWorkFrame(win)){
        if(mine){mine.attach({open,body,park,prepare,computerProvider,wake,summon});return mine;}
        return openEmbeddedAssignment({attemptId,repo,computerId,actor,open,body,park,prepare,computerProvider,wake,summon,transport,win});
    }

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

/** `workbench`: true only for the editor's own mounted-workbench report; the folder echo passes nothing. */
export function confirmAssignmentFolder(project,_receipt,frame,frameUrl,actualRoot,workbench){
    if(current?.repo===project?.repoUrl)current.confirm(frame,frameUrl,actualRoot,workbench===true);
}
