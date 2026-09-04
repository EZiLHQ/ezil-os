/**
 * `DockerHost` — `SandboxHost` over the `docker` CLI.
 *
 * This is the adapter that makes the product run on a machine with no
 * Cloudflare account. It implements the ten members of `./sandbox-host.ts` by
 * spawning `docker` with the argv arrays `../container/run-spec.ts` builds, and
 * by talking to neko's own HTTP API on `127.0.0.1`.
 *
 * ── Everything below was measured against a real container ──────────────────
 * Docker 29.1.3, image `ezil-os-worker-sandbox:ff199202`. Where a comment says
 * "measured", a command was run and its output read; where it says "mirrors",
 * the hosted implementation was read and copied deliberately.
 *
 * ── The three rules this file exists to keep ────────────────────────────────
 *
 * 1. NO SHELL, EVER. Every `docker` invocation is an argv ARRAY handed to
 *    `Bun.spawn`. Nothing is joined into a string, so no computer name, image
 *    reference or password can be word-split, glob-expanded or command-
 *    substituted. The one place a value is interpolated into a command is
 *    `focusApp`, and it validates against a closed enum first.
 *
 * 2. NEVER A FALSE `ready`. `docs/PLATFORM-NOTES.md` §16b: neko serves its SPA
 *    with a 200 whether or not WebRTC will ever connect, so an HTTP 200 from
 *    the desktop origin is not a picture. Readiness here is neko's OWN answer —
 *    see `ensureDesktop`'s oracle below — and even that is honest about what it
 *    does not prove.
 *
 * 3. NEVER THE IMAGE'S DEFAULT PASSWORD. The pinned image ships
 *    `/etc/neko/neko.yaml` with `admin_password: "admin"` and
 *    `user_password: "neko"` in a public repository, and `start-neko.sh` cds
 *    into that directory so the file is loaded on every boot. A desktop
 *    published on a bound loopback port with those credentials is an
 *    unauthenticated desktop. This adapter mints its own and FAILS rather than
 *    falling back — see `credentialsFor`.
 */

import type {
    ComputerId,
    ContainerState,
    DesktopStatus,
    DesktopUrls,
    EnsureDesktopOptions,
    ExecOptions,
    ExecResult,
    FocusApp,
    FocusResult,
    RestartErrorCode,
    RestartResult,
    SandboxHost,
    ScreenMode,
    ScreenResult,
    TerminateResult,
} from './sandbox-host.ts';
import {
    LOCAL_DESKTOP_IMAGE_FALLBACK,
    NEKO_ADMIN_PASSWORD_ENV,
    NEKO_PATHS,
    NEKO_SCREEN_RATE_HZ,
    NEKO_USER_PASSWORD_ENV,
    assertUsableScreen,
    buildDockerExecArgv,
    buildDockerInspectArgv,
    buildDockerLogsArgv,
    buildDockerRemoveArgv,
    buildDockerRunArgv,
    buildDockerStartArgv,
    buildDockerStopArgv,
    buildFocusExecArgv,
    composeDesktopUrl,
    containerNameFor,
    localUrlFor,
} from '../container/run-spec.ts';

// ── The exec seam ────────────────────────────────────────────────────────────

export interface SpawnOutcome {
    /** `null` when the process was killed before exiting — see `timedOut`. */
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut: boolean;
}

export interface SpawnOptions {
    readonly timeoutMs?: number;
}

/**
 * How this adapter runs `docker`. Injectable so the unit suite can assert on
 * ARGV — the thing that actually reaches the daemon — without a daemon.
 *
 * The argv it receives NEVER includes the leading `docker`: the seam owns which
 * binary is invoked, so a test fake cannot be fooled by a different one.
 */
export type DockerSpawn = (argv: readonly string[], options?: SpawnOptions) => Promise<SpawnOutcome>;

/** The `fetch` this adapter uses. Injectable for the same reason as `DockerSpawn`. */
export type HostFetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The real spawner.
 *
 * 🔴 `Bun.spawn` WITH AN ARRAY, NEVER `Bun.$` AND NEVER A STRING. The timeout
 * is enforced HERE, by a timer plus `kill`, because `docker exec` has no
 * timeout flag of its own (`run-spec.ts`'s `DockerExecOptions` says so) — a
 * caller's `timeoutMs` that turned into no enforcement at all would be the
 * "config set is not config real" failure in its purest form.
 */
export function spawnDocker(argv: readonly string[], options: SpawnOptions = {}): Promise<SpawnOutcome> {
    const proc = Bun.spawn(['docker', ...argv], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    let timedOut = false;
    const timer = options.timeoutMs === undefined
        ? null
        : setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, options.timeoutMs);
    return (async () => {
        const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ]);
        const exitCode = await proc.exited;
        if (timer !== null) clearTimeout(timer);
        return { exitCode: timedOut ? null : exitCode, stdout, stderr, timedOut };
    })();
}

// ── Boot phases ──────────────────────────────────────────────────────────────

