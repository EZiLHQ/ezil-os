import {announcement, formatRemaining, spokenRemaining} from './countdown.js';

/** What the control says for each state of the share. `stop`: whether Stop is offered (only while a share is live). */
export const STATES = {
    sharing: {text: 'Sharing', stop: true},
    recording: {text: 'Recording', stop: true},
    interrupted: {text: 'Recording paused', stop: true},
    // The server's own pause (its clock is stopped and capture is gated); nothing in the browser can set it.
    paused: {text: 'Paused for system upgrade', stop: true},
    stopped: {text: 'Sharing stopped', stop: false},
    // No share is live (after a refresh, before sharing again): the server's clock is still the time shown.
    idle: {text: 'Not recording', stop: false},
    ended: {text: 'Time ended', stop: false},
};

export const STOP_LABEL = 'Stop sharing this assignment tab';

/**
 * One compact control at the top right of the OS tab: a red dot, the authoritative time left, the state in words, and
 * Stop. The timer is `role="timer"` with `aria-live="off"`: a screen reader reads it on demand, never once a second.
 * What it does announce, through a separate polite status, is a change of state and the 30/10/5/1-minute thresholds.
 * It stays on screen after a stop or a pause, because the server's clock does too. Timers are the page's own (`timers`),
 * never the window object's, so a window without them cannot break it.
 */
export function createStatusControl({win, countdown, onStop, now = Date.now, timers = globalThis}) {
    const doc = win.document;
    const make = (tag, className) => { const el = doc.createElement(tag); el.className = className; return el; };
    const root = make('div', 'ezil-assignment-recording-status');
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'Assignment recording');
    const dot = make('span', 'ezil-assignment-recording-dot');
    dot.setAttribute('aria-hidden', 'true');
    const time = make('span', 'ezil-assignment-recording-time');
    time.setAttribute('role', 'timer');
    time.setAttribute('aria-live', 'off');
    const label = make('span', 'ezil-assignment-recording-state');
    const stop = make('button', 'ezil-assignment-recording-stop');
    stop.type = 'button';
    stop.textContent = 'Stop';
    stop.setAttribute('aria-label', STOP_LABEL);
    stop.title = STOP_LABEL;
    stop.onclick = event => { if (event.isTrusted) onStop(); };
    const speech = make('span', 'ezil-assignment-recording-sr');
    speech.setAttribute('role', 'status');
    speech.setAttribute('aria-live', 'polite');
    root.append(dot, time, label, stop, speech);
    doc.body.append(root);

    let state = null, timer, spoken = null, lastMinutes = null, removed = false;

    /** Redraw. `changed`: the state's words are said too, in the same message as a threshold that falls on the same draw. */
    function render(changed = false) {
        if (removed) return;
        const said = [];
        const left = countdown.remaining(now());
        const clock = countdown.state(now());
        // The clock outranks the share: the time being over is shown whatever the capture is doing.
        const shown = clock === 'ended' && state !== 'stopped' ? 'ended' : state;
        const text = formatRemaining(left);
        if (time.textContent !== text) time.textContent = text;
        const words = spokenRemaining(left) + (clock === 'paused' ? ', time paused' : '');
        time.setAttribute('aria-label', words);
        if (shown && STATES[shown]) {
            if (label.textContent !== STATES[shown].text) { label.textContent = STATES[shown].text; label.title = STATES[shown].text; }
            root.setAttribute('data-state', shown);
            stop.hidden = !STATES[shown].stop;
            if (changed) said.push(STATES[shown].text + '.');
        }
        const heard = announcement(left, lastMinutes);
        if (heard && clock === 'running') { lastMinutes = heard.minutes; said.push(heard.text); }
        if (said.length) speech.textContent = said.join(' ');
        schedule(left);
    }
    function schedule(left) {
        timers.clearTimeout(timer);
        if (removed) return;
        // The next change of the displayed second, never a fixed poll: the clock cannot lag a visible second.
        timer = timers.setTimeout(() => render(), Number.isFinite(left) && left > 0 ? left % 1000 + 25 : 1000);
    }
    return {
        root, stop,
        state: () => state,
        /** Change the share's state; a screen reader hears the new words once. */
        set(next) {
            if (removed || !STATES[next]) return;
            const changed = next !== state;
            state = next;
            render(changed);
        },
            /** The server's clock changed (a report arrived): redraw now; a threshold is announced again only if time went back up past it. */
        sync() {
            const left = countdown.remaining(now());
            if (lastMinutes !== null && left > lastMinutes * 60000) lastMinutes = null;
            render();
        },
        remove() { removed = true; timers.clearTimeout(timer); root.remove(); },
    };
}
