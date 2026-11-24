// Real OS shell, real Chromium tab capture, and synthetic assignment/compute/evidence services.
// Build the exact candidate into EZIL_SHELL_OUT_DIR. Run: node shell/ezil/assignment-video/upgrade-browser-test.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const require = createRequire(path.join(process.env.PLAYWRIGHT_REQUIRE_DIR || '/opt/ezil-testkit', 'test.cjs'));
const { chromium } = require('playwright');
const assets = process.env.EZIL_SHELL_OUT_DIR || new URL('../../../app/public/os/', import.meta.url).pathname;
const preflightOnly = process.env.EZIL_UPGRADE_BASELINE_ONLY === '1';
const legacySeed = preflightOnly || process.env.EZIL_UPGRADE_LEGACY_SEED === '1';
const productionOrigin = process.env.EZIL_QA_PRODUCTION_ORIGIN === '1';
const os = productionOrigin ? 'https://os.ezil.work' : 'https://os-staging.ezil.work';
const editor = 'https://assignment-editor.invalid';
const universe = 'https://universe.invalid';
const environment = productionOrigin ? 'production' : 'staging';
const bucket = 'https://ezil-universe-' + environment + '-assignment-media-452630323510-aps1.s3.ap-south-1.amazonaws.com';
const attemptId = '2d5fd5d2-ad3e-47ea-9a95-60eb51bce32a';
const recordingId = '01111111-2222-4333-8444-555555555555';
const computerId = '11111111-1111-4111-8111-111111111111';
const repoId = '12222222-3333-4444-8555-666666666666';
const repoName = 'u-0482ba160482ba16-a-' + attemptId;
const repo = 'https://github.ezil.work/default/' + repoName + '.git';
const workspaceFolder = '/workspace/projects/' + repoId;
const checkoutFolder = workspaceFolder + '/' + repoName;
const entry = os + '/app/code?repo=' + encodeURIComponent(repo) + '&assignment=' + attemptId;
const title = 'Isolated assignment upgrade rehearsal';
const proof = 'q'.repeat(70);
const iso = at => at === null ? null : new Date(at).toISOString();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const seen = [];

const assignment = {
    clockStarted: null, mediaStarted: null, deadline: null, pausedAt: null, revision: 0,
    phase: null, seedSequence: null, nextSequence: 0, submittedAt:null, finalized:null,
    confirmed: [], prepared: new Map(), put: new Map(), pauses: [],
};
const migration = { id: null, phase: null, to:'std-2', assignedTier:'standard-trial', assignedProvider:'cloudflare', upgradedOperation:null };
let replayedClock;
let firstEditorDocument = false;
let releaseFirstEditor;
const firstEditorGate = new Promise(resolve => { releaseFirstEditor = resolve; });
const boot = {
    user: { id:'33333333-3333-4333-8333-333333333333', email:'fixture@example.test' },
    computer: { id:computerId, name:'QA computer', slot:1, isNew:false },
    apps: [],
    desktopState: { provider:'cloudflare-guacamole', configured:true, hasHmacSecret:true, status:'idle', endpoints:{system:'/api/shell/system'},
        ui:{floatingControls:false, feedbackScreenshots:false} },
};
const html = '<!doctype html><html><head><title>' + title + '</title><link rel="stylesheet" href="/os/bundle.min.css"></head>'
    + '<body><div id="ezil-os-root"></div><script>window.__EZIL_BOOT__=' + JSON.stringify(boot)
    + '</script><script src="/os/icons.js"></script><script src="/os/bundle.min.js"></script></body></html>';
const frame = '<!doctype html><title>Assigned editor</title><label>Source code<textarea autofocus></textarea></label>'
    + '<button id="checkout">Open plan checkout</button><dialog><p>Upgrade checkout</p><button id="cancel">Cancel checkout</button></dialog>'
    + '<script>checkout.onclick=()=>document.querySelector("dialog").showModal();cancel.onclick=()=>document.querySelector("dialog").close();'
    + 'addEventListener("message",event=>{if(event.origin!==' + JSON.stringify(os) + '||event.data.type!=="ezil.code.hello")return;'
    + 'const u=new URL(location.href);parent.postMessage({type:"ezil.code.folder",v:1,nonce:event.data.nonce,mint:u.searchParams.get("ezil_mint"),'
    + 'kind:"folder",path:u.searchParams.get("folder")},event.origin);});</script>';

