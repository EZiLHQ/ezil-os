/**
 * The ONE definition of how EZiL OS local mode runs its desktop container.
 *
 * Local mode has no Cloudflare in it. There is no Worker, no Durable Object,
 * no `exposePort()` and no preview hostname: a native Bun host (`../host/`,
 * built by rows T1/T2) shells out to the `docker` CLI and publishes the
 * container's ports straight onto `127.0.0.1`. Everything that differs
 * between "run it on Cloudflare" and "run it on my laptop" is either in this
 * file or in the adapter that consumes it.
 *
 * 🔴 WHY THIS FILE EXISTS AT ALL, AND WHY THERE IS NO `docker-compose.yml`.
 * Two workers build against this contract in parallel (the host server and the
 * Docker adapter). A contract described in two briefs is two contracts. A
 * compose file would be a THIRD copy of the port map and the environment — one
 * that nothing typechecks and nothing tests — and the first time a port moved,
 * two of the three would be right. So: one module, pure functions, argv arrays
 * out. Nothing here spawns a process, reads a secret, or touches the network.
 *
 * ── The ports are IMPORTED, never retyped ───────────────────────────────────
 * `worker/src/desktop-mode.ts` is where every in-container port number is
 * decided, and it stays that way. This module re-exports them under local-mode
 * names and `./run-spec.test.ts` asserts the NUMERIC values, so a change on
 * either side goes red instead of silently disagreeing.
 */

import {
    APP_PREVIEW_PORT,
    BROWSER_SIDECAR_PORT,
    CHROME_CDP_PORT,
    CODE_PREVIEW_PORT,
    portFor,
    type DesktopMode,
} from '../../../worker/src/desktop-mode.ts';
import {
    DEFAULT_SCREEN_MODE,
    SCREEN_COLOUR_DEPTH,
    type ScreenMode,
} from '../../../worker/src/screen-modes.ts';

// ── In-container ports ───────────────────────────────────────────────────────
//
// Imported above; named here so nothing downstream has to know that 8181 is
// reached through `portFor('neko')` rather than through a bare constant.

/** neko's HTTP UI + WebSocket signalling. `portFor('neko').port` — there is no standalone constant for it upstream. */
export const NEKO_HTTP_PORT: number = portFor('neko').port;

/** The Apache Guacamole HTML5 client. `portFor('guacamole').port`. Local mode does not run this mode, but the number is pinned so the collision check below is stated against real values. */
export const GUACAMOLE_HTTP_PORT: number = portFor('guacamole').port;

export { APP_PREVIEW_PORT, BROWSER_SIDECAR_PORT, CHROME_CDP_PORT, CODE_PREVIEW_PORT };

/**
 * The single WebRTC mux port, TCP **and** UDP.
 *
 * 🔴 THIS IS THE ONE PORT CLOUDFLARE COULD NOT GIVE US. `docs/PLATFORM-NOTES.md`
 * §6: Cloudflare Containers expose HTTP/WS only, so hosted neko has no UDP path
 * to a peer and every session must relay through TURN — the latency floor of
 * the hosted product. On a user's own machine the browser and the container are
 * both on loopback, so a single published mux port gives direct media with no
 * TURN, no STUN, and no credential to mint.
 *
 * `NEKO_WEBRTC_UDPMUX` replaces the ephemeral-port-range (`epr`) design
 * outright — one port instead of a range, which is what makes publishing it
 * with `-p` practical at all.
 */
export const WEBRTC_MUX_PORT = 52100;

/**
 * The host port the local `/os` page is served on — the native Bun host's own
 * listener, NOT a container port. 7080 because 8080 is guacamole's in-container
 * port and 3000 is reserved platform-wide (`docs/PLATFORM-NOTES.md` §5).
 */
export const LOCAL_OS_HOST_PORT = 7080;

/** Where the user's project tree lives inside the container. `start-neko.sh`'s own `${EZIL_WORKSPACE_ROOT:-/home/neko/project}` default. */
export const CONTAINER_WORKSPACE_PATH = '/home/neko/project';

/** The loopback address every published port binds to. Never `0.0.0.0`: a desktop with an unauthenticated automation surface must not be reachable from the user's LAN. */
export const LOCAL_BIND_ADDRESS = '127.0.0.1';

