/**
 * The assignment's remaining time, as the server reports it. The browser never starts, pauses, extends or restarts this
 * clock on its own, and neither does a local checkout, resize or progress event: `sync` takes the report of the shell
 * route's `clock` action (`{serverNow, startedAt, deadlineAt, pausedAt, pauseReason, remainingMs, revision}`, every
 * field nullable until the clock starts) and `remaining` counts down from its deadline against the offset between the
 * server's clock and this one. Reports are ordered by `revision`; the begin / confirm / status answers carry none and
 * only seed the clock until the first revisioned report arrives.
 *
 * The one place that reads a report is `clockOf`. A paused clock (`pausedAt` or `pauseReason`) shows `remainingMs`.
 * `status:'paused'` alone is NOT a system pause: Universe uses it for a phase that was checkpointed between shares.
 */
const finite = value => Number.isFinite(value) ? value : null;
const parse = value => typeof value === 'string' ? finite(Date.parse(value)) : null;

/**
 * The clock a report describes, or null when it carries none: the fields are nullable until the server starts the clock
 * (a share before its first usable editor has no deadline). A paused clock may carry `remainingMs` and no deadline.
 * `revision` orders reports; the begin / confirm / status answers carry none.
 */
export function clockOf(report) {
    if (!report || typeof report !== 'object') return null;
    const deadline = parse(report.deadlineAt);
    const serverNow = parse(report.serverNow);
    const pausedAt = parse(report.pausedAt);
    const paused = pausedAt !== null || (typeof report.pauseReason === 'string' && report.pauseReason !== '');
    const remainingMs = finite(report.remainingMs);
    if (deadline === null && !(paused && remainingMs !== null)) return null;
    const revision = Number.isSafeInteger(report.revision) ? report.revision : null;
    return {deadline, serverNow, paused, revision, startedAt: parse(report.startedAt),
        pauseReason: paused && typeof report.pauseReason === 'string' && report.pauseReason ? report.pauseReason : null,
        frozenMs: paused ? (remainingMs !== null ? remainingMs : pausedAt !== null && deadline !== null ? deadline - pausedAt : null) : null};
}

export function createCountdown({now = Date.now} = {}) {
    let deadline = null, offset = 0, frozen = null, started = false, pausedBy = null, latest = null, startedAt = null;
    return {
        /**
         * Take a server report. Returns true when it was applied: it carried a clock and was not older than the newest
         * revision seen. Once a revisioned report (the `clock` action) has been seen, reports without a revision (begin,
         * confirm, status) no longer move the clock. Never moves a started clock back to "not started".
         */
        sync(report, receivedAt = now()) {
            const revision = Number.isSafeInteger(report?.revision) ? report.revision : null;
            if (revision === null ? latest !== null : latest !== null && revision < latest) return false;
            // A revisioned report that carries no clock yet still orders what follows it.
            if (revision !== null) latest = revision;
            const clock = clockOf(report);
            if (!clock) return false;
            if (clock.serverNow !== null) offset = clock.serverNow - receivedAt;
            deadline = clock.deadline;
            startedAt = clock.startedAt ?? startedAt;
            started = true;
            if (clock.paused) {
                frozen = clock.frozenMs ?? Math.max(0, (deadline ?? receivedAt + offset) - (receivedAt + offset));
                pausedBy = clock.pauseReason ?? 'system';
            } else { frozen = null; pausedBy = null; }
            return true;
        },
        revision: () => latest,
        /** The server's start of the clock (server time), or null; with the deadline it bounds how far the timeline may run. */
        startedAtMs: () => startedAt,
        started: () => started,
        /** The deadline in this browser's wall time (for local timers); null before the clock starts. */
        deadlineAt: () => deadline === null ? null : deadline - offset,
        /** The deadline in the server's time, which segment times and cut-offs are measured in; null before the clock starts. */
        serverDeadlineAt: () => deadline,
        /** Milliseconds left, or null before the clock has started. */
        remaining(at = now()) {
            if (frozen !== null) return Math.max(0, frozen);
            if (deadline === null) return null;
            return Math.max(0, deadline - (at + offset));
        },
        /** `waiting` (no clock yet), `running`, `paused` (the server stopped it) or `ended`. */
        state(at = now()) {
            if (frozen !== null) return 'paused';
            if (deadline === null) return 'waiting';
            return this.remaining(at) === 0 ? 'ended' : 'running';
        },
        pauseReason: () => pausedBy,
    };
}

/** `m:ss` under an hour, `h:mm:ss` from it. Rounds up, so `0:00` means the time is over. */
export function formatRemaining(ms) {
    if (!Number.isFinite(ms)) return '--:--';
    const total = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(total / 3600), m = Math.floor(total % 3600 / 60), s = total % 60;
    const two = n => String(n).padStart(2, '0');
    return h ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

/** Minutes at which a screen reader is told how much time is left (the timer itself is never announced per second). */
export const ANNOUNCE_MINUTES = [1, 5, 10, 30];

/**
 * The smallest threshold `ms` is inside, with the real time left spoken (a share resumed with 8 minutes left says 8, not
 * 10), or null when that threshold was already announced. `lastMinutes` is the threshold announced last.
 */
export function announcement(ms, lastMinutes) {
    if (!Number.isFinite(ms) || ms <= 0) return null;
    const minutes = ANNOUNCE_MINUTES.find(m => ms <= m * 60000);
    if (minutes === undefined || (Number.isFinite(lastMinutes) && lastMinutes <= minutes)) return null;
    return {minutes, text: 'Assignment time: ' + spokenRemaining(ms) + '.'};
}

/** The spoken form for a remaining time (the timer's accessible text, refreshed only on a state change or threshold). */
export function spokenRemaining(ms) {
    if (!Number.isFinite(ms)) return 'Time starts when your editor opens';
    const total = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(total / 3600), m = Math.floor(total % 3600 / 60), s = total % 60;
    const parts = [];
    if (h) parts.push(`${h} hour${h === 1 ? '' : 's'}`);
    if (m) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
    if (!h && !m || (!h && m < 2 && s)) parts.push(`${s} second${s === 1 ? '' : 's'}`);
    return parts.join(' ') + ' remaining';
}