/**
 * How far a boot got.
 *
 * 🔴 NOT ON `DesktopStatus`, AND THAT IS DELIBERATE. `DesktopStatus` is the
 * pinned contract (`./sandbox-host.ts`, ten members, an eleventh field is a
 * compile error by construction) and it has `containerState` + `desktopReady`
 * and nothing else. `starting` and `waiting_for_neko` both map to
 * `running` + `desktopReady: false` there, which is TRUE but coarser than what
 * a boot panel wants. Rather than widen a frozen contract, the finer phase
 * lives on this class — a caller holding a `SandboxHost` sees the contract, a
 * caller holding a `DockerHost` can also ask `bootPhase(id)`.
 */
export type BootPhase = 'absent' | 'starting' | 'waiting_for_neko' | 'ready' | 'failed';

export interface DockerHostOptions {
    /** The image reference to run. Defaults to `LOCAL_DESKTOP_IMAGE_FALLBACK`; a real host resolves it with `readAndResolveDesktopImage` and passes it in. */
    readonly image?: string;
    /**
     * Shift every published port by this much. Instance-level, NOT per
     * container: `desktopUrls()` must be answerable for a computer that is not
     * running, which it can only be if the port map is a property of the host
     * rather than of a container that may not exist.
     */
    readonly hostPortOffset?: number;
    /** Absolute host path to bind-mount as the workspace. Omitted means the container's own ephemeral one. */
    readonly workspaceHostPath?: string;
    /** How long `ensureDesktop` waits for neko before reporting `failed`. */
    readonly bootTimeoutMs?: number;
    /** How long a `docker` invocation may take before it is killed. */
    readonly dockerTimeoutMs?: number;
    /** Grace period for `docker stop`, in seconds — long enough for `start-neko.sh`'s `terminate_stack` trap. */
    readonly stopTimeoutSeconds?: number;
    /** Seam. */
    readonly spawn?: DockerSpawn;
    /** Seam. */
    readonly fetch?: HostFetch;
    /**
     * Credential material. 32 bytes of randomness by default, minted once per
     * host process, never persisted and never logged — see `credentialsFor`.
     */
    readonly credentialSecret?: string;
}

/** Both neko roles for one computer. Opaque; never logged, never returned to a caller as a bare value. */
export interface NekoCredentials {
    readonly user: string;
    readonly admin: string;
}

/** Parsed `docker inspect`. `present: false` is the "no such container" answer, which is not an error. */
interface InspectResult {
    readonly present: boolean;
    readonly running: boolean;
    readonly exitCode: number | null;
    readonly image: string | null;
    readonly env: Readonly<Record<string, string>>;
    /** Set when the DAEMON could not answer at all, as distinct from "no such container". */
    readonly error?: string;
}

const DEFAULT_BOOT_TIMEOUT_MS = 180_000;
const DEFAULT_DOCKER_TIMEOUT_MS = 120_000;
const DEFAULT_STOP_TIMEOUT_S = 20;
/** How often the readiness loop asks. 500ms: fast enough that a 7s boot is not rounded up, cheap enough to be a loopback GET. */
const READY_POLL_INTERVAL_MS = 500;

/** The passwords the pinned image ships in `/etc/neko/neko.yaml`. Named so the guard against them is readable, and so a test can assert on the same constant the guard uses. */
export const IMAGE_DEFAULT_PASSWORDS: readonly string[] = ['admin', 'neko'];

export class DockerHost implements SandboxHost {
    private readonly image: string;
    private readonly offset: number;
    private readonly workspaceHostPath: string | undefined;
    private readonly bootTimeoutMs: number;
    private readonly dockerTimeoutMs: number;
    private readonly stopTimeoutSeconds: number;
    private readonly spawn: DockerSpawn;
    private readonly httpFetch: HostFetch;
    private readonly secret: string;
    private readonly phases = new Map<ComputerId, BootPhase>();
    /** Reentrancy guard for `restartDesktop` — `in_progress` is in the contract's error enum, so it must be reachable. */
    private readonly restarting = new Set<ComputerId>();

    constructor(options: DockerHostOptions = {}) {
        this.image = options.image ?? LOCAL_DESKTOP_IMAGE_FALLBACK;
        this.offset = options.hostPortOffset ?? 0;
        this.workspaceHostPath = options.workspaceHostPath;
        this.bootTimeoutMs = options.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;
        this.dockerTimeoutMs = options.dockerTimeoutMs ?? DEFAULT_DOCKER_TIMEOUT_MS;
        this.stopTimeoutSeconds = options.stopTimeoutSeconds ?? DEFAULT_STOP_TIMEOUT_S;
        this.spawn = options.spawn ?? spawnDocker;
        this.httpFetch = options.fetch ?? ((input, init) => fetch(input, init));
        this.secret = options.credentialSecret ?? mintSecret();
    }

    // ── status ───────────────────────────────────────────────────────────────

