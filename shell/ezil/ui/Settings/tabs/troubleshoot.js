// tabs/troubleshoot.js — EZiL-authored. Not Puter code.
//
// A way out when the desktop is stuck: restart its container without losing
// the computer or its workspace. Per the owner's brief:
//
//   - Reachable while the desktop is full-bleed. That is exactly the moment a
//     user is stuck — `enter_fullpage_mode` hides the taskbar, and Settings'
//     own two reachability paths (the pinned taskbar icon, and the
//     control-drawer button `../drawer-action.js` injects into a full-bleed
//     window) already solve this for the WHOLE Settings window, this tab
//     included. Nothing new was needed here — see `../index.js`'s header for
//     "Guarantee #1".
//   - Honest states: restarting / restarted / failed-with-reason. Never claim
//     success this tab did not observe.
//   - Confirm before acting, and say what it does and does not destroy.
//   - Feature-detect the restart route and degrade honestly if it is absent.
//
// 🔴 FEATURE-DETECTED, not assumed. As of this writing there is no restart
// route under `app/src/app/api/shell/*` and no `restart` key in
// `SHELL_API_ROUTES` (`app/src/server/shell/boot-payload.ts`, not owned by
// this task — see `session.js`'s `restartEndpoint()` for the full account).
// Until a sibling task publishes it, `render()`'s `! supported` branch draws
// a disabled button with the honest reason INSTEAD OF throwing or guessing a
// URL. Once the route exists, this tab picks it up on its own — no code
// change needed here, because the check reads the live boot payload every
// render, not a value cached at import time.
//
// 🔴 HONESTY CONTRACT. A restart is reported "restarted" ONLY on a 2xx with
// `data.ok === true` (`session.restartDesktop`'s own contract). Everything
// else — including "the request never landed" — renders as `failed`, with
// the real reason, mirroring the rule `session.openDesktop`/`boot-phases.js`
// already hold the rest of this shell to.
import UIAlert from '../../../../src/UI/UIAlert.js';
import session from '../../../session.js';
import telemetry from '../../../telemetry.js';

const PHASE = 'ezil-os:settings/troubleshoot';

const TROUBLESHOOT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
    + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>'
    + '<circle cx="12" cy="12" r="4"/></svg>';

/** Same construction/reasoning as `tabs/computers.js`'s `ALERT_WARNING_ICON`
 * — neither `UIAlert` icon key this fork kept resolves without one. */
const ALERT_WARNING_ICON = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#e0a030" stroke-width="2">'
    + '<path d="M12 3 2 20h20L12 3Z" stroke-linejoin="round"/><path d="M12 10v4M12 17h.01" stroke-linecap="round"/></svg>',
);

const DESKTOP_SELECTOR = '.window[data-app="desktop"]';

/**
 * The computer id the open desktop window streams, or `null` if none is
 * open. Same technique as `tabs/computers.js`'s `openDesktopComputerId()`
 * (read the DOM, not remembered module state — a window is created and
 * destroyed with the thing it describes and cannot go stale behind a
 * rebuild), kept local here rather than imported: importing a sibling tab's
 * private helper across files for four lines was not worth the coupling.
 */
function openDesktopComputerId () {
    const el = document.querySelector(DESKTOP_SELECTOR);
    return el ? el.getAttribute('data-ezil-computer-id') : null;
}

// ── module state ─────────────────────────────────────────────────────────
// A fresh Settings window re-runs `init` from scratch (single_instance means
// there is only ever one) — see `tabs/computers.js`'s header for why module
// state is safe under that lifetime.
let status = 'idle'; // 'idle' | 'restarting' | 'restarted' | 'failed'
let failReason = '';

function reasonCopy (errorCode) {
    switch ( errorCode ) {
        case 'unsupported': return "This deployment hasn't turned on desktop restarts yet.";
        case 'timeout': return 'The request took too long. Your desktop may still be fine — check back in a moment.';
        case 'fetch_failed': return 'Could not reach the server. Check your connection and try again.';
        case 'unauthorized': return 'Your session expired — sign in again.';
        case 'bad_request': return 'Open a desktop first, then come back here.';
        default: return 'Something went wrong. Please try again.';
    }
}

