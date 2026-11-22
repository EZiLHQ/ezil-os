import {currentTabPicker, STAGING_OS} from './current-tab.js';
import {showShellClicks} from './shell-clicks.js';
import {encodeTabSegments} from './tab-segments.js';
import {checkAssignmentVideoEligibility, createAssignmentVideoTransport} from './transport.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const canonical = /^https:\/\/github\.ezil\.work\/default\/u-[0-9a-f]{16}-a-([0-9a-f-]{36})\.git$/;
const initialEntry = globalThis.location?.href;
let current;

export function assignmentIntent(href, repoUrl) {
    const match = canonical.exec(repoUrl);
    if (!match || !uuid.test(match[1])) return null;
    let url;
    try { url = new URL(href); } catch { return null; }
    if (url.origin !== STAGING_OS || url.pathname !== '/app/code' || url.username || url.password
        || url.searchParams.getAll('assignment').length > 1 || url.searchParams.getAll('repo').length !== 1
        || url.searchParams.get('repo') !== repoUrl) return null;
    const id = url.searchParams.get('assignment');
    // This is a routing hint only. The same-session server preflight must return this exact enrolled repository.
    return id === null || id === match[1] ? match[1] : null;
}

function panel(win) {
    const doc = win.document;
    const box = doc.createElement('aside');
    box.className = 'ezil-assignment-video-panel';
    box.setAttribute('aria-label','Assignment recording');
    const text = doc.createElement('span');
    text.setAttribute('role','status');
    box.append(text);
    doc.body.append(box);
    function button(label, handler) {
        const button = doc.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.addEventListener('click', event => { if (event.isTrusted) handler(); });
        box.append(button);
    }
    return {set(message, actions = []) {
        if (!box.isConnected) return;
        box.replaceChildren(text);
        text.textContent = message;
        for (const [label, handler] of actions) button(label, handler);
    }, remove: () => box.remove()};
}