    /**
     * 🔴 STARTS NOTHING. One `docker inspect` and, only when the container is
     * running, one GET of neko's `/health`. No `run`, no `start`, no
     * `POST /api/login` — the shell polls this on a timer, and a login per poll
     * would mint a neko session per poll.
     */
    async status(id: ComputerId): Promise<DesktopStatus> {
        let name: string;
        try {
            name = containerNameFor(id);
        } catch (err) {
            return { ok: false, computerId: id, containerState: 'absent', desktopReady: false, mode: null, error: message(err) };
        }
        const inspected = await this.inspect(name);
        if (inspected.error !== undefined) {
            return { ok: false, computerId: id, containerState: 'absent', desktopReady: false, mode: null, error: inspected.error };
        }
        if (!inspected.present) {
            this.phases.set(id, 'absent');
            return { ok: true, computerId: id, containerState: 'absent', desktopReady: false, mode: null };
        }
        const containerState: ContainerState = inspected.running ? 'running' : 'stopped';
        // 🔴 READ BACK, NEVER DEFAULTED. The contract: "Never a default: 'we do
        // not know' is not 'guacamole'." `DESKTOP_MODE` is in the container's
        // own `.Config.Env`, put there by the argv that created it.
        const rawMode = inspected.env['DESKTOP_MODE'];
        const mode = rawMode === 'neko' || rawMode === 'guacamole' ? rawMode : null;
        const desktopReady = inspected.running ? await this.nekoHealthy() : false;
        const base: DesktopStatus = { ok: true, computerId: id, containerState, desktopReady, mode };
        if (!inspected.running && inspected.exitCode !== null) {
            return { ...base, exitCode: inspected.exitCode };
        }
        return base;
    }

    /** The finer boot phase this adapter tracked. Not part of `SandboxHost` — see `BootPhase`. */
    bootPhase(id: ComputerId): BootPhase {
        return this.phases.get(id) ?? 'absent';
    }

    // ── ensureDesktop ────────────────────────────────────────────────────────

    /**
     * Get a desktop, starting one if there is not already one running.
     *
     * Three paths, all idempotent: running -> reuse, stopped -> `docker start`,
     * absent -> `docker run` with `buildDockerRunArgv`.
     *
     * 🔴 THE READINESS ORACLE, AND WHY IT IS NOT A 200.
     * `docs/PLATFORM-NOTES.md` §16b: neko answers 200 on `/` whether or not
     * anything will ever connect. So readiness here is two observations, in
     * order, both measured against the pinned image:
     *
     *   1. `GET /health` returns 200 with the body `true`. (`/api/health` is a
     *      404 on this build — measured. `/health` is neko's own.) This says
     *      the server is up.
     *   2. `POST /api/login` with THIS BOOT'S admin password returns 200 with a
     *      non-empty `token` and `profile.is_admin === true`. This says neko's
     *      session manager is running AND that the credentials we minted are
     *      the ones in force — which a 200 on `/` cannot say and which is the
     *      difference between a private desktop and a public one.
     *
     * The probe session is then `POST /api/logout`ed, so a boot does not leak a
     * session into `GET /api/sessions` (the array §16b reads).
     *
     * 🔴 AND `ready` IS STILL NOT A PICTURE. `state.is_watching` — the only
     * signal that a browser's `RTCPeerConnection` reached `connected` — needs a
     * real browser peer, and there is none at boot. That gate belongs to the
     * app layer (`probeDesktopDisplay`), and this method does not pretend to it.
     */
    async ensureDesktop(id: ComputerId, options: EnsureDesktopOptions): Promise<DesktopUrls> {
        const name = containerNameFor(id);
        if (options.mode !== 'neko') {
            throw new Error(`unsupported_local_mode: '${options.mode}' — local mode runs the neko desktop only`);
        }
        this.phases.set(id, 'starting');

        const inspected = await this.inspect(name);
        if (inspected.error !== undefined) {
            this.phases.set(id, 'failed');
            throw new Error(`docker_unreachable: ${inspected.error}`);
        }

        if (!inspected.present) {
            const creds = this.deriveCredentials(id);
            const argv = buildDockerRunArgv({
                containerName: name,
                image: this.image,
                mode: 'neko',
                ...(options.screen === undefined ? {} : { screen: options.screen }),
                userPassword: creds.user,
                adminPassword: creds.admin,
                ...(this.workspaceHostPath === undefined ? {} : { workspaceHostPath: this.workspaceHostPath }),
                hostPortOffset: this.offset,
            });
            const run = await this.spawn(argv, { timeoutMs: this.dockerTimeoutMs });
            if (run.exitCode !== 0) {
                this.phases.set(id, 'failed');
                // 🔴 A BIND CONFLICT IS ITS OWN ANSWER. Measured on the
                // development machine: an unrelated container held
                // `0.0.0.0:8443`, and `docker run` died with
                // `Bind for 0.0.0.0:8443 failed: port is already allocated`
                // before the image was ever started. A user with anything on
                // one of these ports must be told which, not handed a daemon
                // string — `hostPortOffset` is the fix and it is only findable
                // if the failure names itself.
                const detail = firstLine(run.stderr || run.stdout);
                if (/port is already allocated|address already in use|Bind for/i.test(detail)) {
                    throw new Error(`port_conflict: ${detail} — another process holds a port local mode publishes; construct DockerHost with a hostPortOffset`);
                }
                throw new Error(`docker_run_failed: ${detail}`);
            }
        } else if (!inspected.running) {
            const start = await this.spawn(buildDockerStartArgv(name), { timeoutMs: this.dockerTimeoutMs });
            if (start.exitCode !== 0) {
                this.phases.set(id, 'failed');
                throw new Error(`docker_start_failed: ${firstLine(start.stderr || start.stdout)}`);
            }
        }

        // Whatever path got here, the credentials in force are the container's
        // own — read back, not assumed. A host process that restarted while a
        // container kept running would otherwise derive a different pair and
        // hand the browser a `pwd` that cannot log in.
        const creds = await this.credentialsFor(id);
        this.phases.set(id, 'waiting_for_neko');
        const ready = await this.waitForNeko(name, creds.admin);
        if (!ready.ok) {
            this.phases.set(id, 'failed');
            throw new Error(`desktop_boot_failed: phase=waiting_for_neko ${ready.detail}`);
        }
        this.phases.set(id, 'ready');
        return this.urlsWith(creds.user);
    }

