/** One serialized renewal loop per viewer; short-lived credentials stay server-side. */
export function createRelayRenewal({ state, refresh, onState, now = Date.now,
    schedule = setTimeout, cancel = clearTimeout }) {
    let current = state, timer, frame_timer, confirm_frame, flight, stopped = false, failures = 0;
    const arm = () => {
        cancel(timer);
        if (stopped || !current) return;
        timer = schedule(() => renew(), Math.max(1000, current.expiresAt - now() - 60000));
    };
    const renew = () => {
        if (stopped || !current) return Promise.resolve();
        if (flight) return flight;
        cancel(timer); onState('reconnecting');
        const runtime = current.runtimeId;
        flight = Promise.resolve().then(() => refresh(runtime)).then(async result => {
            if (stopped) return;
            if (!result?.ok || result.runtimeId !== runtime || !Number.isSafeInteger(result.expiresAt)
                || result.expiresAt <= now() + 60000) throw new Error('relay_refresh_failed');
            current = { runtimeId: runtime, expiresAt: result.expiresAt };
            // The API confirms configuration. This viewer must independently
            // confirm decoded pixels after that result before renewal succeeds.
            onState('confirming');
            await new Promise((resolve, reject) => {
                confirm_frame = resolve;
                frame_timer = schedule(() => reject(new Error('relay_frames_timeout')), 20000);
            });
            if (stopped) return;
            failures = 0; onState('connected'); arm();
        }).catch(() => {
            if (stopped) return;
            failures++;
            if (failures >= 3 || current.expiresAt <= now()) { onState('error'); return; }
            onState('reconnecting'); timer = schedule(() => renew(), Math.min(10000, 2000 * failures));
        }).finally(() => { cancel(frame_timer); confirm_frame = null; flight = null; });
        return flight;
    };
    arm();
    return {
        resume() { if (!stopped && current?.expiresAt <= now() + 60000) return renew(); arm(); return Promise.resolve(); },
        reconnect: renew,
        viewerLive() { confirm_frame?.(); },
        stop() { stopped = true; cancel(timer); cancel(frame_timer); confirm_frame?.(); },
    };
}