function render ($win) {
    const $body = $win.find('[data-role="troubleshoot-body"]');
    if ( $body.length === 0 ) return; // pane not mounted (wrong tab active) — nothing to draw yet

    const computerId = openDesktopComputerId();
    const supported = session.restartEndpoint() !== null;

    let statusHtml = '';
    if ( status === 'restarting' ) {
        statusHtml = '<p class="ezil-settings-muted">Restarting… this can take up to about 22 seconds.</p>';
    } else if ( status === 'restarted' ) {
        statusHtml = '<p class="ezil-settings-muted">Restart requested. Give it a few seconds, then reopen the '
            + 'desktop from the taskbar or Start menu if it does not reconnect on its own.</p>';
    } else if ( status === 'failed' ) {
        statusHtml = `<p class="ezil-settings-error">${html_encode(failReason)}</p>`;
    } else if ( ! supported ) {
        statusHtml = '<p class="ezil-settings-muted">Not available in this deployment yet.</p>';
    } else if ( ! computerId ) {
        statusHtml = '<p class="ezil-settings-muted">Open a desktop first, then come back here.</p>';
    }

    const disabled = status === 'restarting' || ! supported || ! computerId;
    const label = status === 'restarting' ? 'Restarting…' : 'Restart desktop';

    $body.html(`
        <p class="ezil-settings-lead">
            If the desktop is frozen or not responding, restarting its container can help. This
            stops the container and starts a fresh one for the SAME computer — your files in
            storage are not touched, and the computer itself is not deleted.
        </p>
        <button type="button" class="ezil-settings-btn ezil-settings-btn-danger" data-action="restart"
            ${disabled ? 'disabled' : ''}>${html_encode(label)}</button>
        ${statusHtml}
    `);
}

async function confirmRestart () {
    const value = await UIAlert({
        message: '<strong>Restart this desktop?</strong>'
            + '<p>Its container will stop and a fresh one will start for the same computer. Anything '
            + 'unsaved in an open application inside it will be lost. Your workspace in storage, and the '
            + 'computer itself, are not touched.</p>',
        type: 'warning',
        body_icon: ALERT_WARNING_ICON,
        buttons: [
            { label: 'Restart', value: 'confirm', type: 'danger' },
            { label: 'Cancel', value: 'cancel', type: 'secondary' },
        ],
    });
    return value === 'confirm';
}

async function handleRestart ($win) {
    if ( status === 'restarting' ) return;
    const computerId = openDesktopComputerId();
    if ( ! computerId ) return;

    const confirmed = await confirmRestart();
    if ( ! confirmed ) return;

    status = 'restarting';
    render($win);

    const res = await session.restartDesktop(computerId);

    if ( res.ok ) {
        status = 'restarted';
    } else {
        status = 'failed';
        failReason = reasonCopy(res.errorCode);
        console.error(`[${PHASE}] restart failed: ${res.errorCode}`);
        // `unsupported` is a feature-detection result, not an operational
        // failure — nothing went wrong, the route just is not there yet, so
        // it is not worth a telemetry row (see `session.restartEndpoint()`'s
        // header). Everything else is a real `api_failure`, same convention
        // `code.js`/`preview.js`/`desktop-window.js` use for their own mints.
        if ( res.errorCode !== 'unsupported' ) {
            telemetry.capture({
                eventClass: 'api_failure', site: 'ezil-os:settings/troubleshoot#restart', code: res.errorCode,
            });
        }
    }
    render($win);
}

function bind ($win) {
    $win.find('[data-role="troubleshoot-body"]')
        .on('click', '[data-action="restart"]', () => { void handleRestart($win); });
}

export default {
    id: 'troubleshoot',
    label: 'Troubleshoot',
    icon: TROUBLESHOOT_ICON,

    html () {
        return '<div class="ezil-settings-pane-body" data-role="troubleshoot-body"></div>';
    },

    init ($win) {
        status = 'idle';
        failReason = '';
        bind($win);
        render($win);
    },

    onActivate ($win) {
        // Re-render on activation: whether a desktop is open and whether
        // restarting is supported can both have changed since this pane last
        // drew (a window opened/closed, a rehydrate refreshed the payload).
        render($win);
    },
};