    // ── restartDesktop ───────────────────────────────────────────────────────

    /**
     * Restart the desktop stack without destroying the container or the
     * workspace.
     *
     * 🔴 `docker stop` + `docker start`, NOT `docker restart` AND NOT AN
     * `exec` OF `start-desktop.sh`, and both halves of that are measured.
     *
     * - Not an `exec`: the container's PID 1 IS the launcher
     *   (`--entrypoint /bin/bash … -c 'DESKTOP_MODE=neko bash
     *   /usr/local/bin/start-desktop.sh'`, which `exec`s `start-neko.sh`), and
     *   `start-neko.sh` traps EXIT to run `terminate_stack`. SIGTERM-ing the
     *   launcher inside the container therefore ends the container. The hosted
     *   Worker can do it because the SDK supervises the launcher as one process
     *   among several; here it is the whole container.
     * - Not `docker restart`: one call cannot distinguish `stop_timed_out` from
     *   `boot_failed`, and both are in the contract's closed error enum. Two
     *   calls keep the two answers apart.
     *
     * The container object, its writable layer and any bind mount all survive a
     * stop/start — which is the property the contract asks for ("the point is
     * that the user's files survive"). Measured: stop 2446ms with exit code 143
     * (128+SIGTERM, i.e. the trap ran), start 543ms, neko answering again 5749ms
     * after `docker start`, and the same password still logging in.
     */
    async restartDesktop(id: ComputerId): Promise<RestartResult> {
        let name: string;
        try {
            name = containerNameFor(id);
        } catch (err) {
            return fail('runtime_error', message(err));
        }
        if (this.restarting.has(id)) return fail('in_progress', 'a restart for this computer is already in flight');
        this.restarting.add(id);
        try {
            const inspected = await this.inspect(name);
            if (inspected.error !== undefined) return fail('runtime_error', inspected.error);
            if (!inspected.present) return fail('not_running', 'no container for this computer — start one instead');

            if (inspected.running) {
                const stop = await this.spawn(buildDockerStopArgv(name, this.stopTimeoutSeconds), {
                    // The daemon's own grace period plus a margin: a `docker
                    // stop` that has not returned by then is the daemon not
                    // answering, which is a different failure from a container
                    // that will not die.
                    timeoutMs: (this.stopTimeoutSeconds + 15) * 1000,
                });
                if (stop.timedOut) return fail('stop_timed_out', `docker stop did not return within ${this.stopTimeoutSeconds + 15}s`);
                if (stop.exitCode !== 0) return fail('runtime_error', firstLine(stop.stderr || stop.stdout));
            }

            const start = await this.spawn(buildDockerStartArgv(name), { timeoutMs: this.dockerTimeoutMs });
            if (start.exitCode !== 0) return fail('boot_failed', firstLine(start.stderr || start.stdout));

            const creds = await this.credentialsFor(id);
            this.phases.set(id, 'waiting_for_neko');
            const ready = await this.waitForNeko(name, creds.admin);
            if (!ready.ok) {
                this.phases.set(id, 'failed');
                return fail('boot_failed', ready.detail);
            }
            this.phases.set(id, 'ready');
            return { ok: true };
        } finally {
            this.restarting.delete(id);
        }
    }

    // ── focusApp ─────────────────────────────────────────────────────────────

    /** One `docker exec <name> /usr/local/bin/neko-switch-app.sh <app>` — the same script the Worker's HMAC-gated `/focus` route ultimately runs. `app` is validated against the closed enum by `buildFocusExecArgv` before it reaches an argv. */
    async focusApp(id: ComputerId, app: FocusApp): Promise<FocusResult> {
        let argv: string[];
        try {
            argv = buildFocusExecArgv(containerNameFor(id), app);
        } catch (err) {
            return { ok: false, detail: message(err) };
        }
        const res = await this.spawn(argv, { timeoutMs: this.dockerTimeoutMs });
        if (res.exitCode === 0) return { ok: true };
        // `neko-switch-app.sh` exits non-zero when the app has no X window —
        // which is why `vscode` is in the enum and yet cannot be focused in
        // today's image (code-server has no window for `wmctrl` to raise).
        return { ok: false, detail: firstLine(res.stderr || res.stdout) || `neko-switch-app.sh exited ${res.exitCode}` };
    }