// ── The published port map ───────────────────────────────────────────────────

export interface PublishedPort {
    /** A stable key the host and the adapter both refer to this port by. */
    readonly name: 'desktop' | 'appPreview' | 'code' | 'sidecar' | 'webrtcUdp' | 'webrtcTcp';
    /** The port inside the container. */
    readonly container: number;
    /** The port on `127.0.0.1`. Equal to `container` today; kept separate so an offset is a one-line change here rather than a search-and-replace across two packages. */
    readonly host: number;
    readonly protocol: 'tcp' | 'udp';
    readonly why: string;
}

/**
 * Every port local mode publishes, and nothing else.
 *
 * 🔴 `CHROME_CDP_PORT` (9222) IS DELIBERATELY ABSENT AND MUST STAY ABSENT.
 * CDP is unauthenticated and total: whatever reaches it reads every page,
 * exfiltrates the profile's cookies and runs arbitrary JS in any origin.
 * Chromium M113+ pins it to container loopback regardless of flags, the
 * `worker/Dockerfile` never `EXPOSE`s it, and publishing it here would undo
 * both. `./run-spec.test.ts` asserts it never appears in a built argv.
 */
export const LOCAL_PORT_MAP: readonly PublishedPort[] = [
    { name: 'desktop', container: NEKO_HTTP_PORT, host: NEKO_HTTP_PORT, protocol: 'tcp', why: "neko's HTTP UI and WebSocket signalling — the desktop itself" },
    { name: 'appPreview', container: APP_PREVIEW_PORT, host: APP_PREVIEW_PORT, protocol: 'tcp', why: "the user's own dev server (`next dev --port 3002`)" },
    { name: 'code', container: CODE_PREVIEW_PORT, host: CODE_PREVIEW_PORT, protocol: 'tcp', why: 'code-server (VS Code in the browser)' },
    { name: 'sidecar', container: BROWSER_SIDECAR_PORT, host: BROWSER_SIDECAR_PORT, protocol: 'tcp', why: "the browser sidecar's fixed verb set — never CDP passthrough" },
    { name: 'webrtcUdp', container: WEBRTC_MUX_PORT, host: WEBRTC_MUX_PORT, protocol: 'udp', why: 'WebRTC media, direct — the path Cloudflare has no equivalent of' },
    { name: 'webrtcTcp', container: WEBRTC_MUX_PORT, host: WEBRTC_MUX_PORT, protocol: 'tcp', why: 'WebRTC media fallback when UDP is blocked locally' },
];

/** Look a published port up by name. Throws rather than returning `undefined`: every name in the union exists in the table, and a miss is a programming error, not a runtime condition. */
export function publishedPort(name: PublishedPort['name']): PublishedPort {
    const hit = LOCAL_PORT_MAP.find((p) => p.name === name);
    if (!hit) throw new Error(`local_port_map_missing: '${name}' is not in LOCAL_PORT_MAP`);
    return hit;
}

/** `http://127.0.0.1:<host port>` for a published TCP port. The local equivalent of a minted preview hostname. */
export function localUrlFor(name: PublishedPort['name']): string {
    const p = publishedPort(name);
    if (p.protocol !== 'tcp') throw new Error(`local_url_not_http: '${name}' is a ${p.protocol} port`);
    return `http://${LOCAL_BIND_ADDRESS}:${p.host}`;
}

// ── Environment ──────────────────────────────────────────────────────────────

