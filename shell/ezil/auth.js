// auth.js — EZiL-authored. Not Puter code.
//
// The shell's one way to end the session. Settings → Account calls it; nothing
// else in the shell signs anyone out.

import telemetry from './telemetry.js';

/**
 * Ends the session through the app's `POST /auth/signout`, which answers with
 * a 303 to `/login`.
 *
 * 🔴 A REAL FORM SUBMISSION, not `fetch()`: the server's redirect has to become
 * a document load so the browser leaves `/os` (a fetch would follow the 303
 * invisibly and leave the desktop on screen with no session behind it). The
 * form is same-origin, which is what the app's cross-origin write guard
 * (`app/src/utils/request-origin.ts`) requires of any POST.
 *
 * The session ends while this document is still unloading, so the pagehide
 * telemetry flush would be refused. The buffer is sent first, with the session
 * still attached.
 */
export function signOut () {
    telemetry.flushNow();
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/auth/signout';
    form.style.display = 'none';
    document.body.appendChild(form);
    form.submit();
}

export default { signOut };