    // ── readScreen / setScreen ───────────────────────────────────────────────

    /**
     * 🔴 THESE ARE HTTP CALLS TO NEKO, NOT `docker exec`, AND THAT IS THE
     * MEASURED SHAPE RATHER THAN A CHOICE. The hosted Worker implements both
     * with `containerFetch` against `GET`/`POST /api/room/screen`
     * (`worker/src/index.ts`, `readNekoScreen`), authenticated with an admin
     * token from `POST /api/login`. There is no in-container command to reuse:
     * `xdpyinfo` can only READ, and setting the mode is neko's own X plumbing.
     * Verified live: `GET` -> `{"width":1920,"height":1080,"rate":60}`,
     * `POST {"width":1280,"height":800,"rate":60}` -> 200, `GET` afterwards ->
     * `{"width":1280,"height":800,...}`.
     */
    async readScreen(id: ComputerId): Promise<ScreenResult> {
        const token = await this.loginAdmin(id);
        if (token === null) return { ok: false, width: 0, height: 0, verified: false, detail: 'screen_login_failed' };
        const observed = await this.getScreen(token);
        await this.logout(token);
        if (observed === null) return { ok: false, width: 0, height: 0, verified: false, detail: 'screen_read_failed' };
        return { ok: true, width: observed.width, height: observed.height, verified: true };
    }

    /**
     * Change the X screen mode and report what X then IS.
     *
     * 🔴 THE POST'S OWN BODY IS NOT EVIDENCE. Measured upstream and recorded in
     * `worker/src/index.ts`: `POST /api/room/screen` with `900x1600` answers 200
     * and echoes `{"width":900,"height":1600}` while the display is actually
     * `896x1600`, because Xvfb floors the width to a multiple of 8. This method
     * therefore POSTs, then GETs, and reports the GET. When the GET does not
     * answer it returns the REQUESTED numbers with `verified: false` rather than
     * the echo — "the numbers are the ask, not the answer", exactly as
     * `ScreenResult` documents.
     */
    async setScreen(id: ComputerId, mode: ScreenMode): Promise<ScreenResult> {
        try {
            // The alignment rules X and vp8 would otherwise take away silently.
            assertUsableScreen(mode);
        } catch (err) {
            return { ok: false, width: mode.width, height: mode.height, verified: false, detail: message(err) };
        }
        const token = await this.loginAdmin(id);
        if (token === null) return { ok: false, width: mode.width, height: mode.height, verified: false, detail: 'screen_login_failed' };
        try {
            const res = await this.httpFetch(`${this.desktopOrigin()}${NEKO_PATHS.screen}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ width: mode.width, height: mode.height, rate: NEKO_SCREEN_RATE_HZ }),
            });
            if (!res.ok) {
                // 422 is neko's MEASURED answer for a size the X server cannot
                // reach (`{"code":422,"message":"cannot set screen size"}`), and
                // 400 is a malformed body. Both mean "asking again will not
                // help", so they are named differently from a transient 5xx.
                const unsupported = res.status === 400 || res.status === 422;
                return {
                    ok: false,
                    width: mode.width,
                    height: mode.height,
                    verified: false,
                    detail: unsupported ? `screen_unsupported_${res.status}` : `screen_upstream_${res.status}`,
                };
            }
            const observed = await this.getScreen(token);
            if (observed === null) {
                return { ok: true, width: mode.width, height: mode.height, verified: false, detail: 'screen_read_back_failed' };
            }
            return { ok: true, width: observed.width, height: observed.height, verified: true };
        } catch (err) {
            return { ok: false, width: mode.width, height: mode.height, verified: false, detail: `screen_upstream_exception: ${message(err)}` };
        } finally {
            await this.logout(token);
        }
    }

    // ── desktopUrls ──────────────────────────────────────────────────────────

    /**
     * Where the three surfaces are, credential included.
     *
     * 🔴 ANSWERS FOR A COMPUTER THAT IS NOT RUNNING, which is what forces the
     * credential to be DERIVED rather than random-per-boot: a random value
     * would not exist yet for an absent container, and the contract requires an
     * answer anyway. So the pair is HMAC-derived from an instance secret and
     * the computer id — the same construction the Worker uses
     * (`ezil-neko:<role>:<id>:v1`) — and, when a container DOES exist, read back
     * out of its own environment so a restarted host process cannot disagree
     * with a container it did not start.
     */
    async desktopUrls(id: ComputerId): Promise<DesktopUrls> {
        const creds = await this.credentialsFor(id);
        return this.urlsWith(creds.user);
    }

    // ── fetchIn ──────────────────────────────────────────────────────────────

    /**
     * An HTTP request to a port inside the container, from the host.
     *
     * 🔴 REQUEST/RESPONSE ONLY. `docs/PLATFORM-NOTES.md` §19: the thing this
     * replaces (`containerFetch`) is a JSRPC method and a `WebSocket` is not
     * serializable across one, so the cloud side CANNOT carry an upgrade.
     * Locally an upgrade would work perfectly — which is exactly why it is
     * refused here. An adapter that quietly offered it would be adding a
     * capability to an interface whose entire point is that both sides have the
     * same one, and the first caller to depend on it would break the cloud
     * adapter, not this one.
     */
    async fetchIn(id: ComputerId, port: number, request: Request): Promise<Response> {
        containerNameFor(id); // validate the id even though the address is fixed
        const upgrade = request.headers.get('upgrade');
        if (upgrade !== null && upgrade.trim() !== '') {
            throw new Error(`fetchIn_no_upgrade: '${upgrade}' — fetchIn is request/response only (PLATFORM-NOTES §19); the browser dials the published desktop port itself`);
        }
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error(`invalid_port: ${port}`);
        }
        const inbound = new URL(request.url);
        const target = `http://127.0.0.1:${port + this.offset}${inbound.pathname}${inbound.search}`;
        const init: RequestInit = { method: request.method, headers: request.headers };
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            init.body = await request.arrayBuffer();
        }
        return this.httpFetch(target, init);
    }

    // ── exec ─────────────────────────────────────────────────────────────────

    /**
     * `docker exec <name> <argv…>`. The argv is passed through as an ARRAY and
     * is never joined; a caller that wants a shell asks for one explicitly and
     * owns that decision.
     *
     * The timeout is enforced host-side (`docker exec` has no flag for one), and
     * a killed process reports `exitCode: null` + `timedOut: true` — "it
     * refused" and "we stopped waiting" are different answers.
     */
    async exec(id: ComputerId, argv: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
        const name = containerNameFor(id);
        const full = buildDockerExecArgv(name, argv, options.user === undefined ? {} : { user: options.user });
        const res = await this.spawn(full, { timeoutMs: options.timeoutMs ?? this.dockerTimeoutMs });
        return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr, timedOut: res.timedOut };
    }

