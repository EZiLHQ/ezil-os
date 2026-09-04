/**
 * `SandboxHost` — the seam between EZiL OS and whatever is actually running the
 * desktop container.
 *
 * TYPES ONLY. There is no implementation in this file and there must not be
 * one: rows T1 and T2 build the native host and the Docker adapter in parallel,
 * and a shared contract that also contained behaviour would be a shared
 * contract that one of them had to change.
 *
 * ── What this replaces ──────────────────────────────────────────────────────
 * Today every desktop operation goes through `@cloudflare/sandbox`: a Worker
 * calls `getSandbox(env.Sandbox, name)` to get a Durable-Object-pinned handle,
 * then `startProcess`, `exposePort`, `containerFetch`, `exec` on it. That works
 * and stays exactly as it is — but it is unreachable on a machine with no
 * Cloudflare account, and the product's premise is that it runs anywhere.
 *
 * So the operations the shell actually needs are named here ONCE, in terms of a
 * `computerId` and nothing else, and each is annotated with the Cloudflare
 * primitive it stands in for. The Docker adapter implements them with the
 * `docker` CLI and fixed published ports (`../container/run-spec.ts`); a cloud
 * adapter would implement the same ten members with the SDK. Neither adapter
 * appears in this file.
 *
 * ── The one rule this interface exists to enforce ───────────────────────────
 * Nothing here mentions a hostname, a token, a zone, a Durable Object or a
 * bucket. The moment a member of this interface needs one of those, it has
 * stopped being "what the product needs" and started being "how Cloudflare does
 * it" — and the local adapter would have to fake it. `NON_GOALS` at the bottom
 * of this file names every primitive that was deliberately left out for exactly
 * that reason, and where it went instead.
 */

import type { DesktopMode } from '../../../worker/src/desktop-mode.ts';
import type { ScreenMode } from '../../../worker/src/screen-modes.ts';
import type { FocusApp } from '../container/run-spec.ts';

export type { DesktopMode, FocusApp, ScreenMode };

/**
 * The product's identifier for one user's computer. The adapter maps it to
 * whatever its runtime calls a container — a Durable Object name on Cloudflare,
 * a `--name` on Docker. Callers never see either.
 */
export type ComputerId = string;

// ── Status ───────────────────────────────────────────────────────────────────

/**
 * How much of a desktop is actually there.
 *
 * 🔴 THE STATES ARE ABOUT THE CONTAINER, NOT ABOUT A PORT LIST, AND THAT IS A
 * CORRECTION RATHER THAN A TRANSLATION. The hosted Worker's
 * `GET /sandbox/:name/status` answers `guacamoleRunning`, which has always
 * meant "the desktop port for the reported mode is EXPOSED" — a fact about
 * `getExposedPorts()`, i.e. about Cloudflare's hostname minting, not about
 * whether anything is serving. Locally, `docker run --publish` binds every port
 * at container-create time, so the same question would be answered `true` by a
 * container whose desktop had crashed thirty seconds ago. `desktopReady` below
 * is therefore defined as "the desktop port ANSWERED", which is the thing the
 * hosted field was always being read as.
 */
export type ContainerState =
    /** No container for this computer exists. Never started, or terminated. */
    | 'absent'
    /** The container object exists but is not running (created, or exited). `exitCode` says which, when the runtime reports one. */
    | 'stopped'
    /** The container process is running. Says nothing about whether the desktop inside it is up — read `desktopReady` for that. */
    | 'running';

export interface DesktopStatus {
    /** False only when the HOST could not answer the question at all (daemon unreachable, adapter error). A computer that simply does not exist is `ok: true, containerState: 'absent'`. */
    readonly ok: boolean;
    readonly computerId: ComputerId;
    readonly containerState: ContainerState;
    /**
     * The desktop port ANSWERED. An observation, never an inference from
     * `containerState` — a running container whose desktop died is
     * `running` + `false`, and reporting it as ready is the exact failure
     * `docs/PLATFORM-NOTES.md` §16 describes ("`guacamoleRunning: true` and an
     * HTTP 500 preview host are not a contradiction").
     */
    readonly desktopReady: boolean;
    /** The mode the running container was started in, or `null` when nothing is running. Never a default: "we do not know" is not "guacamole". */
    readonly mode: DesktopMode | null;
    /** The runtime's own exit code, when `containerState` is `'stopped'` and it reports one. */
    readonly exitCode?: number;
    /** Non-secret diagnostic, present iff `ok` is false. */
    readonly error?: string;
}

