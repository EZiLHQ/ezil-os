/**
 * The nine `/api/shell/*` routes, served locally.
 *
 * Same method, same request body and same response JSON as
 * `app/src/app/api/shell/*\/route.ts`, over a `SandboxHost` instead of a tRPC
 * caller. The shell cannot tell which server it is talking to and must not need
 * to: every field asserted in `./shell-contract.test.ts` is one a named line of
 * `shell/` actually reads, and the test cites that line.
 *
 * ── The one gate ────────────────────────────────────────────────────────────
 * Hosted, `assertOwnedComputer` answers "is this the caller's computer?".
 * Locally there is one user and one computer, so the same question is "is this
 * the computer this host is serving?" — `computerId` must equal the id derived
 * from this host's workspace path. A mismatch is `NOT_FOUND`, the same code and
 * status the hosted procedure produces, so the shell's branches are unchanged.
 * It is not an authorization gate (there is nobody to authorize); it is what
 * stops a stale payload in an old tab from driving the wrong workspace.
 *
 * ── Boot honesty ────────────────────────────────────────────────────────────
 * 🔴 `guacamoleRunning` IS `DesktopStatus.desktopReady` AND NOTHING ELSE.
 * `docker run --publish` binds every port at container-CREATE time, so any
 * check that reasons from "the container is running" or "the port is bound"
 * would answer `true` for a container whose desktop died thirty seconds ago —
 * `docs/PLATFORM-NOTES.md` §16, reproduced in local mode. `sandbox-host.ts`
 * defines `desktopReady` as "the desktop port ANSWERED", an observation, and
 * that is the only thing this file will turn into a `true`.
 */

import { CONTAINER_WORKSPACE_PATH, localUrlFor } from '../container/run-spec.ts';
import type { SandboxHost, ScreenMode } from '../host/sandbox-host.ts';
import {
    MAX_REQUESTED_AXIS,
    MIN_REQUESTED_AXIS,
    fitScreenRequest,
    parseRequestedScreen,
} from '../../../worker/src/screen-modes.ts';
import { SHELL_API_ROUTES } from '../contract/shell-api.ts';
import type { ShellBootComputer } from '../contract/shell-api.ts';
import { buildLocalBootPayload, buildLocalSessionPayload } from '../boot/payload.ts';
import { asRecord, newCorrelationId, readJsonBody, shellError, shellJson } from './http.ts';

/**
 * The provider tag every hosted answer carries.
 *
 * Re-exported from `../boot/payload.ts` rather than retyped, so the ONE
 * factually-wrong-but-type-forced literal in this package stays in one file —
 * see that file for why it exists and why nothing in `shell/` reads it.
 */
import { LOCAL_DESKTOP_PROVIDER_TAG } from '../boot/payload.ts';

// ── The frame probe ──────────────────────────────────────────────────────────

/** Why a probe of the desktop origin ended the way it did. Mirrors `probeDesktopFrame`'s reasons; no `unknown` variant, for the reason that function gives: for a REACHABILITY question a non-answer IS the answer. */
export type FrameProbeReason = 'ok' | 'http_error' | 'unreachable' | 'timeout' | 'foreign_origin';

export interface FrameProbe {
    /** The ONLY value that may become a "ready" claim anywhere. */
    readonly alive: boolean;
    readonly reason: FrameProbeReason;
    readonly status?: number;
}

/** How long the local frame probe waits. Loopback: anything that has not answered in 3s is not answering. */
export const FRAME_PROBE_TIMEOUT_MS = 3_000;

/**
 * Is this URL our own desktop origin?
 *
 * 🔴 THE PIN, AND IT IS NOT DECORATION. `frameUrl` arrives from the browser and
 * this host would otherwise fetch it — turning a loopback server into an
 * SSRF gadget any page in the user's browser could aim at their LAN with a
 * simple cross-origin POST/GET (no preflight). The hosted route pins the same
 * value inside the procedure (`isOwnDesktopOrigin`); this is that pin, with the
 * one origin local mode has.
 */
export function isOwnDesktopOrigin(raw: string): boolean {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return false;
    }
    let own: URL;
    try {
        own = new URL(localUrlFor('desktop'));
    } catch {
        return false;
    }
    return url.protocol === own.protocol && url.hostname === own.hostname && url.port === own.port;
}