/**
 * The local ICE configuration, as neko's own environment variables.
 *
 * 🔴 EVERY NAME HERE WAS MEASURED, NOT ASSUMED. Run against the pinned base
 * image (`ezil-neko-vscode:d74052bb-049931d7`):
 *
 *     docker run --rm --entrypoint /bin/bash <image> -c 'neko serve --help'
 *
 * reports `--webrtc.udpmux`, `--webrtc.tcpmux`, `--webrtc.nat1to1`,
 * `--webrtc.icelite` and `--webrtc.ip_retrieval_url`. neko is a Viper program:
 * a flag `--a.b.c` is the environment variable `NEKO_A_B_C`, which is how
 * `start-neko.sh` already sets `NEKO_SERVER_BIND`, `NEKO_DESKTOP_INPUT_ENABLED`
 * and `NEKO_WEBRTC_ESTIMATOR_*`. The launch line
 * (`worker/scripts/start-neko.sh`) passes NO `--webrtc.*` flag of its own, and
 * Viper ranks an explicit flag above the environment — so nothing overrides
 * these.
 *
 * 🔴 AND THERE IS A CONFIG FILE, WHICH IS NOT OBVIOUS AND WAS ALMOST MISSED.
 * The image ships `/etc/neko/neko.yaml`, and `start-neko.sh` does `cd /etc/neko`
 * before launching precisely so it is picked up ("preflight complete with config
 * file config=/etc/neko/neko.yaml" on every boot). Viper ranks env ABOVE a
 * config file, but that is a claim about a library, so it was measured against
 * this binary rather than cited — `NEKO_DESKTOP_DISPLAY` vs
 * `desktop.display` in the yaml, read off neko's own startup panic:
 *
 *     env :77, no yaml key      -> display=:77   (env binds at all)
 *     yaml :88 AND env :77      -> display=:77   (env beats the file)
 *     yaml :88, no env          -> display=:88   (control: the file IS read)
 *
 * The shipped yaml has no `webrtc:` section either way, so these four variables
 * are uncontested. It DOES carry
 * `member.multiuser.{admin_password: "admin", user_password: "neko"}` — see
 * `buildContainerEnv`'s fail-closed check, which exists because of exactly that.
 *
 * 🔴 `NEKO_WEBRTC_NAT1TO1` IS NOT OPTIONAL AND IS NOT COSMETIC.
 * `--webrtc.ip_retrieval_url` defaults to `https://checkip.amazonaws.com` and
 * neko fetches it **whenever `nat1to1` is unset** (the flag's own help text:
 * "automatically fetch IP address from given URL when nat1to1 is not present").
 * A product whose whole premise is "runs on your machine, no cloud" would then
 * make a hardcoded outbound call to Amazon on every boot — and get back the
 * user's public IP, which is the wrong candidate for a loopback peer anyway.
 * Setting `nat1to1` to `127.0.0.1` both fixes the candidate and removes the
 * call. `./run-spec.test.ts` asserts the variable is present in every built
 * argv for exactly this reason.
 *
 * `icelite` is correct here for the same reason it is wrong on Cloudflare: a
 * lite agent never gathers candidates of its own, which is precisely what we
 * want when the only candidate that could ever work is the mux port above.
 *
 * 🔴 `checkIceConfig` from `worker/src/desktop-mode.ts` is deliberately NOT
 * used. It fails closed when no TURN provider is configured, which is the right
 * answer for the hosted product (`docs/PLATFORM-NOTES.md` §6: no UDP path, so
 * no TURN means no media) and the wrong answer here, where TURN is exactly what
 * local mode does not need and must never mint.
 */
export const NEKO_LOCAL_ICE_ENV: Readonly<Record<string, string>> = Object.freeze({
    NEKO_WEBRTC_UDPMUX: String(WEBRTC_MUX_PORT),
    NEKO_WEBRTC_TCPMUX: String(WEBRTC_MUX_PORT),
    NEKO_WEBRTC_NAT1TO1: LOCAL_BIND_ADDRESS,
    NEKO_WEBRTC_ICELITE: 'true',
});

/** The environment variable that carries the neko admin password. Read natively by neko (`--member.multiuser.admin_password`), not by `start-neko.sh`. */
export const NEKO_ADMIN_PASSWORD_ENV = 'NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD';
/** The environment variable that carries the neko user password. Read natively by neko (`--member.multiuser.user_password`). */
export const NEKO_USER_PASSWORD_ENV = 'NEKO_MEMBER_MULTIUSER_USER_PASSWORD';

/**
 * Format a screen mode as neko's `NEKO_SCREEN` (`WxHxD`).
 *
 * Deliberately NOT `formatNekoScreen` from `worker/src/screen-modes.ts`: that
 * one returns `null` for anything outside the closed twelve-entry table,
 * because it is the last thing between an inbound HTTP request and an X server
 * command line. Nothing untrusted reaches this function — the local host owns
 * both ends — and local mode's whole point is that the desktop can simply BE
 * the shape of the user's window. The alignment rules still apply and are
 * enforced by `assertUsableScreen` below rather than by table membership.
 */