    // ── terminate ────────────────────────────────────────────────────────────

    /** `docker rm --force`. `terminated` is true ONLY when a container was observed present before and observed gone after — an already-absent computer is `ok: true, terminated: false`, which is not a failure. */
    async terminate(id: ComputerId): Promise<TerminateResult> {
        let name: string;
        try {
            name = containerNameFor(id);
        } catch (err) {
            return { ok: false, terminated: false, detail: message(err) };
        }
        const before = await this.inspect(name);
        if (before.error !== undefined) return { ok: false, terminated: false, detail: before.error };
        if (!before.present) {
            this.phases.set(id, 'absent');
            return { ok: true, terminated: false, detail: 'no container for this computer' };
        }
        const rm = await this.spawn(buildDockerRemoveArgv(name), { timeoutMs: this.dockerTimeoutMs });
        if (rm.exitCode !== 0) return { ok: false, terminated: false, detail: firstLine(rm.stderr || rm.stdout) };
        const after = await this.inspect(name);
        this.phases.set(id, 'absent');
        if (after.present) return { ok: false, terminated: false, detail: 'container still present after docker rm --force' };
        return { ok: true, terminated: true };
    }

    // ── diagnostics (outside the interface) ──────────────────────────────────

    /** The container's recent log, for a troubleshooting panel. Not a `SandboxHost` member — a boot failure's diagnosis is a local concern. */
    async logs(id: ComputerId, tailLines = 200): Promise<string> {
        const res = await this.spawn(buildDockerLogsArgv(containerNameFor(id), tailLines), { timeoutMs: this.dockerTimeoutMs });
        return `${res.stdout}${res.stderr}`;
    }

    // ── internals ────────────────────────────────────────────────────────────

    private urlsWith(userPassword: string): DesktopUrls {
        return {
            desktop: composeDesktopUrl(localUrlFor('desktop', this.offset), userPassword),
            code: localUrlFor('code', this.offset),
            appPreview: localUrlFor('appPreview', this.offset),
        };
    }

    private desktopOrigin(): string {
        return localUrlFor('desktop', this.offset);
    }

    /**
     * Derive this host's credentials for a computer.
     *
     * Mirrors `deriveNekoCredentials` in `worker/src/hmac.ts` —
     * `HMAC-SHA256(secret, 'ezil-neko:<role>:<id>:v1')`, lowercase hex, first 32
     * characters — with ONE deliberate difference:
     *
     * 🔴 THERE IS NO KEYLESS FALLBACK. The Worker's version returns
     * `{ user: 'neko', admin: 'admin' }` when no secret is configured, which is
     * correct hosted (a keyless environment is a dev environment behind a
     * Cloudflare zone) and catastrophic here: it would publish a desktop on a
     * bound loopback port whose password is a literal in a public repository.
     * This host mints 32 bytes of randomness at construction instead, so the
     * "no secret" branch cannot exist.
     */
    private deriveCredentials(id: ComputerId): NekoCredentials {
        const creds = {
            user: deriveRole(this.secret, 'user', id),
            admin: deriveRole(this.secret, 'admin', id),
        };
        assertNotDefault(creds);
        return creds;
    }