/** The real probe: one GET at the desktop origin, read the status line. Injectable, so the contract test never needs a container. */
export async function probeDesktopOrigin(rawUrl: string): Promise<FrameProbe> {
    if (!isOwnDesktopOrigin(rawUrl)) return { alive: false, reason: 'foreign_origin' };
    try {
        const res = await fetch(rawUrl, {
            method: 'GET',
            redirect: 'manual',
            signal: AbortSignal.timeout(FRAME_PROBE_TIMEOUT_MS),
        });
        // Anything below 400 is the origin serving. neko answers its SPA shell
        // with a 200; a redirect is still an origin that is up. A 4xx/5xx is
        // the failure §16 describes and must never be laundered into ready.
        if (res.status < 400) return { alive: true, reason: 'ok', status: res.status };
        return { alive: false, reason: 'http_error', status: res.status };
    } catch (err) {
        const timedOut = err instanceof Error && err.name === 'TimeoutError';
        return { alive: false, reason: timedOut ? 'timeout' : 'unreachable' };
    }
}

// ── Dependencies ─────────────────────────────────────────────────────────────

export interface ShellRouterDeps {
    /** The desktop runtime. Injected: this package never imports `../host/docker-host.ts` (row T2 owns it). */
    readonly host: SandboxHost;
    /**
     * The id every route gates on. Separate from `bootComputer` below because
     * reading it must NOT consume the `isNew` latch: a status poll every two
     * seconds would otherwise burn the one moment the shell is allowed to be
     * told the workspace is brand new.
     */
    readonly computerId: () => string;
    /**
     * The full computer for a GET-OR-CREATE answer. Consumes the `isNew` latch,
     * because this is the call that would have created the row.
     */
    readonly bootComputer: () => ShellBootComputer;
    /**
     * The full computer for a READ-ONLY answer.
     *
     * 🔴 MUST NOT CONSUME THE `isNew` LATCH. `GET /api/shell/session` never
     * creates anything (the hosted route passes `isNew: false` outright —
     * `app/src/app/api/shell/session/route.ts:61`), so a read arriving before
     * the first POST must not burn the one moment the shell is allowed to be
     * told the workspace is brand new. Getting this wrong is silent: the boot
     * that really did create the workspace then reports `isNew: false`, and the
     * shell can no longer tell an expected-empty workspace from a lost one
     * (`boot-payload.ts`, and docs/RUNBOOK.md A2).
     */
    readonly readComputer: () => ShellBootComputer;
    /** Record that the desktop was opened. Moves `lastOpenedAt`. */
    readonly markOpened: () => void;
    /** Record presence. In memory only — local mode has no idle reaper to feed (`sandbox-host.ts` NON_GOALS: `schedule`). */
    readonly recordActivity: (lastInputAgoMs: number) => void;
    /** Append one telemetry batch to the NDJSON sink. Never throws out. */
    readonly appendTelemetry: (record: unknown) => Promise<void>;
    /** Overridable for tests. Defaults to `probeDesktopOrigin`. */
    readonly probeFrame?: (url: string) => Promise<FrameProbe>;
    readonly now?: () => number;
}

// ── Shared helpers ───────────────────────────────────────────────────────────

/** The `error` field the shell reads on a non-2xx. `NOT_FOUND` is what the hosted `assertOwnedComputer` produces for a computer that is not the caller's. */
function wrongComputer(): Response {
    return shellError('NOT_FOUND', 'Computer not found.');
}

function readComputerId(source: Record<string, unknown>): string {
    const raw = source['computerId'];
    return typeof raw === 'string' ? raw : '';
}

// ── The router ───────────────────────────────────────────────────────────────

export interface ShellRoute {
    readonly methods: readonly string[];
    readonly handle: (req: Request, deps: ShellRouterDeps) => Promise<Response>;
}

/**
 * Every path this host serves under `/api/shell`, keyed by the SAME path
 * strings `SHELL_API_ROUTES` publishes.
 *
 * 🔴 THE TABLE AND THE PAYLOAD MUST AGREE. `../contract/shell-api.ts` says it:
 * a key in `endpoints` is a switch, and publishing one this host does not serve
 * is a control that 404s while omitting one it does serve is a feature the user
 * silently never gets. `./shell-contract.test.ts` asserts these two objects
 * have exactly the same nine paths.
 */
