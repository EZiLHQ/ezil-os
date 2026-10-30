import trpc from './trpc.js';
import { openSessionEndSheet } from './billing-sheets.js';

/** Host integration: emit only after a confirmed session_max stop, never on a clock tick. */
export function watchBillingSessionEnd ({ win = window, client = trpc } = {}) {
    let stopped = false;
    let pending = false;
    let handle = null;
    const ended = async event => {
        if ( stopped || pending || handle || event.detail?.reason !== 'session_max' ) return;
        pending = true;
        try {
            const result = await client.query('billing.summary');
            if ( stopped || ! result?.ok || result.data?.version !== 3 ) return;
            handle = openSessionEndSheet({
                container: win.document.body, summary: result.data, reason: 'session_max', trpc: client,
                onClose: () => { handle = null; },
                onContinue: next => { handle = next; },
            });
        } catch { /* A missing summary cannot establish which plan to offer. A later event can retry. */ }
        finally { pending = false; }
    };
    const stop = () => {
        stopped = true;
        win.removeEventListener('ezil:session-ended', ended);
        win.removeEventListener('ezil:teardown', stop);
        handle?.close();
        handle = null;
    };
    win.addEventListener('ezil:session-ended', ended);
    win.addEventListener('ezil:teardown', stop);
    return stop;
}