    /**
     * The credentials actually in force for a computer: read out of a live
     * container's own environment when there is one, derived otherwise.
     *
     * Reading back is what makes the host stateless across its own restarts. It
     * also means the guard against the image defaults applies to a container
     * this process did not start.
     */
    private async credentialsFor(id: ComputerId): Promise<NekoCredentials> {
        const inspected = await this.inspect(containerNameFor(id));
        if (inspected.present) {
            const user = inspected.env[NEKO_USER_PASSWORD_ENV];
            const admin = inspected.env[NEKO_ADMIN_PASSWORD_ENV];
            if (user === undefined || admin === undefined || user === '' || admin === '') {
                throw new Error(
                    `container_without_credentials: ${containerNameFor(id)} carries no ${NEKO_USER_PASSWORD_ENV}/${NEKO_ADMIN_PASSWORD_ENV}, so its neko is running on the image's own /etc/neko/neko.yaml defaults — remove it rather than connecting to it`,
                );
            }
            const creds = { user, admin };
            assertNotDefault(creds);
            return creds;
        }
        return this.deriveCredentials(id);
    }

    private async inspect(containerName: string): Promise<InspectResult> {
        const res = await this.spawn(buildDockerInspectArgv(containerName), { timeoutMs: this.dockerTimeoutMs });
        if (res.exitCode !== 0) {
            const err = `${res.stderr}${res.stdout}`;
            // "No such object" / "No such container" is the ABSENT answer, not
            // a daemon failure. Anything else is the daemon failing to answer,
            // which `DesktopStatus.ok: false` exists for.
            if (/no such (object|container)/i.test(err)) {
                return { present: false, running: false, exitCode: null, image: null, env: {} };
            }
            return { present: false, running: false, exitCode: null, image: null, env: {}, error: firstLine(err) || `docker inspect exited ${res.exitCode}` };
        }
        const [running, exitCode, image, envJson] = res.stdout.trim().split('\t');
        let env: Record<string, string> = {};
        try {
            const parsed: unknown = JSON.parse(envJson ?? 'null');
            if (Array.isArray(parsed)) env = parseEnvArray(parsed);
        } catch {
            env = {};
        }
        const code = Number.parseInt(exitCode ?? '', 10);
        return {
            present: true,
            running: running === 'true',
            exitCode: Number.isFinite(code) ? code : null,
            image: image ?? null,
            env,
        };
    }

    /** Cheap, unauthenticated, session-free liveness — for the status timer only. */
    private async nekoHealthy(): Promise<boolean> {
        try {
            const res = await this.httpFetch(`${this.desktopOrigin()}${NEKO_PATHS.health}`, { method: 'GET' });
            if (!res.ok) return false;
            // 🔴 THE BODY, NOT JUST THE STATUS. §16b's whole lesson is that a
            // 200 from this origin proves the HTTP server answered and nothing
            // else. Measured, `/health` returns the four bytes `true`.
            return (await res.text()).trim() === 'true';
        } catch {
            return false;
        }
    }

    /** Poll `/health`, then confirm with an authenticated login. See `ensureDesktop`'s doc for why both. */
    private async waitForNeko(containerName: string, adminPassword: string): Promise<{ ok: boolean; detail: string }> {
        const deadline = Date.now() + this.bootTimeoutMs;
        let lastDetail = 'neko never answered';
        while (Date.now() < deadline) {
            const alive = await this.inspect(containerName);
            if (alive.error !== undefined) return { ok: false, detail: `docker_unreachable: ${alive.error}` };
            if (!alive.present) return { ok: false, detail: 'the container disappeared during boot' };
            if (!alive.running) {
                return { ok: false, detail: `the container exited during boot (exit ${alive.exitCode ?? 'unknown'})` };
            }
            if (await this.nekoHealthy()) {
                const verdict = await this.confirmAdminLogin(adminPassword);
                if (verdict.ok) return { ok: true, detail: 'neko answered /health and accepted this boot\'s admin credential' };
                lastDetail = verdict.detail;
            } else {
                lastDetail = 'GET /health has not returned the body `true`';
            }
            await sleep(READY_POLL_INTERVAL_MS);
        }
        return { ok: false, detail: `${lastDetail} within ${this.bootTimeoutMs}ms` };
    }