export function shellRoutes(): Readonly<Record<string, ShellRoute>> {
    return Object.freeze({
        [SHELL_API_ROUTES.session]: { methods: ['GET', 'POST'], handle: handleSession },
        [SHELL_API_ROUTES.desktop]: { methods: ['GET', 'POST'], handle: handleDesktop },
        [SHELL_API_ROUTES.previewUrl]: { methods: ['POST'], handle: handlePreviewUrl },
        [SHELL_API_ROUTES.codePreviewUrl]: { methods: ['POST'], handle: handleCodePreviewUrl },
        [SHELL_API_ROUTES.focus]: { methods: ['POST'], handle: handleFocus },
        [SHELL_API_ROUTES.telemetry]: { methods: ['POST'], handle: handleTelemetry },
        [SHELL_API_ROUTES.restart]: { methods: ['POST'], handle: handleRestart },
        [SHELL_API_ROUTES.activity]: { methods: ['POST'], handle: handleActivity },
        [SHELL_API_ROUTES.screen]: { methods: ['GET', 'POST'], handle: handleScreen },
    });
}

// ── session ──────────────────────────────────────────────────────────────────

/**
 * `GET` = read the current session, never writes. `POST` = get-or-create.
 *
 * Locally the computer always exists (it is a directory, and the host created
 * it at startup), so both answer with one. The GET answer is still typed
 * `ShellSessionPayload` — a nullable computer — because that is the hosted
 * shape and narrowing it here would make the two answers different types for a
 * distinction local mode does not have.
 */
async function handleSession(req: Request, deps: ShellRouterDeps): Promise<Response> {
    if (req.method === 'GET') {
        // 🔴 `readComputer`, NOT `bootComputer`. `isNew` is false on the read
        // path, exactly as the hosted GET does
        // (`toShellBootComputer(lowest, false)`) — reading a session never
        // created anything, so it can never be the boot that did — AND the read
        // must not SPEND the latch either. Sharing the consuming accessor here
        // meant a status poll or a rehydrate arriving before the first
        // get-or-create silently turned the real `isNew: true` into `false`.
        return shellJson(buildLocalSessionPayload(deps.readComputer()));
    }
    deps.markOpened();
    return shellJson(buildLocalBootPayload(deps.bootComputer()));
}

// ── desktop ──────────────────────────────────────────────────────────────────

/** The applied-screen report the shell letterboxes to. Same three sources the hosted answer uses. */
interface AppliedScreen {
    readonly width: number;
    readonly height: number;
    readonly source: 'default' | 'requested' | 'snapped';
}

/**
 * What the shell asked for, resolved against the alignment rules.
 *
 * `parseRequestedScreen` and `fitScreenRequest` are IMPORTED from
 * `worker/src/screen-modes.ts` by relative path, the same way
 * `../container/run-spec.ts` imports the ports. Re-deriving "width to a
 * multiple of 8, height even, under the framebuffer and the pixel ceiling"
 * here would be a second implementation of a rule `assertUsableScreen` THROWS
 * on, and the two would drift.
 */
export function resolveLocalScreen(raw: unknown, fallback: ScreenMode): AppliedScreen {
    const asked = parseRequestedScreen(raw);
    if (!asked) return { ...fallback, source: 'default' };
    const fitted = fitScreenRequest(asked.width, asked.height);
    if (!fitted) return { ...fallback, source: 'default' };
    const exact = fitted.width === asked.width && fitted.height === asked.height;
    return { width: fitted.width, height: fitted.height, source: exact ? 'requested' : 'snapped' };
}

async function handleDesktop(req: Request, deps: ShellRouterDeps): Promise<Response> {
    return req.method === 'GET' ? handleDesktopGet(req, deps) : handleDesktopPost(req, deps);
}

/**
 * The cheap poll, plus the two `confirm=` observations.
 *
 * 🔴 MUST NOT WAKE ANYTHING. `SandboxHost.status`'s contract says the same
 * thing: this is the poll the shell runs on a timer, and an implementation that
 * started a container to answer it would make an idle tab boot a desktop.
 */