export function formatLocalNekoScreen(screen: ScreenMode): string {
    assertUsableScreen(screen);
    return `${screen.width}x${screen.height}x${SCREEN_COLOUR_DEPTH}`;
}

/**
 * The two properties X and vp8 will silently take away if we do not enforce
 * them: Xvfb floors the screen WIDTH to a multiple of 8 and reports success
 * for the size it was asked for (measured upstream: 900 -> 896), and an odd
 * HEIGHT produces vp8 chroma artefacts. Throwing means a caller can never be
 * told a size was applied that was not.
 */
export function assertUsableScreen(screen: ScreenMode): void {
    if (!Number.isInteger(screen.width) || !Number.isInteger(screen.height)) {
        throw new Error(`invalid_screen: ${screen.width}x${screen.height} is not two integers`);
    }
    if (screen.width <= 0 || screen.height <= 0) {
        throw new Error(`invalid_screen: ${screen.width}x${screen.height} has a non-positive axis`);
    }
    if (screen.width % 8 !== 0) {
        throw new Error(`invalid_screen_width: ${screen.width} is not a multiple of 8 (Xvfb floors it to ${Math.floor(screen.width / 8) * 8} and reports success)`);
    }
    if (screen.height % 2 !== 0) {
        throw new Error(`invalid_screen_height: ${screen.height} is odd (vp8 chroma artefacts)`);
    }
}

// ── The image reference ──────────────────────────────────────────────────────

/**
 * The image local mode falls back to when `deploy/images.env` carries no
 * usable pin.
 *
 * This is what `docker build -t … worker/` produces on a developer machine
 * today, and it is a REAL, RUNNABLE reference — unlike
 * `ghcr.io/ezilhq/ezil-os-desktop:<to be pinned by CI>`, which is what
 * `deploy/images.env` currently holds because nothing has been pushed to GHCR
 * yet. Row T3 pins the published tag; until then a fallback that exists beats
 * a reference that composes cleanly and then 404s at `docker run`.
 */
export const LOCAL_DESKTOP_IMAGE_FALLBACK = 'ezil-os-worker-sandbox:ff199202';

/** Path of the pinned-image file, relative to the repository root. */
export const IMAGES_ENV_RELATIVE_PATH = 'deploy/images.env';

/**
 * Parse `deploy/images.env`. Deliberately tiny and deliberately NOT a dotenv
 * library: the file is `KEY=value`, no quoting, no substitution, no `export`,
 * and a parser that supported more would invite a file that used more.
 * Unknown keys are kept; blank lines and `#` comments are dropped.
 */
export function parseImagesEnv(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (line === '' || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim();
        if (key === '') continue;
        out[key] = value;
    }
    return out;
}

/**
 * Docker's own tag grammar: `[A-Za-z0-9_][A-Za-z0-9._-]{0,127}`.
 *
 * 🔴 THIS IS THE GUARD THAT KEEPS A PLACEHOLDER OUT OF AN ARGV.
 * `deploy/images.env` ships `EZIL_DESKTOP_TAG=<to be pinned by CI>` on purpose.
 * Without this check that string composes into
 * `ghcr.io/ezilhq/ezil-os-desktop:<to be pinned by CI>` — a value that looks
 * exactly like configuration, passes every "is it set?" test, and fails only at
 * the moment a user tries to start their computer.
 */
export function isDockerTag(tag: string): boolean {
    return /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(tag);
}

/** A repository name: lowercase path components, optionally host-qualified. Narrow on purpose — it only ever has to accept the two names in `deploy/images.env`. */
export function isDockerImageName(name: string): boolean {
    return /^[a-z0-9]+([._-][a-z0-9]+)*(:[0-9]+)?(\/[a-z0-9]+([._-][a-z0-9]+)*)*$/.test(name);
}

export interface ResolvedImage {
    /** The reference to hand `docker run`. Always a syntactically valid `name:tag`. */
    readonly ref: string;
    /** Where it came from. `'fallback'` always carries a `reason`. */
    readonly source: 'images.env' | 'fallback';
    /** Why the file's value was not usable. Present iff `source === 'fallback'`. */
    readonly reason?: string;
}