export function openWithAssignmentConsent({project, actor, open}) {
    const win = globalThis.window;
    if (!win || win.top !== win || win.location.origin !== STAGING_OS) { open(); return; }
    const repo = project?.repoUrl;
    if (current && (current.repo !== repo || current.actor() !== actor())) {
        current.stop('stopped'); current = undefined;
    }
    const address = new URL(win.location.href);
    const entry = address.searchParams.has('repo') || address.searchParams.has('assignment') ? address.href : initialEntry;
    const attemptId = assignmentIntent(entry,repo);
    if (!attemptId || !actor()) { open(); return; }
    if (current) { open(); return; }
    const owner = actor();
    const ui = panel(win);
    let source, picker, transport, recorder, grant, terminal = false, openCalled = false;
    let beginPending, deadlineTimer, sourceTimer, closeClickCues, clipCount = 0;
    const sameOwner = () => actor() === owner;
    const launch = () => { if (!openCalled) { openCalled = true; open(); } };
    function showClosed(message) { ui.set(message, [['Dismiss', () => ui.remove()]]); }
    function stop(reason = 'stopped', message, effectiveAt) {
        if (terminal) return;
        terminal = true;
        win.clearTimeout(deadlineTimer); win.clearTimeout(sourceTimer);
        source?.stream.getTracks().forEach(t => t.stop());
        closeClickCues?.();
        picker?.dispose();
        win.removeEventListener('pagehide', pageHide);
        win.removeEventListener('ezil:teardown', pageHide);
        if (!openCalled) launch();
        const saving = Boolean(transport);
        ui.set(saving ? 'Recording stopped. Saving confirmed assignment footage…' : 'Assignment recording is off.');
        void (async () => {
            try {
                let interrupted = false;
                try { await beginPending; } catch { interrupted = true; }
                try { if (recorder) clipCount = (await recorder.stop(effectiveAt)).expectedSegments; } catch { interrupted = true; }
                if (grant) await transport.finalize({reason,expectedSegments:clipCount});
                if (interrupted) throw new Error('incomplete');
                showClosed(message || (clipCount ? 'Assignment recording stopped.' : 'No assignment footage was confirmed.'));
            } catch {
                showClosed('Assignment recording was interrupted. Some footage may be missing.');
            } finally { transport?.dispose(); }
        })();
    }
    function pageHide() { stop('stopped', 'Assignment recording ended when this OS session closed.'); }
    win.addEventListener('pagehide',pageHide,{once:true});
    win.addEventListener('ezil:teardown',pageHide,{once:true});
    const stopButton = [['Stop sharing', () => stop()]];
    const available = () => !terminal && sameOwner() && source?.matches()
        && !source.stream.getVideoTracks()[0].muted;
    function checkSource() {
        if (terminal) return;
        if (!available()) { stop('stopped','Assignment recording was interrupted when the shared tab changed.'); return; }
        sourceTimer = win.setTimeout(checkSource, 1000);
    }
    function chooser() {
        if (terminal) return;
        ui.set('Record this EZiL OS tab at one frame per second, including visible Code, Settings and Browser activity. Audio is off. You can stop sharing at any time.', [
            ['Share this EZiL OS tab and open assignment', choose], ['Open without sharing', () => stop()],
        ]);
    }
    async function choose() {
        if (terminal || !sameOwner()) { stop(); return; }
        ui.set('Choose this EZiL OS tab in the browser sharing dialog.');
        try {
            source = await picker.choose();
            if (terminal || !sameOwner()) { source.stream.getTracks().forEach(t => t.stop()); return; }
            const track = source.stream.getVideoTracks()[0];
            track.addEventListener('ended', () => stop('stopped','The browser stopped sharing the assignment tab.'), {once:true});
            track.addEventListener('mute', () => stop('stopped','The browser interrupted assignment tab sharing.'), {once:true});
            track.addEventListener('capturehandlechange', () => { if (!source.matches()) stop('stopped','The shared tab changed.'); });
            ui.set('Tab sharing is on. Recording will start when the assigned repository opens.',stopButton);
            launch(); checkSource();
        } catch (err) {
            if (terminal) return;
            ui.set(err.message === 'wrong_tab' ? 'That source was not this EZiL OS tab. No footage was saved.'
                : 'This EZiL OS tab was not shared. No footage was saved.', [
                ['Choose this tab', choose], ['Open without sharing', () => stop()],
            ]);
        }
    }
    function confirmed(receipt) {
        if (terminal || beginPending) return;
        const opened = Date.parse(receipt?.openedAt), start = Date.parse(receipt?.windowStartedAt), end = Date.parse(receipt?.deadlineAt);
        if (!available() || receipt?.attemptId !== attemptId || typeof receipt.proof !== 'string'
            || !/^[A-Za-z0-9_-]{48,1700}$/.test(receipt.proof) || !Number.isFinite(opened) || !Number.isFinite(start) || !Number.isFinite(end)
            || opened < start || opened >= end || end-start > 3600000 || end <= Date.now()) {
            stop('stopped','The assigned repository open could not be verified. No footage was saved.');
            return;
        }
        win.clearTimeout(deadlineTimer);
        deadlineTimer = win.setTimeout(() => stop('timeout'), end-Date.now());
        transport = createAssignmentVideoTransport({attemptId,repoOpenProof:receipt.proof,consentVersion:3,
            onStop: (reason, effectiveAt) => stop(['submitted','timeout'].includes(reason) ? reason : 'stopped',
                reason === 'unavailable' ? 'Assignment recording was interrupted while status was unavailable.' : undefined, effectiveAt)});
        beginPending = (async () => {
            grant = await transport.begin();
            if (Date.parse(grant.startedAt) !== start || Date.parse(grant.deadlineAt) !== end || !available())
                throw new Error('window_changed');
            recorder = await encodeTabSegments({win,stream:source.stream,matches:available,windowStart:start,deadline:end,
                upload: async (part) => {
                    clipCount = Math.max(clipCount,part.sequence+1);
                    return transport.upload(part);
                }, cutoff: async () => {
                    const status = await transport.status();
                    return status.stopRequestedAt || null;
                }, onFault: () => stop('stopped','Recording was interrupted. The report may contain a gap.'),
                onFrame: () => {
                    closeClickCues = showShellClicks(win);
                    ui.set('Recording this EZiL OS tab · 1 frame per second', stopButton);
                }});
        })();
        beginPending.catch(() => stop('stopped','Assignment recording could not continue. The report may contain a gap.'));
    }
    current = {repo, actor: () => owner, stop, confirmed, terminal: () => terminal};
    ui.set('Checking this assignment’s recording eligibility…');
    checkAssignmentVideoEligibility(attemptId).then(eligibility => {
        if (terminal) return;
        const end = Date.parse(eligibility.deadlineAt);
        if (!sameOwner() || eligibility.status !== 'eligible' || eligibility.attemptId !== attemptId
            || eligibility.repositoryUrl !== repo || !Number.isFinite(end) || end <= Date.now()) {
            stop('stopped','Recording is unavailable for this assignment.'); return;
        }
        deadlineTimer = win.setTimeout(() => stop('timeout'), Math.min(3600000,end-Date.now()));
        try { picker = currentTabPicker(win); chooser(); }
        catch { stop('stopped','This browser cannot verify and share this EZiL OS tab. No footage was saved.'); }
    }).catch(() => stop('stopped','Recording eligibility could not be verified. No footage was saved.'));
}

export function confirmAssignmentFolder(project, receipt) {
    if (current && !current.terminal() && current.repo === project?.repoUrl) current.confirmed(receipt);
}
