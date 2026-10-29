// tabs/feedback.js — EZiL-authored. Not Puter code.
//
// Settings → Feedback: the one place to send feedback now that the founder
// moved it off the home screen (2026-10-29: "not on the home screen, but
// rather on the settings page"). It opens the EXISTING form and submission
// path (`../../feedback/feedback.js` → `/api/shell/feedback`); nothing here
// sends a request. Shown only when the boot payload exposes the feedback
// endpoint, the same gate Troubleshoot's "Report a problem" uses — Settings is
// reachable from a full-bleed desktop through the drawer button
// (`../drawer-action.js`), so this entry is too.
import { feedback_enabled, open_feedback_dialog } from '../../feedback/feedback.js';

const FEEDBACK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
    + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 4V6a2 2 0 0 1 2-2Z"/><path d="M7 9h10M7 13h7"/></svg>';

export default {
    id: 'feedback',
    label: 'Feedback',
    icon: FEEDBACK_ICON,

    available () {
        return feedback_enabled();
    },

    html () {
        return `
            <div class="ezil-settings-pane-body" data-role="feedback-body">
                <h3>Send feedback</h3>
                <p class="ezil-settings-lead">Report a bug, share an idea, or tell us anything else about
                    EZiL OS. Nothing is sent until you press Send, and you can preview exactly what
                    will be sent.</p>
                <button type="button" class="ezil-settings-btn" data-action="send-feedback">Send feedback</button>
                <p class="ezil-settings-muted">Reports you have sent are listed under Troubleshoot → Your reports.</p>
            </div>`;
    },

    init ($win) {
        $win.find('[data-role="feedback-body"]').on('click', '[data-action="send-feedback"]', function () {
            // Focus first so closing the form returns focus here (Safari does not focus buttons on click).
            this.focus();
            if ( feedback_enabled() ) open_feedback_dialog({ source: 'settings' });
        });
    },
};