// ── URLs ─────────────────────────────────────────────────────────────────────

/**
 * Where the three browser-facing surfaces live.
 *
 * Replaces the Cloudflare preview-hostname triple that
 * `app/src/server/lib/cloudflare-guacamole-provider.ts` composes — `guacamoleUrl`,
 * `appPreviewUrl`, `codePreviewUrl`, each a `<port>-<id>-<token>.<zone>` host
 * minted by `exposePort()` and gated by a 5-minute bootstrap token.
 *
 * Locally there is no hostname to mint and no token to expire: the ports are
 * published on `127.0.0.1` when the container starts and stay there for its
 * lifetime. A caller must still ask for these rather than composing them, so
 * that a port change is one edit in `../container/run-spec.ts`.
 */
export interface DesktopUrls {
    /** neko's HTTP UI and WebSocket signalling — the desktop itself. */
    readonly desktop: string;
    /** code-server (VS Code in the browser). */
    readonly code: string;
    /** The user's own dev server. */
    readonly appPreview: string;
}

// ── Results ──────────────────────────────────────────────────────────────────

/**
 * Why a restart did not happen. Closed, so a caller can decide between "stop
 * asking" and "this one attempt failed" without parsing prose — the same reason
 * `GuacamoleScreenResult` carries five codes rather than a message.
 */
export type RestartErrorCode =
    /** No container for this computer. Start one instead. */
    | 'not_running'
    /** The stack was asked to stop and did not, within the adapter's deadline. */
    | 'stop_timed_out'
    /** It stopped, and the desktop did not come back. */
    | 'boot_failed'
    /** A restart for this computer is already in flight. */
    | 'in_progress'
    /** The container runtime itself failed or was unreachable. */
    | 'runtime_error';

export interface RestartResult {
    readonly ok: boolean;
    /** Present iff `ok` is false. */
    readonly errorCode?: RestartErrorCode;
    /** Non-secret detail for a log or a troubleshooting panel. */
    readonly detail?: string;
}

export interface FocusResult {
    readonly ok: boolean;
    /** Present iff `ok` is false. `neko-switch-app.sh` exits non-zero when the app has no X window — see why `vscode` is in the enum and yet cannot be focused in today's image. */
    readonly detail?: string;
}

export interface TerminateResult {
    readonly ok: boolean;
    /** True only when a container was observed present before and observed gone after. A computer that was already absent is `ok: true, terminated: false` — not a failure. */
    readonly terminated: boolean;
    readonly detail?: string;
}

/**
 * What the X display ACTUALLY is.
 *
 * 🔴 `verified: false` MEANS THE NUMBERS ARE THE ASK, NOT THE ANSWER. The size
 * a caller requested and the size X applied are different facts: Xvfb floors the
 * width to a multiple of 8 and reports success for the size it was asked for
 * (measured upstream: `900x1600` yields `896x1600`). An adapter that could not
 * read the display back must say so rather than echo the request as an
 * observation.
 */
export interface ScreenResult {
    readonly ok: boolean;
    readonly width: number;
    readonly height: number;
    readonly verified: boolean;
    readonly detail?: string;
}

export interface ExecOptions {
    /** Wall-clock budget. The adapter kills the child and returns `timedOut: true`; it never hangs forever. */
    readonly timeoutMs?: number;
    /** Run as a specific in-container user. Omitted means the image's default. */
    readonly user?: string;
}

export interface ExecResult {
    /** The process's exit status, or `null` when it was killed before exiting (see `timedOut`). */
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
    /** True when `timeoutMs` elapsed. Distinct from a non-zero exit: "it refused" and "we stopped waiting" are different answers. */
    readonly timedOut: boolean;
}