async function handleDesktopGet(req: Request, deps: ShellRouterDeps): Promise<Response> {
    const params = new URL(req.url).searchParams;
    const computerId = params.get('computerId') ?? '';
    const correlationId = newCorrelationId();
    if (computerId !== deps.computerId()) return wrongComputer();

    const confirm = params.get('confirm');

    if (confirm === 'frame') {
        const probe = await (deps.probeFrame ?? probeDesktopOrigin)(params.get('frameUrl') ?? '');
        // `session.js#confirmFrame` reads `data.ok === true` then
        // `data.confirmed === true`; anything else is `undefined`, which is not
        // an observation and must not be read as either verdict.
        return shellJson({
            ok: true,
            confirmed: probe.alive,
            reason: probe.reason,
            ...(probe.status === undefined ? {} : { status: probe.status }),
            correlationId,
        });
    }

    if (confirm === 'display') {
        // 🔴 `unknown`, ALWAYS, AND IT IS THE HONEST ANSWER — not a stub.
        // `docs/PLATFORM-NOTES.md` §16b: the only thing that knows whether a
        // WebRTC peer is connected is neko's own `GET /api/sessions`, and
        // reading it needs an authenticated login with the container's admin
        // password. `SandboxHost` exposes no credential (`DesktopUrls` is three
        // strings) and this host never mints one, so there is nothing here that
        // could observe the far end of the pipe.
        //
        // §16b is explicit about what must happen then: `unknown` is a fact
        // about OUR plumbing, not about the user's screen, and collapsing it
        // into `blank` would show a failure panel over a desktop that is
        // streaming perfectly. The shell's `applyDisplayEvidence` renders this
        // as `ready_unverified` — the desktop is shown, with a strip saying
        // plainly that nobody checked it. See the report's hand-off for the
        // credential this would need.
        return shellJson({ ok: true, display: 'unknown', reason: 'no_local_display_probe', correlationId });
    }

    const status = await deps.host.status(computerId);

    if (!status.ok) {
        // The host could not answer the question at all. `guacamoleRunning` is
        // ABSENT, never `false`: `session.js#desktopRunning` returns `undefined`
        // for a non-ok answer and its comment says why — "`undefined` must NOT
        // be read as `false` — that would fabricate a negative signal we do not
        // have."
        return shellJson({
            ok: false,
            error: status.error ?? 'host_unavailable',
            containerState: status.containerState,
            correlationId,
            provider: LOCAL_DESKTOP_PROVIDER_TAG,
        });
    }

    return shellJson({
        ok: true,
        // 🔴 THE OBSERVATION, NOT THE INFERENCE. See this file's header.
        guacamoleRunning: status.desktopReady,
        // Relayed so a troubleshooting view can say WHICH of the two facts is
        // false. The hosted answer has no equivalent because Cloudflare has no
        // container state to report; this is strictly more honest, not less.
        containerState: status.containerState,
        mode: status.mode,
        ...(status.exitCode === undefined ? {} : { exitCode: status.exitCode }),
        correlationId,
        provider: LOCAL_DESKTOP_PROVIDER_TAG,
    });
}

/**
 * The cold boot.
 *
 * Mirrors `cloudflareGuacamole.previewUrl`'s ORDER, because that order is what
 * makes the answer honest: get the desktop, then ask the host whether it is
 * ready, then ask the ORIGIN whether it serves, and only then hand out a URL.
 * Every failure is a VALUE on a 200 with an `errorCode` from the vocabulary
 * `app/src/components/desktop/boot-phases.shell.js`'s `classifyFailure` knows —
 * a thrown error is the one thing the shell's `withWakeAndOneRetry` re-issues,
 * and a deterministic failure re-asked is just the same answer twice.
 */
