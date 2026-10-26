// This ID is correlation only: the server also requires its per-intent HttpOnly
// proof cookie, verified OS session, matching intent identity and owned computer.
export function documentLaunchIntent(win) {
    try {
        const key = 'ezilProjectLaunchIntent';
        const state = win.history.state;
        if (state && Object.hasOwn(state, key)) return /^[A-Za-z0-9_-]{43}$/.test(state[key]) ? state[key] : undefined;
        const pending = win.sessionStorage.getItem('ezil.project-launch.pending');
        win.sessionStorage.removeItem('ezil.project-launch.pending');
        if (!pending || !/^[A-Za-z0-9_-]{43}$/.test(pending)) return undefined;
        // Preserve each history entry's immutable choice for old-page refresh.
        win.history.replaceState({ ...state, [key]: pending }, '');
        return pending;
    } catch { return undefined; } // no storage/history access: fail closed
}