/**
 * Resolve the desktop image from parsed `deploy/images.env` entries, or say why
 * it could not and fall back to something that actually exists.
 *
 * Never throws and never returns a malformed reference: a caller that ignores
 * `source`/`reason` still gets a runnable image, and a caller that reads them
 * can tell the user their pin was not usable.
 */
export function resolveDesktopImage(entries: Record<string, string>): ResolvedImage {
    const name = entries['EZIL_DESKTOP_IMAGE'] ?? '';
    const tag = entries['EZIL_DESKTOP_TAG'] ?? '';
    if (name === '' || tag === '') {
        return {
            ref: LOCAL_DESKTOP_IMAGE_FALLBACK,
            source: 'fallback',
            reason: `images_env_incomplete: EZIL_DESKTOP_IMAGE=${name === '' ? '(unset)' : name}, EZIL_DESKTOP_TAG=${tag === '' ? '(unset)' : tag}`,
        };
    }
    if (!isDockerImageName(name)) {
        return { ref: LOCAL_DESKTOP_IMAGE_FALLBACK, source: 'fallback', reason: `images_env_bad_image_name: '${name}'` };
    }
    if (!isDockerTag(tag)) {
        return { ref: LOCAL_DESKTOP_IMAGE_FALLBACK, source: 'fallback', reason: `images_env_bad_tag: '${tag}' is not [A-Za-z0-9_][A-Za-z0-9._-]{0,127}` };
    }
    return { ref: `${name}:${tag}`, source: 'images.env' };
}

/**
 * Read and resolve in one step. The only impure function in this module, and it
 * touches exactly one file: a missing `deploy/images.env` is the fallback path,
 * not a crash, so a user who downloaded a binary without the repository still
 * gets a working default.
 */
export async function readAndResolveDesktopImage(imagesEnvPath: string): Promise<ResolvedImage> {
    let text: string;
    try {
        text = await Bun.file(imagesEnvPath).text();
    } catch {
        return { ref: LOCAL_DESKTOP_IMAGE_FALLBACK, source: 'fallback', reason: `images_env_unreadable: ${imagesEnvPath}` };
    }
    return resolveDesktopImage(parseImagesEnv(text));
}

// ── argv builders ────────────────────────────────────────────────────────────
//
// Pure. Nothing below spawns anything. The adapter (row T2) hands these arrays
// straight to a process spawner, which is why they are ARRAYS and never
// strings: no shell is involved, so no value in them can be word-split, glob-
// expanded or command-substituted, whatever a user names their project.

export interface DockerRunSpec {
    /** The container's `--name`. The adapter derives it from the computer id. */
    readonly containerName: string;
    /** A resolved image reference — the `ref` of a `ResolvedImage`, never a raw `images.env` value. */
    readonly image: string;
    /** Local mode ships `neko` only; the parameter exists so the guacamole path is a compile error rather than a silent wrong container. */
    readonly mode: DesktopMode;
    /** Initial X screen. Defaults to `DEFAULT_SCREEN_MODE` (1920x1080). */
    readonly screen?: ScreenMode;
    /** neko's regular-user password. REQUIRED: neko's own default is the literal `neko`. */
    readonly userPassword: string;
    /** neko's admin password. REQUIRED: neko's own default is the literal `admin`. */
    readonly adminPassword: string;
    /** Absolute host path bind-mounted at `CONTAINER_WORKSPACE_PATH`. Omitted means the container's own ephemeral workspace. */
    readonly workspaceHostPath?: string;
    /** CPU quota. 2 mirrors the hosted `standard-3` instance (`worker/wrangler.toml`). */
    readonly cpus?: number;
    /** Memory limit in Docker's own syntax. `8g` mirrors `standard-3`. */
    readonly memory?: string;
    /** Anything else the host wants to pass. Merged LAST, so it can override; keys are validated. */
    readonly extraEnv?: Readonly<Record<string, string>>;
}

