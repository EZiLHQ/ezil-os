/**
 * The local ICE decision, and the one place that explains it.
 *
 * Local mode's whole WebRTC story is four environment variables and a refusal.
 * The variables are encoded in `./container/run-spec.ts` (`localIceEnvFor`),
 * because that module is the single definition of the container's environment
 * and a second copy of four names would be a second contract. This module is
 * the DECISION: which mux port, why no TURN, why `icelite`, and what a doctor
 * should tell a user who cannot see a picture. It composes run-spec; it never
 * copies it.
 *
 * ── The refusal, stated once ────────────────────────────────────────────────
 * 🔴 `checkIceConfig` FROM `worker/src/desktop-mode.ts` IS NOT IMPORTED HERE,
 * AND MUST NEVER BE. It fails closed when no TURN provider is configured. That
 * is the right answer for the hosted product — `docs/PLATFORM-NOTES.md` §6 says
 * Cloudflare Containers expose HTTP/WS only, so hosted neko has no UDP path to
 * a peer and without a relay there is genuinely no media at all. It is the
 * wrong answer here, where both peers are on loopback: there is no NAT to
 * traverse, no relay to pay for, and no credential to mint, leak or expire.
 * Importing it would make a machine with no Cloudflare account refuse to start
 * a desktop that would have worked. `./ice.test.ts` asserts on this file's
 * source text so the import cannot creep back in.
 *
 * ── What is deliberately NOT emitted ────────────────────────────────────────
 * No `NEKO_WEBRTC_ICESERVERS_FRONTEND`, no `_BACKEND`, no `NEKO_WEBRTC_ICETRICKLE`,
 * and nothing carrying a `turn:` or `turns:` URL, a username or a credential.
 * `buildNekoIceEnv` (the hosted path) emits all of those; this one emits none.
 */

import {
    LOCAL_BIND_ADDRESS,
    WEBRTC_MUX_PORT,
    localIceEnvFor,
    muxPortFor,
} from './container/run-spec.ts';

/** The env variable names local mode sets. Exported so a test can enumerate them without re-deriving the set. */
export const LOCAL_ICE_ENV_NAMES = ['NEKO_WEBRTC_UDPMUX', 'NEKO_WEBRTC_TCPMUX', 'NEKO_WEBRTC_NAT1TO1', 'NEKO_WEBRTC_ICELITE'] as const;

/**
 * Every field this module refuses to emit, as literal substrings a test can
 * look for in the produced values.
 *
 * `turn:`/`turns:`/`stun:` are URL schemes; `ICESERVERS`, `USERNAME` and
 * `CREDENTIAL` are the shapes `worker/src/desktop-mode.ts`'s `buildNekoIceEnv`
 * produces when a TURN provider IS configured. A negative assertion needs the
 * thing it is negating to be nameable, so it is named here rather than spelled
 * out inside an `expect`.
 */
export const REFUSED_ICE_FIELDS = ['turn:', 'turns:', 'stun:', 'ICESERVERS', 'ICETRICKLE', 'USERNAME', 'CREDENTIAL'] as const;

export interface LocalIceOptions {
    /**
     * The port offset the host is running with. The mux port follows it on BOTH
     * sides of the container boundary — see `offsetPortMap`'s doc comment for
     * the measurement that makes that non-negotiable.
     */
    readonly hostPortOffset?: number;
}

/**
 * The environment block a loopback deployment gives neko.
 *
 * 🔴 `NEKO_WEBRTC_NAT1TO1` IS THE LOAD-BEARING ONE AND IT IS NEVER OPTIONAL.
 * neko's `--webrtc.ip_retrieval_url` defaults to `https://checkip.amazonaws.com`
 * and is fetched **whenever `nat1to1` is unset** (the flag's own help text). A
 * product whose premise is "runs on your machine" would otherwise make a
 * hardcoded outbound call to Amazon on every boot and then advertise the user's
 * PUBLIC IP as the candidate for a peer that is on loopback — wrong twice.
 * Measured on the pinned image with this block set: zero occurrences of
 * `checkip`, `ip_retrieval` or `amazonaws` in `/tmp/neko.log`, and the positive
 * control in the same log line — `webrtc starting … nat1to1=127.0.0.1
 * tcpmux=52100 udpmux=52100 icelite=true`.
 */
export function localIceEnv(options: LocalIceOptions = {}): Readonly<Record<string, string>> {
    return localIceEnvFor(muxPortFor(options.hostPortOffset ?? 0));
}

export interface IceDescription {
    /** Short enough for a doctor line. */
    readonly summary: string;
    /** The mux port, on both sides of the container boundary. */
    readonly muxPort: number;
    /** The advertised ICE host candidate address. */
    readonly nat1to1: string;
    /** True — a lite agent gathers no candidates of its own, which is what we want when only one can ever work. */
    readonly iceLite: boolean;
    /** Always false locally. Present so a doctor prints a fact rather than an absence. */
    readonly usesTurn: boolean;
    /** Things a user should be told even though they are not failures. */
    readonly caveats: readonly string[];
}

/**
 * What row T5's `doctor` prints. Facts, and the two caveats that are true and
 * would otherwise be discovered by a user staring at a black rectangle.
 */
export function describe(options: LocalIceOptions = {}): IceDescription {
    const muxPort = muxPortFor(options.hostPortOffset ?? 0);
    return {
        summary: `loopback WebRTC: udp+tcp mux ${LOCAL_BIND_ADDRESS}:${muxPort}, nat1to1=${LOCAL_BIND_ADDRESS}, icelite, no TURN and no credential to mint`,
        muxPort,
        nat1to1: LOCAL_BIND_ADDRESS,
        iceLite: true,
        usesTurn: false,
        caveats: [
            // 🔴 MEASURED, AND THE MEASUREMENT IS THAT THE OBVIOUS FIX DOES NOT
            // WORK. The pinned image still reports
            // `iceservers-frontend=[{"urls":["stun:stun.l.google.com:19302"]}]`
            // — neko's own compiled-in default, not anything this repository
            // sets. It is served to the BROWSER, so a user on an air-gapped
            // machine has a page that tries Google on every connect. Booting
            // with `NEKO_WEBRTC_ICESERVERS_FRONTEND=[]` and `_BACKEND=[]` was
            // tried against the pinned image and changed the logged value not
            // at all, so there is no env-only fix and this row did not ship a
            // speculative one. Removing it needs either a neko flag that
            // actually takes an empty list or a config-file change in the
            // image — a hand-off, recorded here so it is visible to the doctor
            // rather than only to a log reader.
            `neko still advertises its own compiled-in default STUN server (stun.l.google.com) to the browser; measured, NEKO_WEBRTC_ICESERVERS_FRONTEND=[] does not override it. Loopback media does not need it, but an offline machine will see the browser try it.`,
            // Not a defect, but the thing a user actually hits.
            `the mux is published on ${LOCAL_BIND_ADDRESS} only, so a browser on another machine on the LAN can reach the desktop's HTTP but will never get media.`,
        ],
    };
}

/** The unoffset mux port, re-exported so a caller does not have to reach into `run-spec` for one number. */
export { WEBRTC_MUX_PORT };