export interface EnsureDesktopOptions {
    /** Which desktop runtime to boot. */
    readonly mode: DesktopMode;
    /** Initial X screen. Omitted means the adapter's default (1920x1080). */
    readonly screen?: ScreenMode;
}

// ── The interface ────────────────────────────────────────────────────────────

/**
 * Ten members. Every one of them is something the shell or a `/api/shell/*`
 * route already needs; none of them is something a particular runtime happens
 * to offer.
 */
export interface SandboxHost {
    /**
     * Is there a desktop, and is it up?
     *
     * Replaces `GET /sandbox/:name/status` on the Worker, which is
     * `getSandbox(...)` + `getExposedPorts(hostname)` + `describeDesktopStatus`.
     *
     * 🔴 MUST NOT WAKE OR START ANYTHING. This is the cheap poll the shell runs
     * on a timer; an implementation that started a container to answer it would
     * make an idle tab boot a desktop.
     */
    status(id: ComputerId): Promise<DesktopStatus>;

    /**
     * Get a desktop, starting one if there is not already one running.
     *
     * Replaces `getSandbox(env.Sandbox, name)` +
     * `sandbox.startProcess('DESKTOP_MODE=… bash /usr/local/bin/start-desktop.sh')`
     * + `exposePort()` — the whole cold-boot path, measured at ~22s hosted.
     *
     * IDEMPOTENT. Calling it on a live desktop returns that desktop's URLs and
     * starts nothing; `start-desktop.sh` is itself idempotent, and this member
     * must be too. It resolves only once the desktop is actually reachable, so a
     * caller never has to poll `status` to find out whether the thing it just
     * asked for exists.
     */
    ensureDesktop(id: ComputerId, options: EnsureDesktopOptions): Promise<DesktopUrls>;

    /**
     * Restart the desktop stack INSIDE a live container, without destroying the
     * container, the computer, or the workspace.
     *
     * Replaces `POST /sandbox/:name/restart` (the Worker's
     * `EzilSandboxDO.restartDesktopStack`: SIGTERM the launcher, wait for exit,
     * then `ensureDesktop()` again).
     *
     * This is the Troubleshoot panel's button. It is NOT `terminate` followed by
     * `ensureDesktop`: the point is that the user's files survive.
     */
    restartDesktop(id: ComputerId): Promise<RestartResult>;

    /**
     * Foreground an app inside the container's X session.
     *
     * Replaces `POST /sandbox/:name/focus` — HMAC-gated on the Worker, and
     * ultimately one `exec` of `/usr/local/bin/neko-switch-app.sh <app>`.
     *
     * `app` is the closed enum from `../container/run-spec.ts`, never free text:
     * the value is interpolated into an in-container command, and a closed enum
     * is what makes that safe. This is the PRIMITIVE's enum (both apps); the
     * product layer narrows it to what today's image can actually focus.
     */
    focusApp(id: ComputerId, app: FocusApp): Promise<FocusResult>;

    /**
     * Read the size the X display ACTUALLY is — not what was last requested.
     *
     * Replaces `GET /sandbox/:name/screen` on the Worker. Answers the shell's
     * "did my resize take?" without changing anything.
     */
    readScreen(id: ComputerId): Promise<ScreenResult>;

    /**
     * Change the X screen mode of a LIVE desktop, and report what X then is.
     *
     * Replaces `POST /sandbox/:name/screen`. The desktop can simply BE the shape
     * of the user's window, which is what removes the letterboxing; the returned
     * size is a READ-BACK, never an echo of `mode`.
     */
    setScreen(id: ComputerId, mode: ScreenMode): Promise<ScreenResult>;

    /**
     * Where this computer's three browser-facing surfaces are.
     *
     * Replaces `exposePort()` + `normalizeSandboxHostname()` + the app's
     * `composeAppPreviewOrigin` / `composeCodePreviewOrigin` /
     * `mintAppPreviewBootstrapToken` — a chain that exists only because a public
     * hostname needs minting and gating.
     *
     * 🔴 MAY BE CALLED ON A COMPUTER THAT IS NOT RUNNING, and must answer
     * anyway: locally these are fixed addresses, so this is a pure function of
     * the port map. It says where the desktop WOULD be, never that it is up —
     * that question is `status`.
     */
    desktopUrls(id: ComputerId): Promise<DesktopUrls>;

