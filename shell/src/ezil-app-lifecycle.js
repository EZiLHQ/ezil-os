// ezil-app-lifecycle.js — EZiL-authored. Not Puter code.
//
// The `window.*` functions the whole-file `UI/UIWindow.js` port calls on paths
// EZiL actually reaches, but which upstream defines in files this fork does
// not carry (`helpers.js`, 3,700 lines; `UIDesktop.js`; `IPC.js`).
//
// ── Why these four and not the other sixteen ────────────────────────────────
// A sweep of every `window.X(...)` call site in `shell/src` against every
// `window.X = ...` assignment found TWENTY undefined targets. Sixteen of them
// (`copy_items`, `move_items`, `delete_item`, `upload_items`, `sort_items`,
// `empty_trash`, `update_trash_icons`, `create_shortcut`, `undo_last_action`,
// `validate_fsentry_name`, `init_upload_using_dialog`, `show_or_hide_files`,
// `mutate_user_preferences`, `copy_clipboard_items`, `move_clipboard_items`,
// `handle401`) sit exclusively on filesystem-explorer paths — item containers,
// file dialogs, `is_dir` context menus, and the two `$.ajax` calls that
// persisted sort order and layout to Puter's backend. There is no filesystem
// and no backend, so those paths cannot execute, and leaving them undefined is
// the CORRECT behaviour: a `ReferenceError` naming the exact function is the
// loudest possible signal that a removed cloud path was reached, which is the
// same contract as `ezil-stubs.js`.
//
// 🔴 The four below are different, and the difference is what makes them
// dangerous: they sit on the OPEN/CLOSE path of an ordinary app window, where
// a throw does not "fail loudly" — it fails INVISIBLY and destructively.
// `$.fn.close` calls `report_app_closed` at UIWindow.js:3697, BEFORE
// `delete_window_element`. A ReferenceError there aborts the close halfway:
// the window stays on screen, its taskbar item stays lit, and it can never be
// closed again. The user sees a dead rectangle and no error. This was found by
// `ezil/boot-test.mjs` closing a real desktop window — it is not theoretical,
// and it is the second instance of exactly this bug (`remove_taskbar_item`,
// UIDesktopFullpage.js, was the first).
//
// The rule this file encodes: a missing global on a DESTRUCTIVE path must be
// defined and honest; a missing global on an ABSENT feature must stay missing
// and loud.

const PHASE = 'ezil-os:lifecycle';

/**
 * Upstream (`helpers.js:3334`) posts an `appClosed` message to the closing
 * app's parent app and to its child apps, so a Puter app that launched another
 * app learns when it exited.
 *
 * EZiL has no app-to-app messaging: `IPC.js` is not ported, no window is ever
 * created with `parent_instance_id`, and the one app in the registry is an
 * iframe of a remote desktop that speaks no such protocol. So there is
 * genuinely nobody to notify, and this is a no-op ON PURPOSE — not a stub
 * standing in for missing work.
 *
 * It exists solely so `$.fn.close` can finish. If a fork ever does gain
 * app-to-app messaging, upstream's implementation is the thing to port here.
 */
window.report_app_closed = function (instance_id, status_code) {
    // Deliberately silent: this fires on EVERY window close, and a console
    // line per close would train people to ignore this channel.
    void instance_id;
    void status_code;
};

/**
 * Upstream asks a child app, over `postMessage`, whether it is willing to
 * close, and aborts the close if it says no.
 *
 * Guarded upstream by `data-appUsesSDK === 'true'`, an attribute nothing in
 * this fork sets — so this should never run. Defined anyway because the guard
 * is one attribute away from being wrong, and the failure mode if it IS wrong
 * is a window that cannot be closed. Answering "yes, proceed" is not inventing
 * a success: there is no SDK-speaking app to object, so proceeding is the only
 * truthful answer. It says so out loud, because reaching here at all means an
 * assumption broke.
 */
window.sendWindowWillCloseMsg = async function (iframe) {
    console.warn(`[${PHASE}] sendWindowWillCloseMsg reached, but this fork has no app SDK`
        + ' (IPC.js is not ported); allowing the close.', iframe);
    return { msg: true };
};

/**
 * Upstream `helpers.js`. Three lines, and `UIAlert` calls it on its very first
 * statement to detect the `UIAlert('some message')` shorthand — so an alert
 * raised with a plain string (the most likely way anything calls it) throws
 * before it can render. An error dialog that crashes instead of appearing is
 * the worst possible time for this bug.
 */
window.isString = function (v) {
    return typeof v === 'string' || v instanceof String;
};

export default {
    report_app_closed: window.report_app_closed,
    sendWindowWillCloseMsg: window.sendWindowWillCloseMsg,
    isString: window.isString,
};
