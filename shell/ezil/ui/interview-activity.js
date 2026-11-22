// interview-activity.js — EZiL-authored. Not Puter code.
//
// The interview activity recorder (docs/contracts/interview-evidence-v1.md §7.4). Started for a STARTED interview by
// interview-consent.js; it POSTs client-reported evidence to `/api/shell/interview-events` in batches of at most 20
// within at most 5 s, and STOPS FOR GOOD on a 404 (the server is the authority — finished, or not the candidate).
//
// What it records, and nothing else: tab visibility, window focus, which EZiL OS app is focused, how long since Code
// was last visible AND focused (a bucket, never a timestamp), a 60 s heartbeat, and one agent.turn_end per validated
// `ezil.inference.v1` trace handed over from ai-traces.js. NO keystrokes, NO URLs, NO file or prompt content — the
// turn_end carries only the trace's tool-call COUNTS. Presence is `visible && focused` (the same signal
// `activity-heartbeat.js` uses), because the cross-origin editor frame makes real input unobservable from here.

const APP_RE = /^(?:unknown|[a-z0-9][a-z0-9._-]{0,63})$/;

/** Time since Code was last visible+focused -> bucket (contract §7.4, vectors.presenceIdleBuckets). */
export function idle_bucket (ms) {
    if ( ! ( ms >= 15000 ) ) return '<15s'; // includes NaN/negative (present now)
    if ( ms < 60000 ) return '15-60s';
    if ( ms < 300000 ) return '1-5m';
    return '>5m';
}

export function create_interview_activity ({
    fetchImpl = (...args) => fetch(...args), now = () => Date.now(),
    timer = setTimeout, cancelTimer = clearTimeout,
    win = (typeof window !== 'undefined' ? window : undefined),
} = {}) {
    let interviewId = null;
    let begun = false;
    let stopped = false;
    let sending = false;
    const queue = [];
    let flushTimer = null;
    let heartbeatTimer = null;
    let lastPresenceAt = 0;
    let lastTab = null, lastFocused = null, lastApp = null, lastBucket = null;
    let onFocus = null, onTrace = null, onTeardown = null;

    function stop () {
        stopped = true;
        queue.length = 0;
        if ( flushTimer !== null ) { cancelTimer(flushTimer); flushTimer = null; }
        if ( heartbeatTimer !== null ) { cancelTimer(heartbeatTimer); heartbeatTimer = null; }
        if ( win ) {
            if ( onFocus ) win.removeEventListener('ezil:window-focus', onFocus);
            if ( onTrace ) win.removeEventListener('ezil:interview-ai-trace', onTrace);
            if ( onTeardown ) win.removeEventListener('ezil:teardown', onTeardown);
        }
        onFocus = onTrace = onTeardown = null;
    }

    function schedule () {
        if ( flushTimer === null && queue.length ) flushTimer = timer(() => { flushTimer = null; void flush(); }, 5000);
    }

    function enqueue (type, data) {
        if ( stopped || ! begun ) return;
        queue.push({ type, clientAt: new Date(now()).toISOString(), data });
        if ( queue.length >= 20 ) void flush(); else schedule();
    }

    async function flush () {
        if ( stopped || sending || ! queue.length || ! interviewId ) return;
        sending = true;
        const events = queue.splice(0, 20);
        try {
            const res = await fetchImpl('/api/shell/interview-events', {
                method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ interviewId, events }), signal: AbortSignal.timeout(5000), keepalive: true,
            });
            // 404 is terminal: the interview finished, or this is no longer the candidate. Never retry, never requeue.
            if ( res && res.status === 404 ) { stop(); return; }
        } catch { /* Network failure: drop this batch; a gap means unknown, never a retry storm. */ }
        finally { sending = false; if ( ! stopped ) schedule(); }
    }

    /** Re-derive the presence-idle bucket from the stored last-present clock, emitting only on a bucket change. */
    function refresh_idle () {
        const bucket = idle_bucket(now() - lastPresenceAt);
        if ( bucket !== lastBucket ) { lastBucket = bucket; enqueue('presence.idle', { bucket }); }
    }

    /** The presence-block hook in code.js feeds this on every sample: visible = visibilityState, focused = hasFocus(). */
    function sample ({ visible, focused } = {}) {
        if ( stopped || ! begun ) return;
        if ( visible === true && focused === true ) lastPresenceAt = now();
        const tab = visible === true ? 'visible' : 'hidden';
        if ( tab !== lastTab ) { lastTab = tab; enqueue('tab.visibility', { state: tab }); }
        const foc = focused === true;
        if ( foc !== lastFocused ) { lastFocused = foc; enqueue('window.focus', { focused: foc }); }
        refresh_idle();
    }

    /** `ezil:window-focus` carries the focused window element; its `data-app` is the registry id (else `unknown`). */
    function note_app_focus (el) {
        const id = el && typeof el.getAttribute === 'function' ? el.getAttribute('data-app') : null;
        const app = typeof id === 'string' && APP_RE.test(id) ? id : 'unknown';
        if ( app !== lastApp ) { lastApp = app; enqueue('app.focus', { app }); }
    }

    /** One `agent.turn_end` per validated `ezil.inference.v1` trace: COUNTS only, never content. */
    function note_trace (trace) {
        if ( stopped || ! begun || ! trace || typeof trace !== 'object' ) return;
        const r = trace.requested;
        if ( ! r ) return;
        enqueue('agent.turn_end', {
            requestId: trace.requestId,
            gatewayRequestId: trace.gatewayRequestId ?? null,
            modelAlias: trace.modelAlias,
            durationMs: trace.durationMs,
            outcome: trace.outcome,
            toolCalls: { read: r.read, search: r.search, write: r.write, other: r.other },
        });
    }

    /** The 60 s heartbeat tick; also re-derives the idle bucket so a growing idle is recorded while nothing else fires. */
    function heartbeat () {
        if ( stopped || ! begun ) return;
        enqueue('session.heartbeat', {});
        refresh_idle();
    }

    /** Begin recording for a started interview. Emits the initial visibility/focus/app/idle. Idempotent. */
    function begin ({ interviewId: id, app = 'code' } = {}) {
        if ( begun || stopped || ! id ) return;
        begun = true;
        interviewId = id;
        lastPresenceAt = now();
        lastTab = 'visible'; lastFocused = true; lastApp = app; lastBucket = '<15s';
        enqueue('tab.visibility', { state: 'visible' });
        enqueue('window.focus', { focused: true });
        enqueue('app.focus', { app });
        enqueue('presence.idle', { bucket: '<15s' });
        const tick = () => { heartbeat(); if ( ! stopped ) heartbeatTimer = timer(tick, 60000); };
        heartbeatTimer = timer(tick, 60000);
        if ( win ) {
            onFocus = (event) => note_app_focus(event?.detail?.window);
            onTrace = (event) => note_trace(event?.detail);
            onTeardown = () => stop();
            win.addEventListener('ezil:window-focus', onFocus);
            win.addEventListener('ezil:interview-ai-trace', onTrace);
            win.addEventListener('ezil:teardown', onTeardown);
        }
    }

    return {
        begin, sample, note_trace, note_app_focus, heartbeat, flush, stop,
        get started () { return begun && ! stopped; },
    };
}

export const interview_activity = create_interview_activity();
