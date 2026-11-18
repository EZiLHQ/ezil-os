// EZiL-authored. Renew Git capabilities without reloading the editor or starting a computer.
export const GIT_ACCESS_RENEW_MS = 120_000;
const COPY = {
    IDENTITY_REFRESH_REQUIRED: 'Git needs your EZiL sign-in again. Reopen this repository to reconnect.',
    UNAUTHORIZED: 'Git needs your EZiL sign-in again. Reopen this repository to reconnect.',
    repo_not_found: 'Your EZiL account no longer has access to this repository.',
};

export function createGitAccessRenewal ({ target, eligible, notice, fetch: request = globalThis.fetch,
    now = Date.now, interval = setInterval, clear = clearInterval }) {
    let disposed = false;
    let controller = null;
    let next = now() + GIT_ACCESS_RENEW_MS;
    let generation = 0;
    const reset = () => {
        generation += 1;
        controller?.abort(); controller = null;
        next = now() + GIT_ACCESS_RENEW_MS;
        notice(null);
    };
    const tick = async () => {
        if ( disposed || controller || now() < next || ! eligible() ) return;
        const current = target();
        if ( ! current ) return;
        const own = new AbortController();
        controller = own;
        const version = generation;
        next = now() + GIT_ACCESS_RENEW_MS;
        const deadline = setTimeout(() => own.abort(), 70_000);
        try {
            const response = await request('/api/shell/code-git-access', {
                method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: own.signal,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ computerId: current.computerId, repository: { url: current.repoUrl } }),
            });
            const data = await response.json();
            if ( disposed || version !== generation || own.signal.aborted ) return;
            if ( response.ok && data?.ok === true && (data.scope === 'read' || data.scope === 'write') ) {
                notice(data.scope === 'read' ? 'You can commit locally. This repository is read-only for your EZiL account.' : null);
            } else {
                notice(COPY[data?.error?.code] || 'Git access could not be renewed. Reopen this repository to reconnect.');
            }
        } catch {
            if ( ! disposed && version === generation ) notice('Git access could not be renewed. Reopen this repository to reconnect.');
        } finally {
            clearTimeout(deadline);
            if ( controller === own ) controller = null;
        }
    };
    const timer = interval(() => { void tick(); }, 15_000);
    return { tick, reset, dispose () { if ( disposed ) return; disposed = true; reset(); clear(timer); } };
}