async function handleDesktopPost(req: Request, deps: ShellRouterDeps): Promise<Response> {
    const correlationId = newCorrelationId();
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return parsed.response;
    const body = asRecord(parsed.value);
    const computerId = readComputerId(body);
    if (computerId !== deps.computerId()) return wrongComputer();

    const asked = resolveLocalScreen(body['screen'], DEFAULT_LOCAL_SCREEN);

    try {
        await deps.host.ensureDesktop(computerId, {
            mode: 'neko',
            // OMITTED, not defaulted, when nothing usable was asked for — the
            // same rule the hosted procedure states: a `default` resolution
            // must produce a byte-for-byte identical container to the one this
            // codebase booted before the field existed.
            ...(asked.source === 'default' ? {} : { screen: { width: asked.width, height: asked.height } }),
        });
    } catch (err) {
        return shellJson({
            ok: false,
            error: err instanceof Error ? err.message.slice(0, 200) : 'ensure_desktop_failed',
            errorCode: 'sandbox_start_failed',
            correlationId,
            provider: LOCAL_DESKTOP_PROVIDER_TAG,
        });
    }

    // 🔴 `ensureDesktop` says it resolves only once the desktop is reachable.
    // This asks anyway. The row's contract is that this route never says ready
    // when `SandboxHost.status` does not, and "the adapter promised" is not an
    // observation — it is the same trust that produced `guacamoleRunning: true`
    // over an HTTP 500 in production (§16).
    const status = await deps.host.status(computerId);
    if (!status.ok) {
        return shellJson({
            ok: false,
            error: status.error ?? 'host_unavailable',
            errorCode: 'sandbox_runtime_blocked',
            correlationId,
            provider: LOCAL_DESKTOP_PROVIDER_TAG,
        });
    }
    if (!status.desktopReady) {
        return shellJson({
            ok: false,
            error: `host_status_not_ready_${status.containerState}`,
            errorCode: 'desktop_unreachable',
            correlationId,
            provider: LOCAL_DESKTOP_PROVIDER_TAG,
        });
    }

    const urls = await deps.host.desktopUrls(computerId);
    const frame = await (deps.probeFrame ?? probeDesktopOrigin)(urls.desktop);
    if (!frame.alive) {
        return shellJson({
            ok: false,
            error: `desktop_frame_${frame.reason}${frame.status === undefined ? '' : `_${frame.status}`}`,
            errorCode: 'desktop_unreachable',
            // The three fields the hosted answer added after ten production
            // failures were indistinguishable from each other.
            frameReason: frame.reason,
            frameStatus: frame.status,
            frameAttempts: 1,
            correlationId,
            provider: LOCAL_DESKTOP_PROVIDER_TAG,
        });
    }

    // 🔴 WHAT THE SCREEN ACTUALLY IS, not what was asked for. `readScreen`'s
    // whole contract is that `verified: false` means the numbers are the ASK.
    // Skipped when nothing was asked for, so the default path costs nothing —
    // same rule as the hosted procedure.
    let applied: AppliedScreen = asked;
    if (asked.source !== 'default') {
        const observed = await deps.host.readScreen(computerId);
        if (observed.ok && observed.verified) {
            const exact = observed.width === asked.width && observed.height === asked.height;
            applied = { width: observed.width, height: observed.height, source: exact ? 'requested' : 'snapped' };
        } else {
            // Unverified. Downgrade `requested` to `snapped` rather than telling
            // the shell its ask was honoured on the strength of having asked.
            applied = { ...asked, source: asked.source === 'requested' ? 'snapped' : asked.source };
        }
    }

    deps.markOpened();

    return shellJson({
        ok: true,
        correlationId,
        // `session.js#openDesktopOnce` requires this to be a non-empty string
        // and logs a `contract_violation` telemetry event if it is not.
        guacamoleUrl: composeLocalDesktopUrl(urls.desktop),
        provider: LOCAL_DESKTOP_PROVIDER_TAG,
        mode: 'neko',
        workspace: { mountPath: CONTAINER_WORKSPACE_PATH },
        // 🔴 `'manual'`, and it is the true value rather than a placeholder.
        // The hosted path returns `'implicit'` only after `enableImplicitHosting`
        // has POSTed `/api/login` with the container's admin password; this host
        // has no credential (see `confirm=display` above) and performs no
        // handshake, which is exactly the condition the hosted code reports as
        // `'manual'`. MEASURED, and it is the reason this matters: the pinned
        // image's `/etc/neko/neko.yaml` ships `session.implicit_hosting: false`,
        // so without either the handshake or the container env override the
        // desktop renders and ignores clicks. See the report's hand-off to T2.
        controlMode: 'manual',
        // What the SERVER observed before handing the URL over.
        // `session.js` reads `data.frame?.confirmed === true`, strictly, and
        // never defaults it to true.
        frame: { confirmed: frame.alive, status: frame.status, observedAt: (deps.now ?? Date.now)() },
        screen: applied,
        // 🔴 NO `expiresAt`. Hosted, it is the life of a 5-minute bootstrap
        // token. There is no token and no TTL on a published loopback port, and
        // a number here would be a deadline this host does not enforce.
    });
}

/** The initial screen when the shell asks for nothing. Kept next to its one use rather than re-exported from run-spec, which owns the container-side default. */
const DEFAULT_LOCAL_SCREEN: ScreenMode = { width: 1920, height: 1080 };

/**
 * The browser-facing desktop URL.
 *
 * 🔴 CREDENTIALS ARE PASSED THROUGH, NEVER INVENTED. Hosted,
 * `composeBrowserDesktopUrl` adds `usr`/`pwd` derived from the HMAC secret. This
 * host has no secret and no way to learn the per-boot password: `SandboxHost`
 * mints it inside the adapter (`buildContainerEnv` REQUIRES both passwords and
 * throws on an empty one) and `DesktopUrls` carries three bare strings. So this
 * function adds `embed=1` — a display flag, not a credential — and preserves
 * whatever the adapter put on the URL. If the adapter returns a bare origin the
 * result is a desktop that will ask for a password; that is a hand-off recorded
 * in the report, not something to paper over by guessing a default (the image's
 * own defaults are the public literals `neko`/`admin`, which is precisely what
 * `buildContainerEnv` fails closed to prevent).
 */
