/**
 * The closed, server-owned vocabulary an incident alert mail may name. Telemetry `site`/`code` arrive from clients
 * (schema-validated, but still client-chosen), so the mail never repeats one that is not listed here: it says
 * `(other)` and the fingerprint plus the admin link carry the triage. Adding a producer label means adding it here.
 */
import { TERMINAL_AI_CODES } from './types';

export const KNOWN_SITES: ReadonlySet<string> = new Set([
    'ezil-os:apps/code#aiRequest', 'compute.pool_session_timing', 'compute.transition', 'container:neko#app_exit', 'container:neko#decor',
    'container_start', 'ezil-os:apps/code#confirmFrame', 'ezil-os:apps/code#drawer', 'ezil-os:apps/code#mint',
    'ezil-os:apps/code#open', 'ezil-os:apps/code#project', 'ezil-os:apps/desktop#close',
    'ezil-os:apps/desktop#confirmFrame', 'ezil-os:apps/desktop#drawer', 'ezil-os:apps/desktop#mint',
    'ezil-os:apps/desktop#open', 'ezil-os:apps/desktop#reconnect', 'ezil-os:apps/desktop#relay',
    'ezil-os:apps/desktop#screen', 'ezil-os:apps/desktop#staleRuntime', 'ezil-os:apps/desktop#tti',
    'ezil-os:apps/desktop#watch', 'ezil-os:apps/preview#confirmFrame', 'ezil-os:apps/preview#mint',
    'ezil-os:apps/preview#open', 'ezil-os:apps/registry#launch', 'ezil-os:boot#give_up', 'ezil-os:boot#mount',
    'ezil-os:session#appPreviewUrl', 'ezil-os:session#previewUrl', 'ezil-os:settings#activate',
    'ezil-os:settings#init', 'ezil-os:settings#open', 'ezil-os:settings/drawer-action#collapse',
    'ezil-os:settings/drawer-action#open', 'ezil-os:settings/troubleshoot#restart-computer',
    'ezil-os:ui/app-drawer#attach', 'ezil-os:ui/app-drawer#handler', 'ezil-os:window#onerror',
    'ezil-os:window#unhandledrejection', 'neko_serve_bind', 'sandbox.preview.desktop_ready',
    'sandbox.preview.identity', 'sandbox.preview.turn', 'workspace_hydration', 'xvfb',
]);

export const KNOWN_CODES: ReadonlySet<string> = new Set([
    ...TERMINAL_AI_CODES, '08006', '22023', '23502', '23505', '42501', '42704', '42883', 'access_denied', 'account_conflict',
    'account_not_found', 'already_imported', 'app_exit_clean', 'app_open_threw', 'app_preview_url_missing',
    'ask_cap_reached', 'assignment_not_found', 'auth0_disabled', 'auth0_failed', 'aws_caller_unavailable',
    'aws_capacity', 'aws_config', 'aws_config_invalid', 'aws_desktop_config_unapplied', 'aws_desktop_failed',
    'aws_desktop_unreachable', 'aws_error', 'aws_throttled', 'aws_unavailable', 'bc', 'body_too_large',
    'boot_refused', 'c', 'capabilities_require_same_origin', 'card_declined', 'cf_api_403', 'code',
    'code_preview_url_missing', 'collapse_threw', 'commit_in_progress', 'commit_unavailable', 'computer_moving',
    'computer_image_updating', 'computer_rebase_required', 'confirm_ok', 'connect_failed', 'container_running', 'credentials_unavailable',
    'custom', 'deadline', 'decor_still_present', 'disabled', 'display', 'display_live', 'drawer_attach_failed',
    'drawer_handler_threw', 'enqueue_failed', 'error', 'event_conflict', 'export_failed', 'export_head_invalid',
    'export_host_mismatch', 'export_refused', 'failed', 'frame_not_answering', 'gateway_error', 'ghp_', 'head_moved',
    'ice_store_failed', 'idempotency_key_required', 'import_busy', 'import_corrupt', 'import_head_moved',
    'import_lost', 'import_mismatch', 'import_not_started', 'import_not_verified', 'input_too_large',
    'insufficient_credits', 'invalid', 'invalid_command', 'invalid_id_token', 'invalid_string',
    'invalid_subscription_state', 'mint_ok', 'missing', 'mount_failed', 'move_read_cap_reached', 'must_be_unset',
    'no_computer_in_payload', 'no_events', 'no_watcher', 'not_configured', 'not_found', 'null_window', 'ok',
    'opaque_origin_capabilities', 'origin_refused', 'os_ai_unavailable', 'os_completion_timeout',
    'os_invalid_request', 'os_model_not_included', 'os_plan_unavailable', 'os_proxy_unauthorized',
    'os_session_missing', 'otp_expired', 'paid_subscription_conflict', 'parameter_missing', 'payload_mismatch',
    'pool_session_timing', 'portal_configuration_missing', 'prefix_mismatch', 'preview_expired',
    'preview_runtime_stale', 'preview_url_missing', 'price_not_found', 'probe_failed', 'project_folder_missing',
    'project_not_authorized', 'protocol', 'rate_limited', 'region_missing', 'relay_refresh_failed', 'release_failed',
    'repo_not_found', 'request_cancelled', 'restore_hold_pending', 'route_not_found', 'sandbox_start_failed',
    'sandbox_starting', 'screen_size_missing', 'screen_unrequested_size', 'screen_upstream', 'settings_handler_threw',
    'source_identity_mismatch', 'stale_revision', 'stream_interrupted', 'subject_mismatch', 'switch_done_',
    'system_head_moved', 'tab_activate_threw', 'tab_init_threw', 'timeout', 'too_small', 'trial_offer_invalid',
    'trial_offer_unavailable', 'trial_unavailable', 'tunnel_create_failed', 'tunnel_exists', 'tunnel_http_401',
    'tunnel_http_403', 'tunnel_http_409', 'tunnel_http_429', 'tunnel_http_500', 'tunnel_http_502', 'tunnel_http_503',
    'tunnel_not_found', 'tunnel_response_malformed', 'tunnel_transport', 'turn_unavailable', 'typeerror',
    'uiwindow_returned_nothing', 'unauthorized', 'unavailable', 'unexpected', 'unexpected_error', 'unknown_app',
    'unknown_error', 'unknown_refusal', 'unrecognized_keys', 'unsupported', 'unsupported_gemini_request',
    'unsupported_source', 'user_banned', 'user_has_aws_computer', 'viewer_frames_missing', 'window_budget_reached',
    'worker_conflict', 'workspace_fuse_unavailable', 'workspace_missing', 'workspace_too_large',
]);

/** The label if it is a known server-owned one, else `(other)`. */
export const knownLabel = (value: string, known: ReadonlySet<string>): string => known.has(value) ? value : '(other)';