function clock(now = Date.now()) {
    return {
        startedAt: iso(assignment.clockStarted), deadlineAt: iso(assignment.deadline), serverNow: iso(now),
        pausedAt: iso(assignment.pausedAt), pauseReason: assignment.pausedAt === null ? null : 'resource_upgrade',
        remainingMs: assignment.deadline === null ? null : Math.max(0, assignment.deadline - (assignment.pausedAt ?? now)),
        revision: assignment.revision,
    };
}
function ready() {
    if (assignment.clockStarted !== null) return;
    assignment.clockStarted = Date.now();
    assignment.deadline = assignment.clockStarted + 3600000;
    assignment.revision++;
}
function sampleClock() {
    const mediaDeadline = (assignment.mediaStarted || Date.now()) + 3600000;
    if (legacySeed && assignment.clockStarted !== null) return clock();
    return {startedAt:iso(assignment.mediaStarted), deadlineAt:iso(assignment.deadline ?? mediaDeadline), serverNow:iso(Date.now()),
        workStartedAt:iso(assignment.clockStarted), pausedAt:iso(assignment.pausedAt),
        pauses:assignment.pauses.map(({start,end})=>({startedAt:iso(start),endedAt:iso(end)}))};
}
function fixtureMigration(phase, operationId) {
    if (phase === 'requested') {
        if (migration.id === operationId) return;
        assert.equal(assignment.pausedAt, null);
        migration.id = operationId;
        migration.phase = phase;
        assignment.pausedAt = Date.now();
        assignment.pauses.push({start:assignment.pausedAt,end:null});
        assignment.revision++;
        return;
    }
    if (migration.id !== operationId || assignment.pausedAt === null) return;
    migration.phase = phase;
    if (phase === 'done') {
        migration.assignedTier = migration.to;
        migration.assignedProvider = 'aws-ec2';
        migration.upgradedOperation = operationId;
    }
    const settledAt = Date.now();
    assignment.deadline += settledAt - assignment.pausedAt;
    assignment.pauses.at(-1).end = settledAt;
    assignment.pausedAt = null;
    assignment.revision++;
}
function recordedState() {
    return { recordingId, captureSessionId:assignment.phase, status:assignment.pausedAt === null ? 'recording' : 'paused',
        phaseReady:assignment.pausedAt === null, workspaceUnlocked:assignment.pausedAt === null, firstFrameAt:iso(assignment.mediaStarted), revoked:false,
        stopRequestedAt:iso(assignment.submittedAt), stopReason:assignment.submittedAt === null ? null : 'submitted', ...sampleClock() };
}
async function check(label, predicate, timeout = 18000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
        if (await predicate()) return;
        await sleep(150);
    }
    throw new Error('Timed out: ' + label);
}
const browser = await chromium.launch({
    headless:process.env.EZIL_CHROME_HEADED !== '1',
    executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/google-chrome',
    args:['--disable-dev-shm-usage','--auto-select-tab-capture-source-by-title=' + title,'--host-resolver-rules=MAP * ~NOTFOUND'],
});
try {
    const context = await browser.newContext({ viewport:{width:1100,height:840} });
    await context.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        const json = (body, status = 200) => route.fulfill({ status, contentType:'application/json', json:body });
        const document = body => route.fulfill({ contentType:'text/html', body });
        if (url.origin === universe) {
            if (url.pathname === '/submit') {
                assert.equal(request.method(),'POST');
                assert.equal(request.postDataJSON()?.attemptId,attemptId);
                assert.equal(migration.assignedTier,'std-2');
                assert.ok(assignment.clockStarted !== null && Date.now() < assignment.deadline);
                assignment.submittedAt = Date.now();
                return json({ok:true});
            }
            return document('<a href="' + entry.replaceAll('&','&amp;') + '">Open assignment editor</a>'
                + '<button id="submit-assignment">Submit assignment</button>'
                + '<script>document.querySelector("button").onclick=()=>fetch("/submit",{method:"POST",body:JSON.stringify({attemptId:'
                + JSON.stringify(attemptId) + '})});</script>');
        }
        if (url.origin === editor) {
            assert.equal(url.searchParams.get('folder'), workspaceFolder);
            if (!firstEditorDocument && !legacySeed) await firstEditorGate;
            firstEditorDocument = true;
            return document(frame);
        }
        if (url.origin === bucket && request.method() === 'OPTIONS')
            return route.fulfill({ status:204, headers:{'Access-Control-Allow-Origin':os,'Access-Control-Allow-Methods':'PUT'} });
        if (url.origin === bucket && request.method() === 'PUT') {
            const match = url.pathname.match(/\/segments\/(\d+)\/([a-f0-9]{64})\.webm$/);
            assert.ok(match);
            const [, sequence, digest] = match;
            assert.equal(assignment.prepared.get(Number(sequence))?.sha256, digest);
            const bytes = request.postDataBuffer();
            assert.ok(bytes && bytes.length > 0);
            assert.equal(bytes.length, assignment.prepared.get(Number(sequence)).byteLength);
            assert.equal(createHash('sha256').update(bytes).digest('hex'), digest);
            assignment.put.set(Number(sequence), bytes);
            return route.fulfill({ status:200, headers:{'Access-Control-Allow-Origin':os}, body:'' });
        }
        if (url.origin !== os) return route.abort();
        if (url.pathname === '/app/code') {
            assert.equal(url.searchParams.get('assignment'), attemptId);
            assert.equal(url.searchParams.get('repo'), repo);
            return document(html);
        }
        if (url.pathname.startsWith('/os/')) {
            const file = path.join(assets,path.basename(url.pathname));
            if (!fs.existsSync(file)) return route.abort();
            return route.fulfill({contentType:file.endsWith('.css') ? 'text/css' : 'text/javascript',body:fs.readFileSync(file)});
        }
        if (url.pathname === '/api/shell/code-preview-url') {
            const body = request.postDataJSON();
            assert.equal(body.computerId, computerId);
            assert.equal(body.repository.url, repo);
            assert.equal(body.assignment.attemptId, attemptId);
            const repository = {id:repoId, name:'default/' + repoName, workspaceFolder, checkoutFolder};
            seen.push('checkout:' + body.assignment.phase);
            if (body.assignment.phase === 'prepare') {
                return json({ok:true, repository, assignmentOpen:{attemptId, proof, openedAt:iso(Date.now()),
                    windowStartedAt:iso(assignment.clockStarted), deadlineAt:iso(assignment.deadline)}});
            }
            const url = editor + '/?folder=' + encodeURIComponent(workspaceFolder);
            return json({ok:true, repository, codePreviewUrl:url, url});
        }
        if (url.pathname === '/api/shell/assignment-video') {
            const body = request.postDataJSON();
            assert.equal(body.attemptId, attemptId);
            seen.push(body.action);
            const expiry = iso(Date.now() + 600000);
            switch (body.action) {
            case 'preflight': return json({status:'eligible', attemptId, jobId:'1', repositoryUrl:repo, expiresAt:expiry, ...sampleClock(),
                ...(migration.upgradedOperation ? {upgradedWorkspaceId:computerId,upgradeOperationId:migration.upgradedOperation} : {})});
            case 'clock': {
                if (!replayedClock) return json(clock());
                const replay = replayedClock;
                replayedClock = null;
                return json(replay);
            }
            case 'editor-ready':
                assert.ok(firstEditorDocument,'first ready request must follow actual editor document');
                assert.equal(body.captureSessionId, assignment.phase);
                assert.equal(body.repoOpenProof, proof);
                assert.ok(assignment.confirmed.length > 0);
                ready();
                return json(clock());
            case 'begin':
                assert.equal(body.repoOpenProof, proof);
                assert.equal(body.consentAccepted, true);
                assert.equal(body.consentVersion, 4);
                assignment.phase = body.captureSessionId;
                assignment.seedSequence = assignment.nextSequence;
                return json({status:'awaiting_frame', recordingId, captureSessionId:assignment.phase,
                    nextSequence:assignment.nextSequence, authorizationExpiresAt:expiry, ...sampleClock()});
            case 'status':
                assert.equal(body.captureSessionId, assignment.phase);
                return json(recordedState());
            case 'prepare':
                assert.equal(body.captureSessionId, assignment.phase);
                assert.ok(body.endMs > body.startMs);
                if (!legacySeed && body.sequence !== assignment.seedSequence && assignment.pauses.some(({start,end})=>
                    assignment.mediaStarted + body.startMs < (end ?? Infinity) && assignment.mediaStarted + body.endMs > start)) {
                    seen.push('outside_capture_window');
                    return json({error:{code:'outside_capture_window'}},409);
                }
                assignment.prepared.set(body.sequence, body);
                return json({headers:{}, expiresAt:expiry, putUrl:bucket + '/universe-' + environment + '/assignment-media/v1/isolated/'
                    + attemptId + '/' + recordingId + '/segments/' + body.sequence + '/' + body.sha256 + '.webm'});
            case 'confirm':
                assert.equal(body.captureSessionId, assignment.phase);
                assert.ok(assignment.put.has(body.sequence));
                if (body.sequence === assignment.nextSequence) {
                    assignment.nextSequence++;
                    assignment.confirmed.push(assignment.prepared.get(body.sequence));
                }
                if (body.sequence === assignment.seedSequence) {
                    assignment.mediaStarted ??= Date.now();
                    if (legacySeed && !preflightOnly) ready();
                    return json({confirmed:true, sequence:body.sequence, nextSequence:assignment.nextSequence, ...recordedState()});
                }
                return json({confirmed:true, sequence:body.sequence, recordingId});
            case 'checkpoint':
                assert.equal(body.captureSessionId, assignment.phase);
                return json({status:'paused', ...clock()});
            case 'finalize':
                assert.equal(body.captureSessionId, assignment.phase);
                assignment.finalized = body;
                return json({status:'stopped'});
            default: return json({error:{code:'unknown_test_action'}}, 400);
            }
        }
        if (url.pathname === '/api/trpc/computer.progress') {
            const inFlight = migration.phase === 'requested';
            return json({result:{data:{json:{
                version:2, computerId, provider:migration.assignedProvider, lifecycleState:inFlight ? 'STOPPING' : 'RUNNING',
                stage:inFlight ? 'stopping' : 'running', operation:inFlight ? 'switching' : 'none',
                configuration:migration.assignedTier,
                transition:migration.id && {transitionId:migration.id,kind:'switch',phase:migration.phase,target:migration.to},
            }}}});
        }
        if (url.searchParams.get('confirm') === 'frame') return json({ok:true,confirmed:true,status:200});
        if (url.pathname === '/api/shell/system') {
            assert.equal(url.searchParams.get('computerId'), computerId);
            return json({ok:true,info:{provider:migration.assignedProvider}});
        }
        if (url.pathname === '/api/shell/desktop') return json({ok:true,guacamoleRunning:true});
        if (url.pathname.startsWith('/api/')) return json({ok:true,reports:[]});
        return route.fulfill({status:404,body:''});
    });

    const page = await context.newPage();
    page.setDefaultTimeout(18000);
    const errors = [];
    const trace = [];
    page.on('console', message => { if (message.text().startsWith('QA_TRACE ')) trace.push(message.text()); });
    page.on('pageerror', error => errors.push(error.message));
    const failed = [];
    page.on('requestfailed', request => failed.push([new URL(request.url()).pathname,request.failure()?.errorText]));
    const share = page.getByRole('button',{name:/Share this (EZiL )?OS tab and open assignment/});
    const editorFrame = page.frameLocator('.window[data-app="code"] iframe');
    const source = editorFrame.getByRole('textbox',{name:'Source code'});
    const control = page.getByRole('group',{name:'Assignment recording'});
    const timer = control.getByRole('timer');
    const seconds = async () => (await timer.innerText()).split(':').reduce((sum,next)=>sum*60+Number(next),0);
    const stop = control.getByRole('button',{name:'Stop sharing this assignment tab'});
    const transitionSignal = id => page.evaluate(({ computerId, id }) => {
        window.dispatchEvent(new CustomEvent('ezil:computer-transition',{detail:{computerId,transitionId:id}}));
    }, {computerId,id});
    const openShare = async ({first = false} = {}) => {
        await share.waitFor();
        await page.evaluate(name => { document.title = name; },title);
        await share.click();
        if (first && !legacySeed) {
            await check('a verified capture handoff is requested', () => seen.includes('checkout:open'));
            assert.equal(assignment.clockStarted,null,'a sealed readiness frame alone cannot start assignment time');
            if (await timer.isVisible()) assert.equal(await timer.innerText(),'--:--');
            releaseFirstEditor();
        }
        await source.waitFor();
        await source.fill('const sameAssignment = true;');
    };

    try {
        await page.goto(universe + '/explore-job/isolated-synthetic-assignment');
        await page.getByRole('link',{name:'Open assignment editor'}).click();
        await page.waitForURL(url => url.origin === os && url.pathname === '/app/code');
        await page.waitForFunction(() => typeof window.ezil?.boot === 'function');
        await page.evaluate(() => window.ezil.boot());
        await share.waitFor();
        assert.equal(assignment.clockStarted, null);
        assert.deepEqual(assignment.confirmed, []);
        await openShare({first:true});
        assert.ok(assignment.confirmed.length >= 1,'seed must be confirmed before opening a usable editor');
        if (preflightOnly) {
            console.log(JSON.stringify({result:'baseline captured editor',confirmed:assignment.confirmed.length,actions:seen}));
        } else {
            await check('first interactive editor starts the authoritative clock', () => assignment.clockStarted !== null);
            if (!legacySeed) assert.ok(seen.includes('editor-ready'));
            assert.equal(await control.locator('.ezil-assignment-recording-dot').count(), 1);
            assert.equal(await stop.isVisible(), true);
            await check('running timer',async () => Number.isFinite(await seconds()));
            const originalStart = assignment.clockStarted;
            const initialDeadline = assignment.deadline;

            const beforeCheckout = await seconds();
            await editorFrame.getByRole('button',{name:'Open plan checkout'}).click();
            await editorFrame.getByText('Upgrade checkout').waitFor();
            await check('clock still advances behind checkout',async () => await seconds() < beforeCheckout);
            await editorFrame.getByRole('button',{name:'Cancel checkout'}).click();
            assert.equal(assignment.deadline, initialDeadline);
            assert.equal(assignment.pausedAt, null);
            await check('recorded footage exists before upgrade',()=>assignment.confirmed.length > 1);

            for (const outcome of ['failed','done']) {
                const operationId = outcome === 'done' ? '743985b2-8b21-4e3c-ae13-956c2e7672ef' : '8bf4fc87-a2ff-4be7-9ead-261edbba38cc';
                const expectedTier = outcome === 'done' ? migration.to : migration.assignedTier;
                const expectedProvider = outcome === 'done' ? 'aws-ec2' : migration.assignedProvider;
                const priorDeadline = assignment.deadline;
                const initialSegments = assignment.confirmed.length;
                fixtureMigration('requested', operationId);
                const serverPauseAt = assignment.pausedAt;
                await transitionSignal(operationId);
                await check('verified resource upgrade shown as paused', async () => await control.getAttribute('data-state') === 'paused');
                const pauseSeenAt = Date.now();
                const browserPauseSeenAt = await page.evaluate(() => Date.now());
                const frozen = await seconds();
                const revision = assignment.revision;
                const pauseReport = clock();
                fixtureMigration('requested', operationId);
                await transitionSignal(operationId);
                assert.equal(assignment.revision, revision,'duplicate operation cannot grant time');
                await sleep(2400);
                assert.equal(await seconds(), frozen,'server-confirmed pause preserves the same remaining time');
                fixtureMigration(outcome, operationId);
                const cutoff = assignment.pauses.at(-1).end;
                assert.ok(assignment.deadline - priorDeadline >= 2400);
                const afterDeadline = assignment.deadline;
                fixtureMigration(outcome, operationId);
                assert.equal(assignment.deadline, afterDeadline,'duplicate settlement cannot extend the window');
                const reconnect = page.getByRole('button',{name:'Reconnect editor'});
                await check('same browser capture resumes',async () => {
                    if (await reconnect.isVisible()) await reconnect.click();
                    return await control.getAttribute('data-state') === 'recording';
                }, 25000);
                await source.fill('const resumed = true;');
                await check('authoritative countdown resumes', async () => await seconds() < frozen);
                replayedClock = pauseReport;
                await check('delayed prior clock report was sent',() => replayedClock === null);
                assert.equal(await control.getAttribute('data-state'),'recording','stale pause produced no extra interruption');
                await check('capture after upgrade reaches evidence ledger',() => assignment.confirmed.slice(initialSegments)
                    .some(segment => assignment.mediaStarted + segment.startMs >= cutoff));
                const overlaps = assignment.confirmed.filter(segment => segment.sequence > 0
                    && assignment.mediaStarted + segment.startMs < cutoff
                    && assignment.mediaStarted + segment.endMs > (legacySeed ? pauseSeenAt + 800 : serverPauseAt));
                assert.deepEqual(overlaps,[],'upgrade interruption leaves a real empty interval in the timeline ' + JSON.stringify({
                    clockStarted:assignment.clockStarted, mediaStarted:assignment.mediaStarted, serverPauseAt, pauseSeenAt, browserPauseSeenAt, cutoff,
                    segments:assignment.confirmed.map(({sequence,startMs,endMs})=>({sequence,startMs,endMs})),
                }));
                assert.equal(assignment.clockStarted, originalStart);
                assert.equal(migration.assignedTier,expectedTier,'same assigned computer keeps the recovery tier or reaches the successful upgrade');
                assert.equal(migration.assignedProvider,expectedProvider,'provider state belongs to the selected computer');
            }

            const deadline = assignment.deadline;
            const beforeStop = await seconds();
            await stop.click();
            await share.waitFor();
            assert.equal(await stop.isVisible(), false);
            await check('countdown stays visible after Stop', async () => await timer.isVisible() && await seconds() < beforeStop);
            assert.equal(assignment.deadline, deadline);
            const oldPhase = assignment.phase;
            const priorEvidence = assignment.confirmed.length;
            await page.reload();
            await page.evaluate(() => window.ezil.boot());
            assert.equal(assignment.clockStarted, originalStart);
            assert.equal(assignment.deadline, deadline);
            await check('server clock is visible after reload before new consent',async () => await timer.isVisible());
            await openShare();
            assert.notEqual(assignment.phase,oldPhase,'refresh starts another capture phase for the same attempt');
            assert.ok(assignment.confirmed.length > priorEvidence,'new footage appends to retained footage');
            assert.equal(assignment.deadline,deadline);
            const drawer = page.locator('.window[data-app="code"] > .ezil-app-drawer');
            await drawer.locator('.dashboard-app-drawer-toggle').focus();
            await drawer.locator('.dashboard-app-drawer-close').click();
            await page.locator('.window[data-app="code"]').waitFor({state:'detached'});
            assert.equal(assignment.deadline,deadline);
            await page.goto(entry);
            await page.waitForFunction(() => typeof window.ezil?.boot === 'function');
            await page.evaluate(() => window.ezil.boot());
            await check('reopening closed editor restores the running timer',async () => await timer.isVisible());
            assert.equal(assignment.clockStarted,originalStart);
            assert.equal(assignment.deadline,deadline);
            await openShare();
            const application = await context.newPage();
            await application.goto(universe + '/explore-job/isolated-synthetic-assignment');
            await application.getByRole('button',{name:'Submit assignment'}).click();
            await page.bringToFront();
            await check('submission finalizes the same recording', () => assignment.finalized?.reason === 'submitted');
            assert.equal(assignment.finalized.expectedSegments,assignment.confirmed.length);
            await application.close();
            assert.deepEqual(errors,[]);
            for (const bytes of [assignment.put.get(0), assignment.put.get(assignment.confirmed.at(-1).sequence)]) {
                const codec = execFileSync('ffprobe',['-v','error','-show_entries','stream=codec_name','-of','csv=p=0','-i','pipe:0'],{input:bytes,encoding:'utf8'}).trim();
                assert.equal(codec,'vp8','previous and newly saved real tab segments decode as VP8');
            }
            console.log(JSON.stringify({result:'pass', attemptId, provider:migration.assignedProvider, assignedTier:migration.assignedTier,
                cases:['first editor','checkout abandonment','trusted upgrade','failed upgrade recovery','duplicate events','Stop','refresh and re-share','close and reopen','submission finalization'],
                evidenceSegments:assignment.confirmed.length, origin:os, intercepted:['Universe job entry','assignment HTTP','OS provider','editor','private storage']}));
        }
    } catch (error) {
        console.error(JSON.stringify({url:page.url(), assets, seen, errors, trace, failed:failed.slice(-15), controls:await control.allTextContents(), gates:await page.locator('.ezil-assignment-video-panel').allTextContents()}));
        throw error;
    }
} finally {
    await browser.close();
}