    /**
     * Make an HTTP request to a port inside the container, from the host.
     *
     * Replaces `sandbox.containerFetch(request, port)` — the path the Worker
     * uses for surfaces that must NEVER get a public hostname, above all the
     * browser sidecar on 9223 (which can drive the user's logged-in browser).
     *
     * 🔴 THIS CANNOT CARRY A WEBSOCKET, AND NEITHER COULD THE THING IT REPLACES
     * (`docs/PLATFORM-NOTES.md` §19: `containerFetch()` is a JSRPC method and a
     * `WebSocket` is not serializable across it). The desktop's own signalling
     * does not need it: the browser dials the published desktop port directly.
     * An adapter that quietly upgraded here would be adding a capability the
     * cloud side cannot have.
     */
    fetchIn(id: ComputerId, port: number, request: Request): Promise<Response>;

    /**
     * Run a command inside the container and wait for it.
     *
     * Replaces `sandbox.exec(...)`. This is the primitive the rest sit on:
     * `focusApp`, `readScreen`, `setScreen` and `restartDesktop` are all
     * expressible as one `exec` plus a policy, and an adapter is free to
     * implement them that way.
     *
     * `argv` is an ARRAY and is never joined into a shell string. No value in it
     * can be word-split, glob-expanded or command-substituted, whatever a user
     * names their project. An adapter that needs a shell asks for one
     * explicitly (`['bash', '-lc', '…']`) and owns that decision.
     */
    exec(id: ComputerId, argv: readonly string[], options?: ExecOptions): Promise<ExecResult>;

    /**
     * Destroy the container. The workspace is a separate concern and is not
     * touched by this call.
     *
     * Replaces `DELETE /sandbox/:name` (`sandbox.destroy()`), and reports the
     * same honest distinction: `terminated` is true ONLY when a container was
     * observed present before and observed gone after.
     */
    terminate(id: ComputerId): Promise<TerminateResult>;
}

// ── NON_GOALS ────────────────────────────────────────────────────────────────

