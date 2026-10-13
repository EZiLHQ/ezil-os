const POLL_MS = 60_000;
// No observation yet in this window. Unlike null (healthy), so the first real
// result, healthy included, is always reported once.
const UNKNOWN = Symbol('unknown');
const PAUSED_REASONS = new Set([null, 'too_large', 'stale', 'not_restored']);

function noticeText ({ savingPaused, pausedLayer, pausedReason }) {
    if ( ! savingPaused || pausedReason === null ) return null;
    if ( pausedReason === 'stale' || pausedReason === 'not_restored' ) {
        return 'Saving has stopped on this computer. Reopen it to resume saving.';
    }
    if ( pausedLayer === 'system' ) {
        return "Saving is paused: your home folder is over the 512 MB limit. Recent changes outside your workspace won't be kept.";
    }
    if ( pausedLayer === 'workspace' ) {
        return 'Saving is paused: your workspace is over the 512 MB limit.';
    }
    return null;
}

/** One serialized watcher per desktop window. start(computerId) is idempotent;
 * pause()/resume() gate polling without resetting the 60-second minimum;
 * stop() permanently disposes it, including any result still in flight. */
export function createPersistenceWatcher ({ fetchStatus, emit, render,
    setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
    let timer, flight, computerId, started = false, stopped = false, paused = false;
    let lastPollAt = -Infinity, lastReason = UNKNOWN;

    const arm = () => {
        clearTimer(timer);
        timer = undefined;
        if ( stopped || paused || ! started ) return;
        timer = setTimer(poll, Math.max(0, POLL_MS - (now() - lastPollAt)));
    };
    const poll = () => {
        if ( stopped || paused || ! started ) return Promise.resolve();
        if ( flight ) return flight;
        if ( now() - lastPollAt < POLL_MS ) {
            arm();
            return Promise.resolve();
        }
        clearTimer(timer);
        timer = undefined;
        flight = Promise.resolve().then(() => {
            if ( stopped || paused ) return null;
            lastPollAt = now();
            return fetchStatus(computerId);
        }).then(result => {
            if ( stopped || result?.ok !== true || ! result.status ) return;
            const reason = result.status.pausedReason;
            if ( ! PAUSED_REASONS.has(reason) ) return;
            render(noticeText(result.status));
            // Each window reports its first observation once, `ok` included: a
            // pause reported by an earlier window clears when saving recovered.
            if ( reason === lastReason ) return;
            lastReason = reason;
            emit({ eventClass: 'persistence', source: 'shell', site: 'persist.shell_seen',
                code: reason ?? 'ok', outcome: reason ? 'skipped' : 'ok', computerId });
        }).catch(() => {
            // Status and telemetry failures must never disturb the desktop.
        }).finally(() => {
            flight = null;
            arm();
        });
        return flight;
    };

    return {
        start (id) {
            if ( stopped || started ) return flight ?? Promise.resolve();
            started = true;
            computerId = id;
            return poll();
        },
        pause () {
            paused = true;
            clearTimer(timer);
            timer = undefined;
        },
        resume () {
            paused = false;
            return poll();
        },
        stop () {
            stopped = true;
            clearTimer(timer);
            timer = undefined;
        },
    };
}