/** An environment variable name Docker will accept unambiguously. Rejects `=` and anything that could smuggle a second assignment. */
export function isEnvName(name: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/**
 * The complete environment local mode gives the container, as an ordered map.
 *
 * Kept separate from `buildDockerRunArgv` so a test can assert on the
 * environment without parsing argv, and so the host can log it (it holds two
 * passwords — the caller decides what is safe to print; nothing here prints).
 */
export function buildContainerEnv(spec: DockerRunSpec): Record<string, string> {
    if (spec.mode !== 'neko') {
        throw new Error(`unsupported_local_mode: '${spec.mode}' — local mode runs the neko desktop only`);
    }
    if (spec.userPassword === '' || spec.adminPassword === '') {
        // 🔴 Failing closed matters more here than anywhere else in this file.
        // An empty value does not produce a locked desktop — it produces a
        // publicly-known one. And the defaults are not merely neko's built-ins:
        // MEASURED, the pinned image ships `/etc/neko/neko.yaml` containing
        // `member.multiuser.admin_password: "admin"` and `user_password:
        // "neko"` outright, and `start-neko.sh` cds into that directory so the
        // file is loaded on every boot. Passing nothing here publishes a
        // desktop on 127.0.0.1:8181 whose password is in a public repository.
        throw new Error('missing_neko_password: both userPassword and adminPassword are required (the image\'s /etc/neko/neko.yaml sets the literals "neko"/"admin")');
    }
    const screen = spec.screen ?? DEFAULT_SCREEN_MODE;
    const env: Record<string, string> = {
        DESKTOP_MODE: spec.mode,
        NEKO_SCREEN: formatLocalNekoScreen(screen),
        [NEKO_USER_PASSWORD_ENV]: spec.userPassword,
        [NEKO_ADMIN_PASSWORD_ENV]: spec.adminPassword,
        ...NEKO_LOCAL_ICE_ENV,
    };
    if (spec.workspaceHostPath !== undefined) {
        env['EZIL_WORKSPACE_ROOT'] = CONTAINER_WORKSPACE_PATH;
    }
    for (const [key, value] of Object.entries(spec.extraEnv ?? {})) {
        if (!isEnvName(key)) throw new Error(`invalid_env_name: '${key}'`);
        env[key] = value;
    }
    return env;
}

/**
 * Build the `docker run` argv for a desktop container.
 *
 * The shape is the one already PROVEN against this image by
 * `worker/src/browser-sidecar.container.test.ts` — detached, named,
 * CPU-capped, environment by `-e`, and an explicit
 * `--entrypoint /bin/bash … -c 'DESKTOP_MODE=… bash /usr/local/bin/start-desktop.sh'`
 * rather than the image's own entrypoint. That is what the hosted Worker does
 * too (`sandbox.startProcess('DESKTOP_MODE=… bash /usr/local/bin/start-desktop.sh')`),
 * so local and hosted boot the same script the same way.
 *
 * No `--shm-size`: Chrome is launched with `--disable-dev-shm-usage`
 * (`worker/scripts/start-neko.sh`), so the 64 MB default `/dev/shm` is not on
 * the path that would need raising. No `--rm`: `terminate` removes the
 * container explicitly, and a container that died on its own must survive long
 * enough for `docker logs` to say why.
 */
export function buildDockerRunArgv(spec: DockerRunSpec): string[] {
    const env = buildContainerEnv(spec);
    const argv: string[] = ['run', '--detach', '--name', spec.containerName];

    argv.push(`--cpus=${spec.cpus ?? 2}`);
    argv.push(`--memory=${spec.memory ?? '8g'}`);

    for (const p of LOCAL_PORT_MAP) {
        argv.push('--publish', `${LOCAL_BIND_ADDRESS}:${p.host}:${p.container}/${p.protocol}`);
    }

    if (spec.workspaceHostPath !== undefined) {
        if (!spec.workspaceHostPath.startsWith('/')) {
            throw new Error(`workspace_host_path_not_absolute: '${spec.workspaceHostPath}'`);
        }
        argv.push('--volume', `${spec.workspaceHostPath}:${CONTAINER_WORKSPACE_PATH}`);
    }

    for (const [key, value] of Object.entries(env)) {
        argv.push('--env', `${key}=${value}`);
    }

    argv.push('--entrypoint', '/bin/bash', spec.image, '-c', containerBootCommand(spec.mode));
    return argv;
}

/** The in-container boot command. One definition, so local and the hosted Worker cannot drift on which script starts the desktop. */
export function containerBootCommand(mode: DesktopMode): string {
    return `DESKTOP_MODE=${mode} bash /usr/local/bin/start-desktop.sh`;
}

export interface DockerExecOptions {
    /** Wall-clock budget the CALLER enforces. Recorded on the spec, never turned into a `docker` flag — `docker exec` has none. */
    readonly timeoutMs?: number;
    /** Run as a specific user, e.g. `neko`. Omitted means the image's default. */
    readonly user?: string;
}

/**
 * Build a `docker exec` argv.
 *
 * `argv` is an ARRAY and is passed through unchanged — never joined into a
 * string and never handed to a shell. `buildFocusExecArgv` below is the one
 * caller that needs a value interpolated, and it validates against a closed
 * enum first.
 */
export function buildDockerExecArgv(containerName: string, argv: readonly string[], options: DockerExecOptions = {}): string[] {
    if (argv.length === 0) throw new Error('empty_exec_argv: docker exec needs a command');
    const out: string[] = ['exec'];
    if (options.user !== undefined) out.push('--user', options.user);
    out.push(containerName, ...argv);
    return out;
}

/**
 * The apps `/usr/local/bin/neko-switch-app.sh` knows how to foreground.
 *
 * 🔴 MIRRORED FROM `worker/src/sandbox-control.ts`'s `FOCUS_APPS`, NOT
 * IMPORTED, and the reason is measured rather than stylistic: that module
 * typechecks clean under the Worker's own tsconfig but reports two errors under
 * THIS package's `noUncheckedIndexedAccess`
 * (`sandbox-control.ts(243,21)` TS2532 and `sandbox-control.ts(415,5)` TS2322),
 * and T0 does not own that file. `./run-spec.test.ts` therefore holds the two
 * copies together by reading the upstream file's SOURCE TEXT — the same
 * technique `worker/src/screen-modes.test.ts` already uses for its own
 * cross-deploy-target twin.
 *
 * This is the WORKER's enum (both apps), not the app layer's narrowed
 * `FOCUSABLE_APPS = ['chromium']`. The narrowing is a product decision about
 * what today's image ships (`app/src/server/lib/cloudflare-guacamole-provider.ts`
 * line ~740); the primitive stays generic.
 */
export const FOCUS_APPS = ['vscode', 'chromium'] as const;
export type FocusApp = (typeof FOCUS_APPS)[number];

/** `docker exec <name> /usr/local/bin/neko-switch-app.sh <app>` — argv, so `app` is never word-split even if the enum one day gains a value with a space. */
export function buildFocusExecArgv(containerName: string, app: FocusApp, options: DockerExecOptions = {}): string[] {
    if (!(FOCUS_APPS as readonly string[]).includes(app)) {
        throw new Error(`invalid_focus_app: '${app}' (expected one of: ${FOCUS_APPS.join(', ')})`);
    }
    return buildDockerExecArgv(containerName, ['/usr/local/bin/neko-switch-app.sh', app], options);
}

// The rest of the closed `docker` verb set the `SandboxHost` interface implies.
// Here rather than in the adapter for the same reason as everything above: two
// workers, one contract.

/** `docker rm --force <name>` — the local equivalent of destroying a Durable-Object-pinned container. */
export function buildDockerRemoveArgv(containerName: string): string[] {
    return ['rm', '--force', containerName];
}

/** `docker inspect -f '{{.State.Running}}' <name>` — the cheap, non-waking status probe. Prints `true`/`false`, or exits non-zero when no such container exists. */
export function buildDockerInspectRunningArgv(containerName: string): string[] {
    return ['inspect', '--format', '{{.State.Running}}', containerName];
}

/** `docker logs --tail N <name>` — what a boot failure is diagnosed from. */
export function buildDockerLogsArgv(containerName: string, tailLines = 200): string[] {
    if (!Number.isInteger(tailLines) || tailLines <= 0) throw new Error(`invalid_tail_lines: ${tailLines}`);
    return ['logs', '--tail', String(tailLines), containerName];
}

/** `docker version --format '{{.Server.Version}}'` — the daemon-reachability probe row T5's `doctor` will use. */
export function buildDockerVersionArgv(): string[] {
    return ['version', '--format', '{{.Server.Version}}'];
}

/** `docker image inspect --format '{{.Id}}' <ref>` — "is the pinned image actually here?". */
export function buildDockerImageInspectArgv(imageRef: string): string[] {
    return ['image', 'inspect', '--format', '{{.Id}}', imageRef];
}