export function composeLocalDesktopUrl(raw: string): string {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return raw;
    }
    url.searchParams.set('embed', '1');
    return url.toString();
}

// ── preview-url / code-preview-url ───────────────────────────────────────────

/**
 * The two window-minting routes.
 *
 * Locally there is nothing to mint: `desktopUrls()` is a pure function of the
 * port map and the addresses are fixed for the container's lifetime. What this
 * route still does is REFUSE when the container is not running, mirroring the
 * hosted `app_preview_port_not_exposed` branch — handing over a URL for a port
 * nothing is listening on produces a blank window and no explanation.
 */
async function handlePreviewLike(
    req: Request,
    deps: ShellRouterDeps,
    field: 'appPreviewUrl' | 'codePreviewUrl',
    unavailable: { readonly error: string; readonly errorCode: string },
): Promise<Response> {
    const correlationId = newCorrelationId();
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return parsed.response;
    const computerId = readComputerId(asRecord(parsed.value));
    if (computerId !== deps.computerId()) return wrongComputer();

    const status = await deps.host.status(computerId);
    if (!status.ok || status.containerState !== 'running') {
        return shellJson({
            ok: false,
            error: unavailable.error,
            errorCode: unavailable.errorCode,
            correlationId,
            provider: LOCAL_DESKTOP_PROVIDER_TAG,
        });
    }

    const urls = await deps.host.desktopUrls(computerId);
    return shellJson({
        ok: true,
        correlationId,
        [field]: field === 'appPreviewUrl' ? urls.appPreview : urls.code,
        provider: LOCAL_DESKTOP_PROVIDER_TAG,
        // No `expiresAt`: see `handleDesktopPost`. `session.js#previewUrl` and
        // `apps/code.js#mintCodePreviewUrlOnce` both read it as optional and
        // carry it without acting on it.
    });
}

function handlePreviewUrl(req: Request, deps: ShellRouterDeps): Promise<Response> {
    return handlePreviewLike(req, deps, 'appPreviewUrl', {
        error: 'app_preview_port_not_exposed',
        errorCode: 'app_preview_unavailable',
    });
}

function handleCodePreviewUrl(req: Request, deps: ShellRouterDeps): Promise<Response> {
    return handlePreviewLike(req, deps, 'codePreviewUrl', {
        error: 'code_preview_port_not_exposed',
        errorCode: 'code_preview_unavailable',
    });
}

// ── focus ────────────────────────────────────────────────────────────────────

/**
 * The apps this host will accept a focus request for.
 *
 * 🔴 THE PRODUCT'S ENUM, NOT THE PRIMITIVE'S. `../container/run-spec.ts`'s
 * `FOCUS_APPS` is `['vscode', 'chromium']` — what `neko-switch-app.sh` can be
 * asked to do. The APP layer narrows it to `['chromium']`
 * (`FOCUSABLE_APPS`, `app/src/server/lib/cloudflare-guacamole-provider.ts:776`)
 * because `vscode` has no X window in today's image and the switch always
 * fails. Accepting the wider set here would hand the browser a control that is
 * guaranteed to fail, which is the thing the narrowing exists to prevent.
 * `./shell-contract.test.ts` reads that file's SOURCE TEXT and fails if the two
 * lists disagree — the technique `run-spec.test.ts` already uses for its own
 * cross-package twin.
 */
export const LOCAL_FOCUSABLE_APPS = ['chromium'] as const;
export type LocalFocusableApp = (typeof LOCAL_FOCUSABLE_APPS)[number];

async function handleFocus(req: Request, deps: ShellRouterDeps): Promise<Response> {
    const correlationId = newCorrelationId();
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return parsed.response;
    const body = asRecord(parsed.value);
    const computerId = readComputerId(body);
    if (computerId !== deps.computerId()) return wrongComputer();

    const app = body['app'];
    if (typeof app !== 'string' || !(LOCAL_FOCUSABLE_APPS as readonly string[]).includes(app)) {
        return shellError('BAD_REQUEST', `app must be one of: ${LOCAL_FOCUSABLE_APPS.join(', ')}`);
    }

    const result = await deps.host.focusApp(computerId, app as LocalFocusableApp);
    // A VALUE on a 200, like the hosted procedure: a focus switch the container
    // refused is a real answer the UI must render honestly, not an exception.
    // `session.js#focusApp` reads `res.data?.ok === true` and nothing else, and
    // its own doc is explicit that even `true` only means the request completed.
    return shellJson({
        ok: result.ok,
        app,
        error: result.detail,
        correlationId,
        provider: LOCAL_DESKTOP_PROVIDER_TAG,
    });
}

