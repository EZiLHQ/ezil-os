// event-vocabulary.js — EZiL-authored. The CLOSED set of telemetry events a
// feedback report may name (founder 88e642df; re-review 88e642df-feedback-
// closed-projection-v1, 3 Nov 2026). Plain JS on purpose: the shell bundles it
// (`shell/ezil/ui/feedback/diagnostics.js`) and the server imports it
// (`redact.ts`), as `app/src/components/desktop/boot-phases.shell.js` is shared.
//
// FAIL CLOSED. An event whose (eventClass, site) pair is not listed here is
// left out of a report; a code not listed becomes `other`. No free text from a
// console, an event `detail` or an error message is ever part of a report.
// The lists come from the shell's actual `telemetry.capture()` call sites;
// `shell/ezil/ui/feedback/feedback-test.mjs` fails when a literal emitter is
// added there without being listed here. Dynamic codes are listed by family,
// with their source; a value outside a family is `other`, never passed through.

/** Copy of `app/src/server/telemetry/types.ts` EVENT_CLASSES (a drift test pins it). */
export const EVENT_CLASSES = Object.freeze([
    'boot_phase',
    'boot_summary',
    'boot_stall',
    'crash',
    'window_error',
    'api_failure',
    'display_failure',
    'worker_exception',
    'contract_violation',
]);
/** Copy of `app/src/server/telemetry/types.ts` OUTCOMES. */
export const OUTCOMES = Object.freeze(['ok', 'error', 'skipped']);
/** What a code outside `EVENT_CODES` becomes. */
export const UNLISTED_CODE = 'other';
/** Address names (`/app/<name>`) a report may name as its app (`app-link.js` routeName of the registry ids). */
export const APP_NAMES = Object.freeze(['browser', 'code', 'settings', 'app-store', 'preview', 'secure-browser']);
/** `diagnostics.js` browser() and os_family() return only these. */
export const BROWSER_FAMILIES = Object.freeze(['Edge', 'Opera', 'Firefox', 'Chrome', 'Chromium', 'Safari']);
export const OS_FAMILIES = Object.freeze(['iOS', 'Android', 'Windows', 'Chrome OS', 'macOS', 'Linux']);

/** site → the event classes the shell emits it under. */
export const EVENT_SITES = Object.freeze({
    'ezil-os:apps/code#confirmFrame': Object.freeze(['display_failure']),
    'ezil-os:apps/code#drawer': Object.freeze(['window_error']),
    'ezil-os:apps/code#mint': Object.freeze(['api_failure', 'contract_violation']),
    'ezil-os:apps/code#open': Object.freeze(['contract_violation', 'window_error']),
    'ezil-os:apps/code#project': Object.freeze(['api_failure']),
    'ezil-os:apps/desktop#close': Object.freeze(['window_error']),
    'ezil-os:apps/desktop#confirmFrame': Object.freeze(['display_failure']),
    'ezil-os:apps/desktop#drawer': Object.freeze(['window_error']),
    'ezil-os:apps/desktop#keyboard': Object.freeze(['window_error']),
    'ezil-os:apps/desktop#mint': Object.freeze(['api_failure', 'boot_phase']),
    'ezil-os:apps/desktop#open': Object.freeze(['contract_violation', 'window_error']),
    'ezil-os:apps/desktop#picture': Object.freeze(['display_failure']),
    'ezil-os:apps/desktop#reconnect': Object.freeze(['display_failure']),
    'ezil-os:apps/desktop#relay': Object.freeze(['api_failure']),
    'ezil-os:apps/desktop#screen': Object.freeze(['api_failure', 'contract_violation']),
    'ezil-os:apps/desktop#staleRuntime': Object.freeze(['display_failure']),
    'ezil-os:apps/desktop#tti': Object.freeze(['boot_phase']),
    'ezil-os:apps/desktop#watch': Object.freeze(['display_failure']),
    'ezil-os:apps/preview#confirmFrame': Object.freeze(['display_failure']),
    'ezil-os:apps/preview#mint': Object.freeze(['api_failure']),
    'ezil-os:apps/preview#open': Object.freeze(['contract_violation', 'window_error']),
    'ezil-os:apps/registry#launch': Object.freeze(['contract_violation', 'window_error']),
    'ezil-os:boot#give_up': Object.freeze(['boot_stall']),
    'ezil-os:boot#mount': Object.freeze(['window_error']),
    'ezil-os:session#appPreviewUrl': Object.freeze(['contract_violation']),
    'ezil-os:session#codePreviewUrl': Object.freeze(['api_failure', 'contract_violation']),
    'ezil-os:session#openDesktop': Object.freeze(['api_failure', 'contract_violation']),
    'ezil-os:session#previewUrl': Object.freeze(['api_failure', 'contract_violation']),
    'ezil-os:settings#activate': Object.freeze(['window_error']),
    'ezil-os:settings#init': Object.freeze(['window_error']),
    'ezil-os:settings#open': Object.freeze(['window_error']),
    'ezil-os:settings/drawer-action#collapse': Object.freeze(['window_error']),
    'ezil-os:settings/drawer-action#open': Object.freeze(['window_error']),
    'ezil-os:settings/troubleshoot#restart-computer': Object.freeze(['api_failure']),
    'ezil-os:trace#app-store': Object.freeze(['boot_summary']),
    'ezil-os:trace#code': Object.freeze(['boot_summary']),
    'ezil-os:trace#desktop': Object.freeze(['boot_summary']),
    'ezil-os:trace#preview': Object.freeze(['boot_summary']),
    'ezil-os:trace#secure-browser': Object.freeze(['boot_summary']),
    'ezil-os:trace#settings': Object.freeze(['boot_summary']),
    'ezil-os:ui/app-drawer#attach': Object.freeze(['contract_violation']),
    'ezil-os:ui/app-drawer#handler': Object.freeze(['window_error']),
    'ezil-os:window#onerror': Object.freeze(['crash']),
    'ezil-os:window#unhandledrejection': Object.freeze(['crash']),
});

