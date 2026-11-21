// interview-consent.js — EZiL-authored. Not Puter code.
//
// The pre-boot consent gate (docs/contracts/interview-evidence-v1.md §7.4). code.js calls `interview_consent.gate`
// once at the top of `start_boot` for a `?repo=` git-qa address. It asks the server for interview status and:
//
//   • not a git-qa URL, not an interview, or any refusal  -> RESOLVE immediately so boot continues unchanged (the
//     server is the authority and refuses again if it must). It NEVER blocks a non-interview open.
//   • already started                                      -> start the activity recorder, then resolve.
//   • registered/consented                                 -> show the notice VERBATIM with Accept / Leave. After
//     Accept it shows "Waiting for the interviewer" and polls status every 5 s; only when the interviewer starts the
//     interview does it start recording and resolve. Leave declines and leaves boot blocked.
//
// The notice text is whatever the server returned (it serves the pinned bytes); this file never hard-codes it.

import { interview_activity } from './interview-activity.js';

const GIT_QA = /^https:\/\/git-qa\.ezil\.work\//;

function build_overlay (doc, noticeText) {
    const overlay = doc.createElement('div');
    overlay.className = 'ezil-interview-consent';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483646;display:flex;flex-direction:column;'
        + 'align-items:center;justify-content:center;gap:16px;padding:24px;background:rgba(17,17,17,0.92);color:#fff;overflow:auto;';
    const pre = doc.createElement('pre');
    pre.className = 'ezil-interview-notice';
    pre.textContent = typeof noticeText === 'string' ? noticeText : '';
    pre.style.cssText = 'max-width:720px;white-space:pre-wrap;font:13px/1.5 ui-monospace,monospace;'
        + 'background:#1e1e1e;border:1px solid #333;border-radius:8px;padding:16px;margin:0;';
    const row = doc.createElement('div');
    row.style.cssText = 'display:flex;gap:12px;';
    const accept = doc.createElement('button');
    accept.className = 'ezil-interview-accept';
    accept.textContent = 'Accept';
    const leave = doc.createElement('button');
    leave.className = 'ezil-interview-leave';
    leave.textContent = 'Leave';
    row.append(accept, leave);
    const status = doc.createElement('div');
    status.className = 'ezil-interview-status';
    status.setAttribute('role', 'status');
    overlay.append(pre, row, status);
    (doc.body || doc.documentElement).appendChild(overlay);
    return overlay;
}

export function create_interview_consent ({
    fetchImpl = (...args) => fetch(...args), now = () => Date.now(),
    timer = setTimeout, cancelTimer = clearTimeout,
    win = (typeof window !== 'undefined' ? window : undefined),
    doc = (typeof document !== 'undefined' ? document : undefined),
    activity = interview_activity,
} = {}) {
    void now;
    function gate ({ repoUrl } = {}) {
        return new Promise((resolve) => {
            // Non-interview opens must pay nothing and never block: no fetch, resolve now.
            if ( typeof repoUrl !== 'string' || ! GIT_QA.test(repoUrl) ) { resolve(); return; }

            let settled = false;
            let overlay = null;
            let pollTimer = null;
            const teardown = () => finish();
            if ( win ) win.addEventListener('ezil:teardown', teardown);

            function cleanup () {
                if ( win ) win.removeEventListener('ezil:teardown', teardown);
                if ( pollTimer !== null ) { cancelTimer(pollTimer); pollTimer = null; }
                if ( overlay && overlay.parentNode ) overlay.parentNode.removeChild(overlay);
                overlay = null;
            }
            function finish () { if ( ! settled ) { settled = true; cleanup(); resolve(); } }

            async function post (action, extra) {
                try {
                    const res = await fetchImpl('/api/shell/interview-consent', {
                        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ action, ...extra }), signal: AbortSignal.timeout(10000),
                    });
                    let body = null;
                    try { body = await res.json(); } catch { /* non-JSON body */ }
                    return { status: res.status, body };
                } catch { return { status: 0, body: null }; }
            }

            function begin_activity (interviewId) { try { activity.begin({ interviewId }); } catch { /* recorder is best-effort */ } }

            function wait_for_start (interviewId, statusEl) {
                if ( statusEl ) statusEl.textContent = 'Waiting for the interviewer…';
                const tick = async () => {
                    pollTimer = null;
                    const { status, body } = await post('status', { repository: { url: repoUrl } });
                    const iv = status === 200 && body ? body.interview : undefined;
                    if ( iv && iv.state === 'started' ) { begin_activity(interviewId); finish(); return; }
                    if ( status === 200 && body && body.interview === null ) { finish(); return; } // vanished: let boot continue
                    if ( ! settled ) pollTimer = timer(tick, 5000);
                };
                pollTimer = timer(tick, 5000);
            }

            function show_notice (iv) {
                if ( ! doc ) { finish(); return; } // no DOM to show a notice in: defer to the server authority
                overlay = build_overlay(doc, iv.notice && iv.notice.text);
                const acceptBtn = overlay.querySelector('.ezil-interview-accept');
                const leaveBtn = overlay.querySelector('.ezil-interview-leave');
                const statusEl = overlay.querySelector('.ezil-interview-status');
                if ( iv.state === 'consented' ) {
                    acceptBtn.style.display = 'none'; leaveBtn.style.display = 'none';
                    wait_for_start(iv.interviewId, statusEl);
                    return;
                }
                acceptBtn.addEventListener('click', async () => {
                    acceptBtn.disabled = true; leaveBtn.disabled = true;
                    const { status, body } = await post('accept', {
                        interviewId: iv.interviewId, noticeVersion: 1, noticeSha256: iv.notice && iv.notice.sha256,
                    });
                    if ( status === 202 || ( status === 200 && body && body.accepted ) ) {
                        acceptBtn.style.display = 'none'; leaveBtn.style.display = 'none';
                        wait_for_start(iv.interviewId, statusEl);
                    } else if ( status === 409 && body && body.error && body.error.code === 'notice_mismatch' ) {
                        statusEl.textContent = 'The recording notice changed. Reload to read it again.';
                        acceptBtn.disabled = false; leaveBtn.disabled = false;
                    } else {
                        finish(); // unexpected refusal: let the server be the authority on the open
                    }
                });
                leaveBtn.addEventListener('click', () => {
                    // Declined: remove the notice and leave boot blocked — the candidate chose not to enter.
                    if ( overlay && overlay.parentNode ) overlay.parentNode.removeChild(overlay);
                    overlay = null;
                });
            }

            (async () => {
                const { status, body } = await post('status', { repository: { url: repoUrl } });
                const iv = status === 200 && body ? body.interview : undefined;
                if ( ! iv ) { finish(); return; } // interview:null, or any refusal: continue boot unchanged
                if ( iv.state === 'started' ) { begin_activity(iv.interviewId); finish(); return; }
                if ( iv.state === 'finished' ) { finish(); return; } // server refuses the open with interview_finished
                show_notice(iv); // registered or consented
            })();
        });
    }
    return { gate };
}

export const interview_consent = create_interview_consent();