// ── telemetry ────────────────────────────────────────────────────────────────

/** Same batch cap as `TELEMETRY_LIMITS.MAX_EVENTS_PER_BATCH` upstream. The shell's own `MAX_BATCH` never exceeds it. */
export const LOCAL_TELEMETRY_MAX_EVENTS = 50;

/**
 * `POST /api/shell/telemetry` — ALWAYS 202, whatever happens.
 *
 * The hosted route's rule, kept exactly: unauthenticated, malformed, over-limit
 * and a downstream failure all look identical to the caller — `null` body,
 * `202`, `cache-control: no-store`. The client has nothing to branch on, so no
 * telemetry response can ever change product behaviour.
 *
 * 🔴 NEVER A NETWORK CALL. This writes NDJSON to a file on the user's own
 * machine and does nothing else. A local host that shipped a user's crash
 * events off the box would be the one thing local mode exists to make
 * impossible.
 */
async function handleTelemetry(req: Request, deps: ShellRouterDeps): Promise<Response> {
    const accepted = new Response(null, {
        status: 202,
        headers: { 'cache-control': 'no-store, no-cache, must-revalidate' },
    });
    try {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) return accepted;
        const body = asRecord(parsed.value);
        const events = Array.isArray(body['events']) ? body['events'].slice(0, LOCAL_TELEMETRY_MAX_EVENTS) : [];
        if (events.length === 0) return accepted;
        await deps.appendTelemetry({
            receivedAt: new Date().toISOString(),
            schemaVersion: body['schemaVersion'],
            events,
        });
    } catch (err) {
        // Even the sink failing is a 202. A telemetry bug must not become a
        // product failure, and there is nothing the browser could do about it.
        console.error('[ezil-local] telemetry sink failed', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
    return accepted;
}

// ── restart ──────────────────────────────────────────────────────────────────

/**
 * `RestartErrorCode` -> the strings `shell/ezil/ui/Settings/tabs/troubleshoot.js`
 * `reasonCopy()` actually renders.
 *
 * Three of T0's five codes are already that vocabulary. `in_progress` is
 * `restart_in_progress` there, and `runtime_error` has no entry — it maps to
 * `fetch_failed`, whose copy ("Could not reach the server") is what a caller
 * whose container runtime is unreachable should read. Anything unrecognised
 * still lands on `reasonCopy`'s honest default, so a future code is degraded,
 * never mis-described.
 */
export const RESTART_CODE_COPY: Readonly<Record<string, string>> = Object.freeze({
    not_running: 'bad_request',
    stop_timed_out: 'stop_timed_out',
    boot_failed: 'boot_failed',
    in_progress: 'restart_in_progress',
    runtime_error: 'fetch_failed',
});

async function handleRestart(req: Request, deps: ShellRouterDeps): Promise<Response> {
    const correlationId = newCorrelationId();
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return parsed.response;
    const computerId = readComputerId(asRecord(parsed.value));
    if (computerId !== deps.computerId()) return wrongComputer();

    const result = await deps.host.restartDesktop(computerId);
    if (!result.ok) {
        return shellJson({
            ok: false,
            // Never `result.detail` — that is free text that can carry a path or
            // a stack fragment, and this value is RENDERED.
            errorCode: RESTART_CODE_COPY[result.errorCode ?? ''] ?? 'unknown',
            correlationId,
            provider: LOCAL_DESKTOP_PROVIDER_TAG,
        });
    }
    return shellJson({
        ok: true,
        outcome: 'restarted',
        wasRunning: true,
        correlationId,
        provider: LOCAL_DESKTOP_PROVIDER_TAG,
    });
}

// ── activity ─────────────────────────────────────────────────────────────────

/**
 * `POST /api/shell/activity` — record that a human is present.
 *
 * 🔴 IT RECORDS AND STOPS THERE, AND THAT IS THE WHOLE POINT LOCALLY.
 * `sandbox-host.ts`'s NON_GOALS explains why there is no reaper to feed: there
 * is no metered compute to reclaim and no bill for an idle container, so the
 * hosted heartbeat's entire purpose is absent. The route exists so the shell's
 * heartbeat has somewhere to land (its `endpoints.activity` switch is on and
 * `desktop-window.js` fires on a timer) and so a future local idle policy has a
 * signal already flowing. It must NEVER touch the container — the hosted
 * comment says it outright: the heartbeat that exists so an idle container can
 * sleep would otherwise be what keeps waking it up.
 */
async function handleActivity(req: Request, deps: ShellRouterDeps): Promise<Response> {
    const correlationId = newCorrelationId();
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return parsed.response;
    const body = asRecord(parsed.value);
    const computerId = readComputerId(body);
    if (computerId !== deps.computerId()) return wrongComputer();

    const ago = body['lastInputAgoMs'];
    // The hosted zod is `z.number().finite().nonnegative()` and a miss is a 400.
    if (typeof ago !== 'number' || !Number.isFinite(ago) || ago < 0) {
        return shellError('BAD_REQUEST', 'lastInputAgoMs must be a finite, non-negative number.');
    }
    deps.recordActivity(ago);
    return shellJson({ ok: true, correlationId, provider: LOCAL_DESKTOP_PROVIDER_TAG });
}

// ── screen ───────────────────────────────────────────────────────────────────

async function handleScreen(req: Request, deps: ShellRouterDeps): Promise<Response> {
    return req.method === 'GET' ? handleScreenGet(req, deps) : handleScreenPost(req, deps);
}

/** OBSERVE the live screen, change nothing. `source: 'observed'` — deliberately not one of the setter's two words, because nothing was requested. */
async function handleScreenGet(req: Request, deps: ShellRouterDeps): Promise<Response> {
    const correlationId = newCorrelationId();
    const computerId = new URL(req.url).searchParams.get('computerId') ?? '';
    if (computerId !== deps.computerId()) return wrongComputer();

    const result = await deps.host.readScreen(computerId);
    if (!result.ok) {
        return shellJson({
            ok: false,
            error: { code: 'UPSTREAM', message: result.detail ?? 'screen_unreadable' },
            correlationId,
        });
    }
    if (!result.verified) {
        // 🔴 `verified: false` MEANS THE NUMBERS ARE THE ASK, NOT THE ANSWER —
        // `ScreenResult`'s own words. Reporting them as `observed` would be
        // exactly the lie `getScreen` exists to remove, so this answers "we
        // could not read it back" instead.
        return shellJson({
            ok: false,
            error: { code: 'UPSTREAM', message: 'screen_not_verified' },
            correlationId,
        });
    }
    return shellJson({
        ok: true,
        width: result.width,
        height: result.height,
        source: 'observed',
        correlationId,
    });
}

async function handleScreenPost(req: Request, deps: ShellRouterDeps): Promise<Response> {
    const correlationId = newCorrelationId();
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return parsed.response;
    const body = asRecord(parsed.value);
    const computerId = readComputerId(body);
    if (computerId !== deps.computerId()) return wrongComputer();

    const width = body['width'];
    const height = body['height'];
    // The hosted bounds, restated: `z.number().int().min(64).max(16384)`. Both
    // numbers are imported from `worker/src/screen-modes.ts` so there is one
    // definition of "an axis a client may ask for".
    const usable = (v: unknown): v is number =>
        typeof v === 'number' && Number.isInteger(v) && v >= MIN_REQUESTED_AXIS && v <= MAX_REQUESTED_AXIS;
    if (!usable(width) || !usable(height)) {
        // A VALUE, not a 400: `session.js#setScreen` reads `data.error.code` off
        // a 200 body and only treats a 404/405 as "stop asking". `BAD_REQUEST`
        // here is a measurement it can retry after the next resize.
        return shellJson({
            ok: false,
            error: { code: 'BAD_REQUEST', message: 'unusable_screen_measurement' },
            correlationId,
        });
    }

    // FIT, not snap — the platform applies arbitrary sizes inside the
    // framebuffer, so the desktop can be the window's own shape and there is
    // nothing left to letterbox.
    const target = fitScreenRequest(width, height);
    if (!target) {
        return shellJson({
            ok: false,
            error: { code: 'BAD_REQUEST', message: 'unusable_screen_measurement' },
            correlationId,
        });
    }

    const result = await deps.host.setScreen(computerId, target);
    if (!result.ok) {
        return shellJson({
            ok: false,
            error: { code: 'UPSTREAM', message: result.detail ?? 'screen_set_failed' },
            correlationId,
        });
    }

    // 🔴 THE ANSWER IS THE READ-BACK, NOT THE ASK. `verified: false` downgrades
    // `requested` to `snapped`: "we set it and could not check" is not "you got
    // what you asked for".
    const exact = result.width === width && result.height === height;
    return shellJson({
        ok: true,
        width: result.width,
        height: result.height,
        source: result.verified && exact ? 'requested' : 'snapped',
        correlationId,
    });
}