/** Every code a report may name. */
export const EVENT_CODES = new Set([
    // Literal codes at the shell's capture() call sites.
    'app_open_threw',
    'app_preview_url_missing',
    'ask_cap_reached',
    'code_preview_url_missing',
    'collapse_threw',
    'computer_moving',
    'drawer_attach_failed',
    'drawer_handler_threw',
    'frame_not_answering',
    'mount_failed',
    'move_read_cap_reached',
    'no_computer_in_payload',
    'no_watcher',
    'null_window',
    'preview_runtime_stale',
    'preview_url_missing',
    'project_folder_missing',
    'relay_refresh_failed',
    'release_failed',
    'sandbox_starting',
    'screen_size_missing',
    'screen_unrequested_size',
    'settings_handler_threw',
    'tab_activate_threw',
    'tab_init_threw',
    'uiwindow_returned_nothing',
    'unknown_app',
    'viewer_frames_missing',
    // server errorCode literals (app/src `errorCode: '…'`, shell `errorCode === '…'`; troubleshoot reasonCopy)
    'app_preview_unavailable',
    'aws_config_invalid',
    'aws_disabled',
    'aws_enrollment_unavailable',
    'aws_intent_invalid',
    'aws_lifecycle_start_failed',
    'aws_lifecycle_unconfigured',
    'aws_monthly_cap',
    'aws_placement_incomplete',
    'aws_preview_unavailable',
    'billing_allowance_exhausted',
    'billing_aws_monthly_cap',
    'billing_concurrent_limit',
    'billing_fair_use_paused',
    'billing_files_on_aws',
    'billing_no_allowance',
    'billing_unavailable',
    'billing_user_hours_cap',
    'capacity_attempt_expired',
    'capacity_unavailable',
    'code_preview_unavailable',
    'computer_limit_reached',
    'computer_recovering',
    'computer_starting',
    'computer_stopped',
    'computer_stopping',
    'computer_unavailable',
    'connection_refused',
    'desktop_failed',
    'desktop_unreachable',
    'fetch_failed',
    'identity_refresh_required',
    'kill_switch',
    'malformed_reply',
    'preconditions_unmet',
    'provider_not_configured',
    'repo_open_failed',
    'repo_open_unsupported_provider',
    'request_failed',
    'restart_foreign_computer',
    'restart_timeout',
    'restart_unavailable',
    'sandbox_runtime_blocked',
    'sandbox_start_failed',
    'sandbox_starting',
    'timeout',
    'unknown',
    'user_hours_cap',
    'worker_http_error',
    // session.js auto-retry: `auto_retry_${res.errorCode}`
    'auto_retry_app_preview_unavailable',
    'auto_retry_aws_config_invalid',
    'auto_retry_aws_disabled',
    'auto_retry_aws_enrollment_unavailable',
    'auto_retry_aws_intent_invalid',
    'auto_retry_aws_lifecycle_start_failed',
    'auto_retry_aws_lifecycle_unconfigured',
    'auto_retry_aws_monthly_cap',
    'auto_retry_aws_placement_incomplete',
    'auto_retry_aws_preview_unavailable',
    'auto_retry_billing_allowance_exhausted',
    'auto_retry_billing_aws_monthly_cap',
    'auto_retry_billing_concurrent_limit',
    'auto_retry_billing_fair_use_paused',
    'auto_retry_billing_files_on_aws',
    'auto_retry_billing_no_allowance',
    'auto_retry_billing_unavailable',
    'auto_retry_billing_user_hours_cap',
    'auto_retry_capacity_attempt_expired',
    'auto_retry_capacity_unavailable',
    'auto_retry_code_preview_unavailable',
    'auto_retry_computer_limit_reached',
    'auto_retry_computer_recovering',
    'auto_retry_computer_starting',
    'auto_retry_computer_stopped',
    'auto_retry_computer_stopping',
    'auto_retry_computer_unavailable',
    'auto_retry_connection_refused',
    'auto_retry_desktop_failed',
    'auto_retry_desktop_unreachable',
    'auto_retry_fetch_failed',
    'auto_retry_identity_refresh_required',
    'auto_retry_kill_switch',
    'auto_retry_malformed_reply',
    'auto_retry_preconditions_unmet',
    'auto_retry_provider_not_configured',
    'auto_retry_repo_open_failed',
    'auto_retry_repo_open_unsupported_provider',
    'auto_retry_request_failed',
    'auto_retry_restart_foreign_computer',
    'auto_retry_restart_timeout',
    'auto_retry_restart_unavailable',
    'auto_retry_sandbox_runtime_blocked',
    'auto_retry_sandbox_start_failed',
    'auto_retry_sandbox_starting',
    'auto_retry_timeout',
    'auto_retry_unknown',
    'auto_retry_user_hours_cap',
    'auto_retry_worker_http_error',
    // desktop-window.js tti: `${key}_${path}`, key first_frame|first_input, path OpeningPathV3 + running|cloudflare|unknown
    'first_frame_cloudflare',
    'first_frame_cold',
    'first_frame_migrate',
    'first_frame_restart',
    'first_frame_running',
    'first_frame_switch',
    'first_frame_unknown',
    'first_frame_wait',
    'first_frame_warm',
    'first_input_cloudflare',
    'first_input_cold',
    'first_input_migrate',
    'first_input_restart',
    'first_input_running',
    'first_input_switch',
    'first_input_unknown',
    'first_input_wait',
    'first_input_warm',
    // desktop-window.js reopen_on_new_runtime(why)
    'desktop_restarted',
    'relay_runtime_changed',
    'transition_in_flight',
    // desktop-window.js #mint move answer
    'computer_move_needs_attention',
    'computer_moving',
    // boot.js give_up(reason), normalised
    'mount_budget_exhausted',
    // trace.js end(outcome) for boot_summary
    'ok',
    'error',
    'skipped',
    // telemetry.js window error names, normalised
    'error',
    'typeerror',
    'rangeerror',
    'referenceerror',
    'syntaxerror',
    'evalerror',
    'urierror',
    'aggregateerror',
    'aborterror',
    'notallowederror',
    'notfounderror',
    'notsupportederror',
    'securityerror',
    'invalidstateerror',
    'networkerror',
    'timeouterror',
    'quotaexceedederror',
    'unhandled_rejection',
    // desktop-window.js screen: `screen_${name}`
    'screen_unsupported',
    'screen_notallowederror',
    'screen_securityerror',
    'screen_notsupportederror',
    'screen_invalidstateerror',
    'screen_aborterror',
]);