    /**
     * One authenticated login, strictly parsed, then logged out.
     *
     * 🔴 STRICT ON PURPOSE, MIRRORING `readNekoScreen`'s rule: "either we
     * understood the answer or we did not have one". A 200 with an empty body,
     * `{}`, a non-string token or `is_admin: false` is NOT ready. A lenient
     * parse here would let a 200 from anything at all — a captive portal, a
     * different service that grabbed the port — be reported as a working
     * desktop.
     */
    private async confirmAdminLogin(adminPassword: string): Promise<{ ok: boolean; detail: string }> {
        let token: string | null = null;
        try {
            const res = await this.httpFetch(`${this.desktopOrigin()}${NEKO_PATHS.login}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: 'ezil-os-boot', password: adminPassword }),
            });
            if (!res.ok) return { ok: false, detail: `POST /api/login answered ${res.status}` };
            const body: unknown = await res.json().catch(() => null);
            if (typeof body !== 'object' || body === null) return { ok: false, detail: 'POST /api/login returned a body that is not an object' };
            const shape = body as { token?: unknown; profile?: { is_admin?: unknown } };
            if (typeof shape.token !== 'string' || shape.token === '') return { ok: false, detail: 'POST /api/login returned no token' };
            token = shape.token;
            if (shape.profile?.is_admin !== true) return { ok: false, detail: 'POST /api/login did not return an admin profile' };
            return { ok: true, detail: 'admin login accepted' };
        } catch (err) {
            return { ok: false, detail: `POST /api/login failed: ${message(err)}` };
        } finally {
            if (token !== null) await this.logout(token);
        }
    }

    private async loginAdmin(id: ComputerId): Promise<string | null> {
        const creds = await this.credentialsFor(id);
        try {
            const res = await this.httpFetch(`${this.desktopOrigin()}${NEKO_PATHS.login}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: 'ezil-os-screen', password: creds.admin }),
            });
            if (!res.ok) return null;
            const body = (await res.json().catch(() => null)) as { token?: unknown } | null;
            return typeof body?.token === 'string' && body.token !== '' ? body.token : null;
        } catch {
            return null;
        }
    }

    /** Best effort — a probe that could not clean up its session is not a boot failure. */
    private async logout(token: string): Promise<void> {
        try {
            await this.httpFetch(`${this.desktopOrigin()}${NEKO_PATHS.logout}`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
            });
        } catch {
            /* ignore */
        }
    }

    /** `GET /api/room/screen` — the OBSERVATION. `null` for anything not well formed. */
    private async getScreen(token: string): Promise<{ width: number; height: number } | null> {
        try {
            const res = await this.httpFetch(`${this.desktopOrigin()}${NEKO_PATHS.screen}`, {
                method: 'GET',
                headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
            });
            if (!res.ok) return null;
            const body = (await res.json().catch(() => null)) as { width?: unknown; height?: unknown } | null;
            if (!Number.isInteger(body?.width) || !Number.isInteger(body?.height)) return null;
            const width = body?.width as number;
            const height = body?.height as number;
            if (width <= 0 || height <= 0) return null;
            return { width, height };
        } catch {
            return null;
        }
    }
}

// ── free functions ───────────────────────────────────────────────────────────

/** 32 bytes of CSPRNG, hex. Never persisted, never logged. */
function mintSecret(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** `HMAC-SHA256(secret, 'ezil-neko:<role>:<id>:v1')`, lowercase hex, first 32 chars — byte-for-byte the Worker's construction. */
function deriveRole(secret: string, role: 'user' | 'admin', id: ComputerId): string {
    const hasher = new Bun.CryptoHasher('sha256', secret);
    hasher.update(`ezil-neko:${role}:${id}:v1`);
    return hasher.digest('hex').toLowerCase().slice(0, 32);
}

/**
 * 🔴 THE GUARD THAT KEEPS A PUBLIC PASSWORD OFF A BOUND PORT.
 * The pinned image ships `/etc/neko/neko.yaml` with `admin_password: "admin"`
 * and `user_password: "neko"`, and `start-neko.sh` cds into that directory so
 * it loads on every boot. Reaching this function with either literal means
 * something upstream fell back to the image's own defaults, and the desktop
 * would be published on `127.0.0.1` with a password anyone can read in the
 * repository. It throws rather than logs: a warning here is a warning nobody
 * sees until the desktop is already up.
 */
export function assertNotDefault(creds: NekoCredentials): void {
    for (const [role, value] of [['user', creds.user], ['admin', creds.admin]] as const) {
        if (IMAGE_DEFAULT_PASSWORDS.includes(value)) {
            throw new Error(
                `image_default_password: the ${role} credential is one of the image's own /etc/neko/neko.yaml defaults — refusing to publish a desktop anyone can log into`,
            );
        }
        if (value.length < 16) {
            throw new Error(`weak_neko_password: the ${role} credential is ${value.length} characters (expected the 32-character derived value)`);
        }
    }
}

function parseEnvArray(entries: readonly unknown[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const entry of entries) {
        if (typeof entry !== 'string') continue;
        const eq = entry.indexOf('=');
        if (eq <= 0) continue;
        out[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return out;
}

function fail(errorCode: RestartErrorCode, detail: string): RestartResult {
    return { ok: false, errorCode, detail };
}

function firstLine(text: string): string {
    return (text ?? '').trim().split('\n')[0] ?? '';
}

function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
