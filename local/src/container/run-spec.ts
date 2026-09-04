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
export function publishedPort(name: PublishedPort['name'], offset = 0): PublishedPort {
    const hit = offsetPortMap(offset).find((p) => p.name === name);
    if (!hit) throw new Error(`local_port_map_missing: '${name}' is not in LOCAL_PORT_MAP`);
    return hit;
}

/** `http://127.0.0.1:<host port>` for a published TCP port. The local equivalent of a minted preview hostname. */
export function localUrlFor(name: PublishedPort['name'], offset = 0): string {
    const p = publishedPort(name, offset);
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
export function localIceEnvFor(muxPort: number): Readonly<Record<string, string>> {
    if (!Number.isInteger(muxPort) || muxPort < 1 || muxPort > 65535) {
        throw new Error(`invalid_mux_port: ${muxPort} is not a TCP/UDP port number`);
    }
    return Object.freeze({
        NEKO_WEBRTC_UDPMUX: String(muxPort),
        NEKO_WEBRTC_TCPMUX: String(muxPort),
        NEKO_WEBRTC_NAT1TO1: LOCAL_BIND_ADDRESS,
        NEKO_WEBRTC_ICELITE: 'true',
    });
}

/** The default local ICE environment — `localIceEnvFor(WEBRTC_MUX_PORT)`. Kept as a frozen constant because it is what every unoffset deployment gets. */
export const NEKO_LOCAL_ICE_ENV: Readonly<Record<string, string>> = localIceEnvFor(WEBRTC_MUX_PORT);

/**
 * Shift the published port map by `offset`, for a machine where a default port
 * is already taken.
 *
 * 🔴 THE MUX MOVES ON **BOTH** SIDES AND THE HTTP PORTS MOVE ON ONE, AND THAT
 * ASYMMETRY IS THE WHOLE FUNCTION. Measured against the pinned image:
 * neko logs `webrtc starting … nat1to1=127.0.0.1 tcpmux=52200 udpmux=52200`,
 * i.e. it advertises `127.0.0.1:<its own mux port>` as the ICE host candidate.
 * Publishing `127.0.0.1:62200:52200` therefore tells the browser to dial
 * `127.0.0.1:52200` while the host is listening on 62200 — a candidate that
 * points at nothing, on a path no HTTP probe can see, so every readiness check
 * still passes and the picture never arrives. The mux port is consequently
 * moved INSIDE the container too (via `localIceEnvFor`), keeping host and
 * container equal; the HTTP ports have no such constraint because the browser
 * is handed their host-side URLs explicitly.
 *
 * `offset` 0 returns `LOCAL_PORT_MAP` itself, so the default deployment is
 * byte-identical to the pinned argv.
 */
export function offsetPortMap(offset: number): readonly PublishedPort[] {
    if (!Number.isInteger(offset)) throw new Error(`invalid_port_offset: ${offset} is not an integer`);
    if (offset === 0) return LOCAL_PORT_MAP;
    return LOCAL_PORT_MAP.map((p) => {
        const host = p.host + offset;
        // The two WebRTC entries are the mux, and neko must bind the same
        // number the host publishes — see the doc comment above.
        const container = p.name === 'webrtcUdp' || p.name === 'webrtcTcp' ? p.container + offset : p.container;
        for (const n of [host, container]) {
            if (n < 1 || n > 65535) throw new Error(`port_offset_out_of_range: ${p.name} would land on ${n}`);
        }
        return { ...p, host, container };
    });
}

/** The mux port a given offset puts on both sides of the boundary. */
export function muxPortFor(offset: number): number {
    const p = offsetPortMap(offset).find((e) => e.name === 'webrtcUdp');
    if (!p) throw new Error('local_port_map_missing: webrtcUdp');
    return p.container;
}

/** The environment variable that carries the neko admin password. Read natively by neko (`--member.multiuser.admin_password`), not by `start-neko.sh`. */
export const NEKO_ADMIN_PASSWORD_ENV = 'NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD';
/** The environment variable that carries the neko user password. Read natively by neko (`--member.multiuser.user_password`). */
export const NEKO_USER_PASSWORD_ENV = 'NEKO_MEMBER_MULTIUSER_USER_PASSWORD';

/**
 * 🔴 A FALLBACK FOR AN IMAGE WHOSE LAUNCHER DOES NOT SET IT — AND THE PINNED
 * IMAGE'S LAUNCHER DOES. READ THIS WHOLE BLOCK BEFORE TRUSTING EITHER CLAIM.
 *
 * ── The thing this is about ─────────────────────────────────────────────────
 * neko is built for SHARED browsing, so control of the cursor is a
 * request/grant handshake between members. This product is a single-user
 * computer. With `session.implicit_hosting` OFF, the shipped client reduces a
 * click to `$emit('control-attempt')`, whose only effect is a shake animation
 * on `<neko-controls>` — a component `embed=1` does not even render. The
 * desktop then RENDERS PERFECTLY and silently ignores every click, and no HTTP
 * check anywhere in this repository can tell the two states apart.
 *
 * ── 🔴 THE ROW BRIEF AND ROW T1'S HAND-OFF WERE BOTH REFUTED HERE ───────────
 * Both said: the image ships `/etc/neko/neko.yaml` with
 * `session.implicit_hosting: false`, so every click is ignored unless this
 * variable is set. The first half is TRUE (the yaml really does say `false`).
 * The second half is FALSE for the pinned image, and the difference is one
 * line nobody had read: the in-image launcher passes the flag EXPLICITLY.
 *
 *     /usr/local/bin/start-neko.sh:3122   --session.implicit_hosting=true
 *
 * with its own 30-line comment naming itself "the durable fix" that
 * `enableImplicitHosting` was standing in for. Viper ranks an explicit flag
 * above the environment and the environment above a config file, so on this
 * image the flag decides and this variable decides nothing.
 *
 * MEASURED THREE WAYS against `ezil-os-worker-sandbox:ff199202` (2026-09-04),
 * reading `GET /api/room/settings` with an admin token after each boot:
 *
 *     A. no NEKO_SESSION_IMPLICIT_HOSTING at all  -> implicit_hosting: true
 *     B. NEKO_SESSION_IMPLICIT_HOSTING=false      -> implicit_hosting: true
 *     C. NEKO_SESSION_IMPLICIT_HOSTING=true       -> implicit_hosting: true
 *
 * B is the load-bearing one: the variable cannot even turn it OFF, so it is
 * inert in both directions against this image, and A is why the desktop
 * already accepted clicks before this row touched anything.
 *
 * ── So why is it set at all ────────────────────────────────────────────────
 * Because `deploy/images.env` exists precisely so the desktop image reference
 * can be repointed, and an image whose launcher does NOT pass the flag falls
 * back to the yaml's `false`. Env outranks a config file — measured on this
 * binary by row T0 with `NEKO_DESKTOP_DISPLAY` — so this variable is a real
 * belt for that image and a no-op for this one. It is cheap, it cannot make
 * anything worse (B), and the alternative is a product that silently stops
 * accepting clicks the day someone repoints the image.
 *
 * 🔴 WHAT IT IS NOT IS EVIDENCE. Setting this proves nothing about the
 * container that ran; `DockerHost.readControlMode` READS
 * `GET /api/room/settings` back and reports `'implicit'` only on a literal
 * `true`, and `local/tests/local-smoke.container.test.ts` additionally turns
 * the setting OFF on a live container and watches that read-back report
 * `'manual'`. That pair is the evidence. This constant is the ask.
 */
export const NEKO_IMPLICIT_HOSTING_ENV = 'NEKO_SESSION_IMPLICIT_HOSTING';

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
 * The image `DockerHost` runs when its constructor is handed no `image` at
 * all — its own default, and NOT a fallback for an unusable pin.
 *
 * 🔴 IT USED TO BE BOTH, AND THAT WAS THE DEFECT ROW I0c REMOVED.
 * `resolveDesktopImage` used to substitute this literal whenever
 * `deploy/images.env` carried a tag it could not use — which it did, because
 * the file shipped `EZIL_DESKTOP_TAG=<to be pinned by CI>`. Local mode
 * therefore started, every doctor line was green, and nothing anyone ran had
 * any relationship to the pinned configuration: "a value that looks like
 * configuration and is not one" (docs/CONFIDENCE-MAP.md §0.4). A resolver
 * that cannot honour the pin now says so and stops; the only way to run some
 * OTHER image is to ask for it BY NAME through `DESKTOP_IMAGE_OVERRIDE_ENV`.
 *
 * The value is what `docker build -t … worker/` produces on a developer
 * machine, so `new DockerHost()` with no options is still runnable in a test.
 *
 * 🔴 HAND-OFF (not this row's file): `local/src/host/docker-host.ts:234` does
 * `options.image ?? LOCAL_DESKTOP_IMAGE_FALLBACK` — the same silent-fallback
 * shape one layer down. `DockerHostOptions.image` should become required so
 * the production wiring cannot construct a host against a literal nobody
 * configured.
 */
export const LOCAL_DESKTOP_IMAGE_FALLBACK = 'ezil-os-worker-sandbox:ff199202';

/**
 * The ONE environment variable that overrides the pinned desktop image.
 *
 * 🔴 IT IS THE LAUNCHER'S OWN VARIABLE, ON PURPOSE — ONE NAME, ONE MEANING.
 * `deploy/launcher/ezil-os.sh:85` already reads `EZIL_LAUNCHER_IMAGE` to pick
 * which image it pulls, and then runs `bun run --cwd local doctor` and
 * `start` as child processes that inherit it. Before this row those two
 * halves disagreed: the launcher pulled the override and the host it started
 * resolved `deploy/images.env` instead, so `EZIL_LAUNCHER_IMAGE=x` pulled `x`
 * and ran something else. Honouring the same name here is what makes the
 * launcher's own documented override true end to end.
 *
 * Deliberately NOT `EZIL_DESKTOP_IMAGE`: that name is already a KEY in
 * `deploy/images.env` meaning a bare registry path with no tag. One name
 * meaning "bare path" in a file and "full name:tag" in the environment is
 * exactly the `EZIL_NEKO_IMAGE` collision row M1 logged
 * (docs/ORCHESTRATION-LOG.md, 2026-09-05 01:30Z).
 *
 * Who needs it: anyone who cannot pull `ghcr.io/ezilhq/ezil-os-desktop` —
 * the package is PRIVATE until the founder flips its visibility — and anyone
 * running an image they built themselves from `worker/Dockerfile`.
 */
export const DESKTOP_IMAGE_OVERRIDE_ENV = 'EZIL_LAUNCHER_IMAGE';

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
 * `deploy/images.env` shipped `EZIL_DESKTOP_TAG=<to be pinned by CI>` for the
 * whole of round ANYWHERE. Without this check that string composes into
 * `ghcr.io/ezilhq/ezil-os-desktop:<to be pinned by CI>` — a value that looks
 * exactly like configuration, passes every "is it set?" test, and fails only at
 * the moment a user tries to start their computer. The file now carries a real
 * pin, and this guard is what keeps the next one honest.
 */
export function isDockerTag(tag: string): boolean {
    return /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(tag);
}

/** A repository name: lowercase path components, optionally host-qualified. Narrow on purpose — it only ever has to accept the two names in `deploy/images.env`. */
export function isDockerImageName(name: string): boolean {
    return /^[a-z0-9]+([._-][a-z0-9]+)*(:[0-9]+)?(\/[a-z0-9]+([._-][a-z0-9]+)*)*$/.test(name);
}

export interface ResolvedImage {
    /**
     * The reference to hand `docker run` — a syntactically valid `name:tag`
     * when `source` is `'images.env'` or `'override'`, and the EMPTY STRING
     * when `source` is `'unresolved'`.
     *
     * 🔴 CHECK `source`, NOT TRUTHINESS OF `ref` ALONE — or use `isResolved`.
     * `ref` is typed `string` rather than `string | null` only because two
     * call sites this row does not own (`local/src/config.ts:298`,
     * `local/src/server/main.ts:61`) would not compile against a nullable
     * one; the empty string is a value no `docker` subcommand accepts, so a
     * caller that ignores `source` fails loudly at the daemon instead of
     * running the wrong image quietly.
     */
    readonly ref: string;
    /**
     * Where it came from:
     *   `'override'`    — `DESKTOP_IMAGE_OVERRIDE_ENV` was set and usable; it
     *                     wins over the file, always, and the file is not even
     *                     read for the name/tag.
     *   `'images.env'`  — the pinned `EZIL_DESKTOP_IMAGE`/`_TAG` pair.
     *   `'unresolved'`  — neither produced a usable reference. Always carries
     *                     a `reason`, and local mode must refuse to start.
     */
    readonly source: 'images.env' | 'override' | 'unresolved';
    /** Why nothing usable was produced. Present iff `source === 'unresolved'`. */
    readonly reason?: string;
}

/** `true` when this resolution names an image something can actually be asked to run. */
export function isResolved(image: ResolvedImage): boolean {
    return image.source !== 'unresolved' && image.ref !== '';
}

/**
 * The one sentence every "unresolved" reason ends with. Naming the override is
 * the difference between a user who is stuck and a user who is running.
 */
function overrideHint(): string {
    return `set ${DESKTOP_IMAGE_OVERRIDE_ENV}=<image:tag> to run an image you already have`
        + ' (the same variable `deploy/launcher/ezil-os.sh` reads), or advance the pin in'
        + ' `deploy/images.env` per that file\'s write-back rule';
}

/**
 * Resolve the desktop image from the environment override first, then from
 * parsed `deploy/images.env` entries — or say, in a named reason, why neither
 * produced a reference and refuse to name one.
 *
 * 🔴 NEVER FALLS BACK TO A LITERAL. Until row I0c it did, and a placeholder pin
 * therefore started local mode against `LOCAL_DESKTOP_IMAGE_FALLBACK` while
 * every check reported green. Configuration that cannot be honoured is a
 * failure, not a default.
 *
 * Still never throws: every caller gets a value it can report on, and the
 * `'unresolved'` branch is a decision the caller makes loudly (see
 * `local/src/doctor.ts`'s `desktop image` check), not an exception it may drop.
 *
 * `env` is a PARAMETER, not a `process.env` read inside the function, so this
 * stays pure and testable: `bun test` runs a file's cases in one process, and a
 * suite that mutated `process.env` to test the override would be order-
 * dependent.
 */
export function resolveDesktopImage(
    entries: Record<string, string>,
    env: Record<string, string | undefined> = process.env,
): ResolvedImage {
    // ── 1. The override, which wins over the file. ───────────────────────────
    // Validated with the SAME grammar as the file's pin, not waved through: an
    // override is configuration too, and `EZIL_LAUNCHER_IMAGE=ghcr.io/x/y`
    // (no tag) would silently mean `:latest` — the one tag `deploy/images.env`
    // calls a bug.
    const raw = (env[DESKTOP_IMAGE_OVERRIDE_ENV] ?? '').trim();
    if (raw !== '') {
        const cut = raw.lastIndexOf(':');
        const name = cut === -1 ? raw : raw.slice(0, cut);
        const tag = cut === -1 ? '' : raw.slice(cut + 1);
        if (cut === -1 || !isDockerImageName(name) || !isDockerTag(tag)) {
            return {
                ref: '',
                source: 'unresolved',
                reason: `override_invalid: ${DESKTOP_IMAGE_OVERRIDE_ENV}='${raw}' is not <name>:<tag>`
                    + ' (an untagged reference would mean `:latest`, which this product never pins)',
            };
        }
        return { ref: `${name}:${tag}`, source: 'override' };
    }

    // ── 2. The pin. ──────────────────────────────────────────────────────────
    const name = entries['EZIL_DESKTOP_IMAGE'] ?? '';
    const tag = entries['EZIL_DESKTOP_TAG'] ?? '';
    if (name === '' || tag === '') {
        return {
            ref: '',
            source: 'unresolved',
            reason: `images_env_incomplete: EZIL_DESKTOP_IMAGE=${name === '' ? '(unset)' : name},`
                + ` EZIL_DESKTOP_TAG=${tag === '' ? '(unset)' : tag} — ${overrideHint()}`,
        };
    }
    if (!isDockerImageName(name)) {
        return { ref: '', source: 'unresolved', reason: `images_env_bad_image_name: '${name}' — ${overrideHint()}` };
    }
    if (!isDockerTag(tag)) {
        return {
            ref: '',
            source: 'unresolved',
            reason: `images_env_bad_tag: '${tag}' is not [A-Za-z0-9_][A-Za-z0-9._-]{0,127} — ${overrideHint()}`,
        };
    }
    return { ref: `${name}:${tag}`, source: 'images.env' };
}

/**
 * Read and resolve in one step. The only impure function in this module, and it
 * touches exactly one file.
 *
 * A missing `deploy/images.env` is `'unresolved'`, not a crash and not a
 * default: a user who unpacked a release tarball without that file has no pin,
 * and telling them so (naming the override) is the only honest answer. The
 * override is still consulted first, so it works with no file at all.
 */
export async function readAndResolveDesktopImage(
    imagesEnvPath: string,
    env: Record<string, string | undefined> = process.env,
): Promise<ResolvedImage> {
    let text: string;
    try {
        text = await Bun.file(imagesEnvPath).text();
    } catch {
        // The override alone can still resolve this, so ask the resolver with
        // no entries rather than returning early.
        const fromEnv = resolveDesktopImage({}, env);
        if (fromEnv.source === 'override') return fromEnv;
        return { ref: '', source: 'unresolved', reason: `images_env_unreadable: ${imagesEnvPath} — ${overrideHint()}` };
    }
    return resolveDesktopImage(parseImagesEnv(text), env);
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
    /**
     * Shift every published port by this much, for a machine where a default is
     * already taken. Defaults to 0, which reproduces the pinned argv exactly.
     *
     * MEASURED, and the reason this exists rather than being a nicety: on the
     * development machine `supabase-kong` holds `0.0.0.0:8443` permanently, so
     * `docker run` with the default map dies with
     * `Bind for 0.0.0.0:8443 failed: port is already allocated` before the
     * image is ever started. A laptop with anything on 8443 is an ordinary
     * user. See `offsetPortMap` for why the mux moves on both sides.
     */
    readonly hostPortOffset?: number;
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
        // 🔴 ALWAYS, AND NOT CONFIGURABLE. Inert against the PINNED image
        // (whose launcher passes `--session.implicit_hosting=true` itself, and
        // an explicit flag outranks the environment — measured), and the
        // fallback that keeps clicks working on an image whose launcher does
        // not. There is no spec field to turn it off because "a computer that
        // ignores its owner" is not a mode this product has. See
        // `NEKO_IMPLICIT_HOSTING_ENV` for all three measurements.
        [NEKO_IMPLICIT_HOSTING_ENV]: 'true',
        // `localIceEnvFor(muxPortFor(0))` IS `NEKO_LOCAL_ICE_ENV`, so an
        // unoffset spec produces the identical four variables; an offset one
        // moves the mux inside the container to match what is published.
        ...localIceEnvFor(muxPortFor(spec.hostPortOffset ?? 0)),
    };
    if (spec.workspaceHostPath !== undefined) {
        env['EZIL_WORKSPACE_ROOT'] = CONTAINER_WORKSPACE_PATH;
    }
    for (const [key, value] of Object.entries(spec.extraEnv ?? {})) {
        if (!isEnvName(key)) throw new Error(`invalid_env_name: '${key}'`);
        env[key] = value;
    }
    // 🔴 `extraEnv` IS MERGED LAST SO IT CAN OVERRIDE — AND THIS IS THE ONE
    // KEY IT MAY NOT. Failing closed here rather than earlier is deliberate:
    // the check has to run AFTER the merge, because the merge is the only way
    // the value could have changed. An override that produced a
    // click-ignoring desktop would be indistinguishable from a working one to
    // every HTTP probe in this package, which is exactly the class of defect
    // this file's other fail-closed guard (the password check above) exists
    // for.
    if (env[NEKO_IMPLICIT_HOSTING_ENV] !== 'true') {
        throw new Error(
            `implicit_hosting_disabled: ${NEKO_IMPLICIT_HOSTING_ENV} must be 'true' — the image's /etc/neko/neko.yaml`
            + ' ships session.implicit_hosting: false, and on an image whose launcher does not pass'
            + ' --session.implicit_hosting itself, a desktop booted without this renders and ignores every click',
        );
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
 *
 * 🔴 THE FLAG SET WAS HANDED TO A REAL DOCKER, NOT ONLY TO A UNIT TEST.
 * `docker create` parses every flag and builds the container without starting
 * it. Against Docker 29.1.3 with `ezil-os-worker-sandbox:ff199202`, this exact
 * argv was accepted and `docker inspect` reported back what it should:
 * `Entrypoint=[/bin/bash]`,
 * `Cmd=[-c DESKTOP_MODE=neko bash /usr/local/bin/start-desktop.sh]`,
 * 6 port bindings, `NanoCpus=2000000000`, `Memory=8589934592`. The container
 * was removed immediately. That is not a boot — it does not prove the desktop
 * comes up — but it does prove no flag here is rejected, which is the failure
 * this file would otherwise hand to row T2 to discover.
 */
export function buildDockerRunArgv(spec: DockerRunSpec): string[] {
    const env = buildContainerEnv(spec);
    const argv: string[] = ['run', '--detach', '--name', spec.containerName];

    argv.push(`--cpus=${spec.cpus ?? 2}`);
    argv.push(`--memory=${spec.memory ?? '8g'}`);

    for (const p of offsetPortMap(spec.hostPortOffset ?? 0)) {
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

// ── The rest of the closed verb set (row T2) ─────────────────────────────────
//
// Same rule as everything above: the ADAPTER spawns, this module only builds
// arrays. Added by row T2 because `SandboxHost` needs them and because a second
// worker (T5's doctor) will want the same shapes.

/**
 * The character set a `computerId` may use before it is allowed anywhere near
 * an argv or a container name.
 *
 * 🔴 THIS IS A GUARD, NOT A STYLE RULE. The id is concatenated into
 * `--name ezil-os-<id>` and then into `docker exec <name> …`. Docker's own
 * name grammar is `[a-zA-Z0-9][a-zA-Z0-9_.-]*`, so a `/` or a `..` does not
 * merely produce a bad name — `docker rm -f ../../x` is a different request
 * from the one the caller made. Nothing here is passed through a shell, so
 * word-splitting is not the risk; being a DIFFERENT VALID ARGUMENT is.
 *
 * 63 characters because that is the longest label a Docker container name is
 * comfortable with once the `ezil-os-` prefix is added, and because an
 * unbounded id is an unbounded argv.
 */
export const COMPUTER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;

/** The container-name prefix. One definition, so `terminate` and `status` cannot disagree about whose container this is. */
export const CONTAINER_NAME_PREFIX = 'ezil-os-';

export function isComputerId(id: string): boolean {
    return COMPUTER_ID_PATTERN.test(id);
}

/** `ezil-os-<computerId>`. Throws on anything the pattern rejects — a bad id must never reach an argv, not even to produce a "no such container". */
export function containerNameFor(id: string): string {
    if (!isComputerId(id)) {
        throw new Error(`invalid_computer_id: '${id}' does not match ${COMPUTER_ID_PATTERN.source}`);
    }
    return `${CONTAINER_NAME_PREFIX}${id}`;
}

/**
 * `docker inspect` with ONE compound template: running state, exit code, the
 * container's environment, and the image it is actually running.
 *
 * One call rather than four because every extra `docker inspect` is another
 * process spawn on the shell's cheap status timer, and because four calls can
 * observe four different instants of a container that is exiting.
 *
 * `{{json .Config.Env}}` is how `DESKTOP_MODE` and the neko passwords are READ
 * BACK rather than assumed — see `DesktopStatus.mode` ("never a default: 'we
 * do not know' is not 'guacamole'") and `DockerHost`'s credential resolution.
 */
export function buildDockerInspectArgv(containerName: string): string[] {
    return [
        'inspect',
        '--format',
        '{{.State.Running}}\t{{.State.ExitCode}}\t{{.Config.Image}}\t{{json .Config.Env}}',
        containerName,
    ];
}

/** `docker start <name>` — bring a stopped container back with the command it was created with. */
export function buildDockerStartArgv(containerName: string): string[] {
    return ['start', containerName];
}

/**
 * `docker stop --timeout <s> <name>` — SIGTERM, then SIGKILL after the grace
 * period. The grace period is what lets `start-neko.sh`'s own `terminate_stack`
 * trap run; measured, a clean stop of the pinned image takes ~2.4s and the
 * container reports exit code 143 (128+SIGTERM), i.e. the trap fired.
 */
export function buildDockerStopArgv(containerName: string, timeoutSeconds = 20): string[] {
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 0) {
        throw new Error(`invalid_stop_timeout: ${timeoutSeconds}`);
    }
    return ['stop', '--timeout', String(timeoutSeconds), containerName];
}

/**
 * The neko user the browser auto-connects as. Mirrors
 * `composeBrowserDesktopUrl` in
 * `app/src/server/lib/cloudflare-guacamole-provider.ts`, which sets
 * `usr=EZiL` for every viewer. Known limitation carried over deliberately:
 * that provider's own doc records that a shared `usr` makes two viewers
 * indistinguishable in `GET /api/sessions`, and proposes a per-boot nonce.
 * Local mode has exactly one viewer, so the ambiguity has no instance here.
 */
export const DESKTOP_URL_USER = 'EZiL';

/**
 * Compose the browser-facing desktop URL, credential included.
 *
 * 🔴 THIS IS HOW THE PASSWORD REACHES THE BROWSER, AND IT IS NOT AN INVENTION
 * OF LOCAL MODE. Hosted, `composeBrowserDesktopUrl(rawUrl, hmacSecret,
 * sandboxId)` sets exactly `usr`, `pwd` and `embed` on the neko origin, with
 * `pwd` carrying the derived per-sandbox REGULAR-USER value (never the admin
 * one). `SandboxHost.DesktopUrls` has no password field precisely because
 * upstream has none either: the desktop URL *is* the credential envelope.
 *
 * `embed=1` is load-bearing — see the upstream doc comment: it drives neko's
 * `videoOnly`, which suppresses the third-party header/logo/chat, and it is
 * also what keeps neko's own in-video control button visible above 768px.
 */
export function composeDesktopUrl(origin: string, userPassword: string): string {
    if (userPassword === '') throw new Error('missing_neko_password: refusing to compose a desktop URL with an empty pwd');
    const url = new URL(origin);
    url.searchParams.set('usr', DESKTOP_URL_USER);
    url.searchParams.set('pwd', userPassword);
    url.searchParams.set('embed', '1');
    return url.toString();
}

/**
 * neko's own paths, measured against the pinned image rather than assumed.
 *
 *   GET  /health        -> 200, body exactly `true`.   (`/api/health` is a 404.)
 *   POST /api/login     -> 200 `{ id, token, profile:{ is_admin }, state }`.
 *   POST /api/logout    -> 200; the token is 401 afterwards.
 *   GET  /api/sessions  -> 401 without a token; the array §16b describes with one.
 *   GET  /api/room/screen  -> `{ width, height, rate }` — the OBSERVATION.
 *   POST /api/room/screen  -> 200 echoing the REQUEST. Never evidence.
 */
export const NEKO_PATHS = Object.freeze({
    health: '/health',
    login: '/api/login',
    logout: '/api/logout',
    sessions: '/api/sessions',
    screen: '/api/room/screen',
});

/** neko's screen refresh rate field. Every modeline in the image is 60Hz (mirrors `SCREEN_RATE_HZ` in `worker/src/index.ts`). */
export const NEKO_SCREEN_RATE_HZ = 60;