/**
 * One event reduced to the closed vocabulary, or null when its class or site is
 * not listed. Input fields are only compared, never copied: every returned
 * string is one of this module's own.
 * @returns {{ eventClass: string, site: string, code: string } | null}
 */
export function projectEvent (event) {
    const eventClass = EVENT_CLASSES.find(name => name === event?.eventClass);
    const site = Object.keys(EVENT_SITES).find(name => name === event?.site);
    if ( ! eventClass || ! site || ! EVENT_SITES[site].includes(eventClass) ) return null;
    const code = EVENT_CODES.has(event?.code) ? [...EVENT_CODES].find(name => name === event.code) : UNLISTED_CODE;
    return { eventClass, site, code };
}

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/**
 * One activity-log line (an event with its time and outcome) reduced the same
 * way, or null. The instant is kept only in its fixed UTC form.
 * @returns {{ t: string, eventClass: string, site: string, code: string, outcome: 'ok'|'error'|'skipped' } | null}
 */
export function projectLogLine (line) {
    const event = projectEvent(line);
    if ( ! event || typeof line?.t !== 'string' || ! INSTANT.test(line.t) ) return null;
    const outcome = /** @type {'ok'|'error'|'skipped'} */ (OUTCOMES.find(name => name === line.outcome) ?? 'error');
    return { t: line.t, ...event, outcome };
}

/** `value` when it is one of `list`, else undefined (a closed field is never free text). */
export function oneOf (list, value) {
    return list.find(item => item === value);
}