/**
 * 🔴 THE CLOUDFLARE PRIMITIVES THIS INTERFACE DELIBERATELY DOES NOT HAVE.
 *
 * This block is the load-bearing half of the file. Ten members is a small
 * surface, and it stayed small because each of the following was considered and
 * refused with a reason. If a later row finds itself wanting one of them, the
 * answer is a new adapter named below — not a tenth member here, and never a
 * local implementation that pretends.
 *
 * ── `blobs` — object storage for the workspace ─────────────────────────────
 * Hosted: the R2 bucket binding plus `sandbox.mountBucket()`, which mounts the
 * workspace bucket into the container so files survive a container that does
 * not (`docs/PLATFORM-NOTES.md` §8: no volume primitive, all local disk is
 * ephemeral, host restarts happen without notice).
 * Local: the user's own filesystem, bind-mounted. It is already durable — that
 * is the entire reason someone runs this on their own machine — so there is
 * nothing for the host interface to abstract.
 * Where it goes instead: a future `r2-sync` adapter, for a user who wants their
 * local workspace mirrored to object storage. That is a SYNC feature with its
 * own rules (§1: s3fs silently drops every second write; §2: R2 is pathological
 * for small files, so `node_modules` must never see it; §10: sync loops never
 * delete). None of those rules belong in a container host.
 *
 * ── `state` and `schedule` — Durable Object storage and alarms ─────────────
 * Hosted: `EzilSandboxDO`'s SQLite storage holds per-computer state, and DO
 * alarms drive the idle reaper that cools a desktop nobody is watching
 * (`docs/PLATFORM-NOTES.md` §22: `sleepAfter` is a LAST-REQUEST clock, and the
 * alarm you set to check idleness resets it).
 * Local: there is no metered compute to reclaim and no bill for an idle
 * container, so the reaper's whole purpose is absent. A user closes the lid.
 * Where it goes instead: the cloud adapter. If local mode ever wants a timer, it
 * is the host process's own timer over `status()` — not a member here, because
 * "schedule something" is not a question about a container.
 *
 * ── `exposePort` / `unexposePort` / `getExposedPorts` — hostname minting ───
 * Hosted: `exposePort(port, { token })` mints `<port>-<id>-<token>.<zone>`, a
 * public hostname `proxyToSandbox()` raw-forwards into the container. It needs a
 * routed custom domain — a `.workers.dev` caller gets "Port exposure requires a
 * custom domain" AFTER the container has already booted — which is precisely
 * why local mode publishes fixed ports instead.
 * Local: `docker run --publish 127.0.0.1:<port>:<port>`, decided once in
 * `../container/run-spec.ts`. There is no hostname, no token, no TTL and no
 * zone, so there is nothing to mint, nothing to revoke, and no list to read
 * back: `desktopUrls()` is a pure function of the port map.
 * Where it goes instead: the cloud adapter, behind `desktopUrls()`.
 *
 * ── `connectWs` — a WebSocket into the container ───────────────────────────
 * Hosted: impossible through `containerFetch` (§19 — it is a JSRPC method and a
 * `WebSocket` is not serializable across one), so neko's signalling reaches the
 * browser through the exposed preview hostname and `proxyToSandbox`, and the
 * media relays through TURN because §6 says there is no UDP path to a container
 * at all.
 * Local: the browser opens `ws://127.0.0.1:8181` itself and the media goes
 * direct over the published WebRTC mux port. Nothing needs to proxy a socket, so
 * the host never holds one. `fetchIn` is deliberately request/response only, and
 * an adapter must not quietly upgrade it — that would be a capability the cloud
 * side cannot have, in an interface whose point is that both sides can.
 *
 * ── `iceServers` — TURN credential minting ────────────────────────────────
 * Hosted: `worker/src/desktop-mode.ts` mints short-lived Cloudflare Realtime
 * TURN credentials per session, and `checkIceConfig` FAILS CLOSED when no TURN
 * provider is configured — correct there, because without a relay there is no
 * media path at all.
 * Local: both peers are on loopback. There is no NAT to traverse, no relay to
 * pay for, and no credential to mint or leak. `NEKO_LOCAL_ICE_ENV` in
 * `../container/run-spec.ts` is the whole configuration: one mux port and
 * `nat1to1=127.0.0.1`. `checkIceConfig` is deliberately NOT imported anywhere
 * in this package.
 * Where it goes instead: the cloud adapter, which already has it.
 */
export const NON_GOALS = [
    'blobs',
    'state',
    'schedule',
    'exposePort',
    'unexposePort',
    'getExposedPorts',
    'connectWs',
    'iceServers',
] as const;

/** A primitive this interface deliberately does not have. See the block above for each one's reason. */
export type NonGoal = (typeof NON_GOALS)[number];

// ── Compile-time conformance ─────────────────────────────────────────────────
//
// This file is types only, so `tsc --noEmit` is the only thing that can check
// it — and on its own tsc would happily accept an eleventh member appearing, or a
// non-goal quietly becoming one. These four lines make both of those a compile
// error. They emit nothing.
//
// 🔴 DO NOT DELETE THESE AS "UNUSED". They are module-scope type aliases that
// nothing references, so enabling `noUnusedLocals` (or any linter's unused
// rule) will report them as dead code. They are not: a type alias whose
// argument violates its own constraint is a compile ERROR at the declaration,
// which is the entire mechanism. Proven by mutation — adding an eleventh member
// named `exposePort` produced TS2344 twice, once from each check.

type Expect<T extends true> = T;
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** The interface has EXACTLY these ten members. Adding an eleventh is a decision, so it must be made here. */
type _TenMembers = Expect<Exactly<
    keyof SandboxHost,
    | 'status'
    | 'ensureDesktop'
    | 'restartDesktop'
    | 'focusApp'
    | 'readScreen'
    | 'setScreen'
    | 'desktopUrls'
    | 'fetchIn'
    | 'exec'
    | 'terminate'
>>;

/** No name in `NON_GOALS` is a member of `SandboxHost`. The list and the interface cannot silently agree to disagree. */
type _NoGoalIsAMember = Expect<Exactly<Extract<NonGoal, keyof SandboxHost>, never>>;
