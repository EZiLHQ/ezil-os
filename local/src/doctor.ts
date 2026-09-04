/**
 * `bun run --cwd local doctor` — everything that decides whether a desktop can
 * start on THIS machine, asked before anything is started.
 *
 * ── Why a doctor exists at all ──────────────────────────────────────────────
 * Local mode's failures are all of one kind: something on the user's own
 * machine is not the way the container needs it, and the symptom arrives much
 * later and much further away. `docker run` dies with
 * `Bind for 0.0.0.0:8443 failed` after the image was pulled; the image is
 * missing and the boot panel says "your desktop isn't answering"; the shell
 * bundle is not where this package looks and `/os` is a blank page with a
 * 200. Every one of those is knowable in under a second, and none of them is
 * knowable from inside the shell.
 *
 * ── The two rules ───────────────────────────────────────────────────────────
 *
 * 1. 🔴 A CHECK ASKS THE MACHINE, IT DOES NOT ASK THE CONFIGURATION. "Is the
 *    port free" is a BIND, not a parse of `ss` output and not a look at a
 *    constant — measured on this machine, `docker-proxy` holds
 *    `0.0.0.0:8443` for `supabase-kong`, so a check that grepped for
 *    `127.0.0.1:8443` would report the port free and `docker run` would then
 *    fail on it. Same rule for the daemon (`docker version`, not "is docker
 *    installed") and the image (`docker image inspect`, not a tag string).
 *
 * 2. 🔴 WARN IS NOT A SOFTENED FAIL. A `FAIL` means "a desktop will not start,
 *    or will start wrong". A `WARN` means "this is true, you should know it,
 *    and it does not stop you" — an arm64 host running an amd64 image under
 *    emulation, or the STUN server neko advertises from its own compiled-in
 *    default. Only `FAIL` sets the exit code; a doctor whose warnings were
 *    fatal would train its user to stop reading it.
 *
 * ── Everything is injected ──────────────────────────────────────────────────
 * `runDoctor` takes its whole world as `DoctorDeps` and touches no global. That
 * is what lets `../tests/doctor.test.ts` reach the branches this machine cannot
 * produce — an unreachable daemon, an arm64 host, a missing image, a
 * read-only workspace — instead of asserting only on the happy path that
 * happens to hold here today.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { arch as osArch } from 'node:os';
import { join } from 'node:path';

import { ENV_KEYS, loadConfig, type Env, type LocalConfig } from './config.ts';
import {
    NEKO_IMPLICIT_HOSTING_ENV,
    buildContainerEnv,
    buildDockerImageInspectArgv,
    buildDockerVersionArgv,
    offsetPortMap,
    type PublishedPort,
} from './container/run-spec.ts';
import { spawnDocker, type DockerSpawn } from './host/docker-host.ts';
import { describe as describeIce } from './ice.ts';

// ── The report ───────────────────────────────────────────────────────────────

/** `FAIL` alone decides the exit code. See rule 2 in this file's header. */
export type DoctorStatus = 'PASS' | 'WARN' | 'FAIL';

export interface DoctorCheck {
    /** Short, stable, and the thing a user would search for. Asserted on by name in the tests. */
    readonly name: string;
    readonly status: DoctorStatus;
    /** What was observed, and — for a FAIL — the command or variable that fixes it. Never a secret. */
    readonly detail: string;
}

export interface DoctorReport {
    readonly checks: readonly DoctorCheck[];
    /** `0` when nothing failed. Warnings never change it. */
    readonly exitCode: number;
}

// ── Injected world ───────────────────────────────────────────────────────────

export interface DoctorDeps {
    readonly config: LocalConfig;
    /** `process.env` in production. Read for the two OPTIONAL endpoints only. */
    readonly env: Env;
    /** How `docker` is run. Same seam `DockerHost` uses, so the doctor and the adapter cannot disagree about which binary answers. */
    readonly spawn: DockerSpawn;
    /** `process.arch` in production; injected so the arm64 branch is reachable on an x86_64 box. */
    readonly arch: string;
    /** Can this TCP port be bound on loopback right now? */
    readonly tcpFree: (port: number) => boolean | Promise<boolean>;
    /** Can this UDP port be bound on loopback right now? */
    readonly udpFree: (port: number) => boolean | Promise<boolean>;
    /** Create the directory if needed and write a file in it; resolves to an error string, or `null` on success. */
    readonly probeWritable: (dir: string) => Promise<string | null>;
}

/** How long any single `docker` call may take before the doctor gives up on it. A doctor that hangs is worse than one that says "the daemon did not answer". */
export const DOCTOR_DOCKER_TIMEOUT_MS = 20_000;

// ── The checks ───────────────────────────────────────────────────────────────

/**
 * Run every check. Never throws: a doctor that crashed would be the one tool a
 * user runs when things are already broken, failing in the same way as the
 * thing they are debugging. An unexpected error inside a check becomes that
 * check's `FAIL` with the message attached.
 */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [];
    const add = (name: string, status: DoctorStatus, detail: string): void => {
        checks.push({ name, status, detail });
    };

    // ── 1. The daemon ────────────────────────────────────────────────────────
    // `docker version --format {{.Server.Version}}` and not `docker --version`:
    // the client prints its own version happily with no daemon behind it, which
    // is the exact state this check exists to catch.
    let daemonUp = false;
    try {
        const res = await deps.spawn(buildDockerVersionArgv(), { timeoutMs: DOCTOR_DOCKER_TIMEOUT_MS });
        if (res.timedOut) {
            add('docker daemon', 'FAIL', `\`docker version\` did not return within ${DOCTOR_DOCKER_TIMEOUT_MS}ms`);
        } else if (res.exitCode !== 0) {
            add('docker daemon', 'FAIL', `not reachable: ${firstLine(res.stderr || res.stdout) || `docker version exited ${res.exitCode}`}`);
        } else {
            daemonUp = true;
            add('docker daemon', 'PASS', `server ${res.stdout.trim() || '(version not reported)'}`);
        }
    } catch (err) {
        add('docker daemon', 'FAIL', `could not run docker: ${message(err)}`);
    }

    // ── 2. Host architecture ─────────────────────────────────────────────────
    // A WARN and never a FAIL. The desktop image is amd64; an arm64 host CAN
    // run it under qemu and the result is slow rather than broken, so telling
    // the user their machine is unsupported would be false.
    if (deps.arch === 'x64' || deps.arch === 'x86_64' || deps.arch === 'amd64') {
        add('host architecture', 'PASS', `${deps.arch} — native for the amd64 desktop image`);
    } else if (deps.arch === 'arm64' || deps.arch === 'aarch64') {
        add(
            'host architecture',
            'WARN',
            `${deps.arch} — the desktop image is amd64, so it runs under emulation (qemu/Rosetta).`
            + ' Expect a slow boot and a soft-decoded stream; nothing here is broken by it.',
        );
    } else {
        add('host architecture', 'WARN', `${deps.arch} — not a platform this image has been run on; treat any failure below as unexplored`);
    }

    // ── 3. The image ─────────────────────────────────────────────────────────
    // Through `config.desktopImage`, which is `deploy/images.env` resolved by
    // T0's own parser — including the documented fallback to the locally-built
    // reference when the file still carries its placeholder tag. Asking about
    // any other string would be asking about an image that will not be run.
    const image = deps.config.desktopImage;
    const imageWhy = `${image.ref} (${image.source}${image.reason ? `: ${image.reason}` : ''})`;
    if (!daemonUp) {
        add('desktop image', 'FAIL', `cannot look for ${imageWhy} — the daemon is not answering (see above)`);
    } else {
        try {
            const res = await deps.spawn(buildDockerImageInspectArgv(image.ref), { timeoutMs: DOCTOR_DOCKER_TIMEOUT_MS });
            if (res.exitCode === 0 && res.stdout.trim() !== '') {
                add('desktop image', 'PASS', `${imageWhy} present as ${res.stdout.trim().slice(0, 19)}…`);
            } else {
                add(
                    'desktop image',
                    'FAIL',
                    `${imageWhy} is not present locally — build it with \`cd worker && docker build -t ${image.ref} .\``
                    + `, or \`docker pull ${image.ref}\` once it is published`,
                );
            }
        } catch (err) {
            add('desktop image', 'FAIL', `could not inspect ${imageWhy}: ${message(err)}`);
        }
    }

    // ── 4. The published ports ───────────────────────────────────────────────
    // 🔴 THE OFFSET MAP, NOT THE CONSTANTS, AND A BIND, NOT A PARSE. This is
    // the check the row's hand-off named: `offsetPortMap(config.hostPortOffset)`
    // is what `docker run --publish` will actually ask for, and a bind is the
    // only probe that sees a WILDCARD listener (`0.0.0.0:8443`) as the conflict
    // it will be.
    const offset = deps.config.hostPortOffset;
    const busy: PublishedPort[] = [];
    for (const p of offsetPortMap(offset)) {
        const free = p.protocol === 'tcp' ? await deps.tcpFree(p.host) : await deps.udpFree(p.host);
        if (!free) busy.push(p);
    }
    if (busy.length === 0) {
        add(
            'published ports',
            'PASS',
            `all ${offsetPortMap(offset).length} free at offset ${offset}: `
            + offsetPortMap(offset).map((p) => `${p.name}:${p.host}/${p.protocol}`).join(' '),
        );
    } else {
        // Name a working offset rather than only the problem: the fix is one
        // environment variable and the user has no way to guess which value.
        const suggestion = await suggestOffset(deps, offset);
        add(
            'published ports',
            'FAIL',
            `busy at offset ${offset}: ${busy.map((p) => `${p.name}:${p.host}/${p.protocol}`).join(' ')}`
            + (suggestion === null
                ? ' — and no candidate offset was free either; stop whatever holds these ports'
                : ` — set ${ENV_KEYS.portOffset}=${suggestion} (every port is free there)`),
        );
    }

    // ── 5. This host's own HTTP port ─────────────────────────────────────────
    // Separate from the map above because it is a DIFFERENT process's port —
    // this one's — and moving it is a different variable. `0` means "any free
    // port" and is what the tests bind on, so there is nothing to check.
    if (deps.config.port === 0) {
        add('local /os port', 'PASS', `${ENV_KEYS.port}=0 — the OS picks a free port at start`);
    } else if (await deps.tcpFree(deps.config.port)) {
        add('local /os port', 'PASS', `${deps.config.bindAddress}:${deps.config.port} is free`);
    } else {
        add('local /os port', 'FAIL', `${deps.config.bindAddress}:${deps.config.port} is already in use — set ${ENV_KEYS.port} to another port`);
    }

    // ── 6/7. The two environment variables that are silent when absent ───────
    // Built through `buildContainerEnv` rather than asserted as literals: the
    // question is not "does the constant exist" but "does the environment this
    // host would actually hand `docker run` contain it". Placeholder
    // credentials, because `buildContainerEnv` fails closed on an empty
    // password and this function must never touch a real one.
    let containerEnv: Record<string, string> | null = null;
    try {
        containerEnv = buildContainerEnv({
            containerName: 'ezil-os-doctor-probe',
            image: image.ref,
            mode: 'neko',
            userPassword: DOCTOR_PLACEHOLDER_SECRET,
            adminPassword: DOCTOR_PLACEHOLDER_SECRET,
            hostPortOffset: offset,
        });
    } catch (err) {
        add('container environment', 'FAIL', `the run spec refused to build an environment: ${message(err)}`);
    }

    if (containerEnv !== null) {
        // 🔴 NEKO_WEBRTC_NAT1TO1: without it neko fetches
        // `https://checkip.amazonaws.com` on EVERY boot (its
        // `--webrtc.ip_retrieval_url` default, taken whenever nat1to1 is
        // absent) and then advertises the user's PUBLIC IP as the ICE candidate
        // for a peer that is on loopback — an outbound call nobody asked for,
        // and the wrong answer anyway.
        const nat = containerEnv['NEKO_WEBRTC_NAT1TO1'];
        add(
            'no egress for the ICE candidate',
            nat === undefined || nat === '' ? 'FAIL' : 'PASS',
            // 🔴 THE THIRD-PARTY DOMAIN IS NAMED IN THE COMMENT ABOVE AND
            // NOWHERE IN A STRING. `../server/no-hostname.test.ts` refuses a
            // literal hostname anywhere in `local/src` code — including in a
            // message that merely WARNS about one — because a grep for "does
            // this product phone home" must come back empty, and a scanner
            // cannot tell a warning's literal from a caller's. The variable
            // name is the actionable half anyway.
            nat === undefined || nat === ''
                ? 'NEKO_WEBRTC_NAT1TO1 is NOT in the container environment — neko would then fetch its own'
                    + ' default `--webrtc.ip_retrieval_url` (a third-party service) on every boot and advertise'
                    + ' the public IP it returns as the ICE candidate for a peer that is on loopback'
                : `NEKO_WEBRTC_NAT1TO1=${nat} — no outbound IP lookup on boot`,
        );

        // 🔴 NEKO_SESSION_IMPLICIT_HOSTING, AND THE ROW NAME IS CAREFUL.
        // This says the FALLBACK is set, not that clicks work. Measured, the
        // pinned image's own launcher passes `--session.implicit_hosting=true`
        // and an explicit flag outranks the environment, so on that image this
        // variable changes nothing in either direction; it is the belt for an
        // image whose launcher does not. Whether clicks ACTUALLY work is a
        // read of `GET /api/room/settings` on a RUNNING container
        // (`DockerHost.readControlMode`) and the doctor starts nothing — see
        // `NEKO_IMPLICIT_HOSTING_ENV` for all three measurements.
        const implicit = containerEnv[NEKO_IMPLICIT_HOSTING_ENV];
        add(
            'implicit-hosting fallback',
            implicit === 'true' ? 'PASS' : 'FAIL',
            implicit === 'true'
                ? `${NEKO_IMPLICIT_HOSTING_ENV}=true — set for an image whose launcher does not pass`
                    + ' --session.implicit_hosting itself (the pinned image does, so this is inert there).'
                    + ' Whether a click really controls the desktop is only knowable from a running container.'
                : `${NEKO_IMPLICIT_HOSTING_ENV} is ${implicit === undefined ? 'absent' : `'${implicit}'`};`
                    + " on an image whose launcher does not pass the flag, the baked /etc/neko/neko.yaml"
                    + ' (session.implicit_hosting: false) wins and the desktop renders while ignoring every click',
        );
    }

    // ── 8. The two optional endpoints ────────────────────────────────────────
    // `loadConfig` already THREW on a malformed one, so reaching here means
    // both parsed. The check reports which are set, because "unset" is the
    // shipped default and a user who sees a value here should recognise it as
    // their own.
    for (const [label, key, value] of [
        ['MCP endpoint', ENV_KEYS.mcpEndpoint, deps.config.mcpEndpoint],
        ['app URL', ENV_KEYS.appUrl, deps.config.appUrl],
    ] as const) {
        add(
            `no hardcoded ${label}`,
            'PASS',
            value === null ? `${key} unset — nothing in this package dials anything` : `${key}=${value} (yours, and configuration only)`,
        );
    }

    // ── 9. The workspace ─────────────────────────────────────────────────────
    // Bind-mounted into the container as the user's project tree. A path this
    // process cannot write is a container that starts and a desktop whose
    // files vanish.
    const wsError = await deps.probeWritable(deps.config.workspacePath);
    add(
        'workspace writable',
        wsError === null ? 'PASS' : 'FAIL',
        wsError === null
            ? `${deps.config.workspacePath} (bind-mounted at the container's project root)`
            : `${deps.config.workspacePath}: ${wsError} — set ${ENV_KEYS.workspace} to a directory you can write`,
    );

    // ── 10. The shell bundle ─────────────────────────────────────────────────
    // Not a container concern at all, and the reason it is here anyway: a
    // missing bundle produces `/os` with an HTTP 200 and nothing on it, which
    // is the single hardest local failure to diagnose from the browser.
    if (deps.config.shellAssetsDir === null) {
        add(
            'shell bundle',
            'FAIL',
            'bundle.min.js / bundle.min.css / icons.js were not found, so /os would answer 200 with nothing on it.'
            + ` Looked in: ${deps.config.shellAssetsSearched.join(', ')}.`
            + ` Run shell/build-shell.sh, or set ${ENV_KEYS.shellAssets}.`,
        );
    } else {
        add('shell bundle', 'PASS', deps.config.shellAssetsDir);
    }

    // ── 11. The ICE caveats ──────────────────────────────────────────────────
    // 🔴 WARN, NEVER FAIL, AND NEVER RETYPED. These are true, they are not
    // failures, and they are exactly what a user staring at a black rectangle
    // needs to be told. The text comes from `ice.describe()` so there is one
    // definition of the caveat — the STUN one in particular records a
    // MEASUREMENT (that the obvious env override does nothing) and would rot
    // instantly as a second copy.
    const ice = describeIce({ hostPortOffset: offset });
    add('WebRTC path', 'PASS', ice.summary);
    for (const caveat of ice.caveats) {
        add('WebRTC caveat', 'WARN', caveat);
    }

    return { checks, exitCode: checks.some((c) => c.status === 'FAIL') ? 1 : 0 };
}

/**
 * A placeholder credential for the environment-shape checks.
 *
 * 🔴 NEVER A REAL PASSWORD, AND NEVER PRINTED. `buildContainerEnv` fails closed
 * on an empty password, so the shape cannot be built without one — and the
 * doctor has no business deriving the real pair (that is the adapter's, minted
 * per boot from a secret this process would have to hold). This value never
 * leaves this module: only the two variable NAMES the checks are about are
 * reported, and `NEKO_WEBRTC_NAT1TO1`'s value is `127.0.0.1`, which is not a
 * secret.
 */
const DOCTOR_PLACEHOLDER_SECRET = 'doctor-probe-not-a-credential';

/** The offsets the doctor will suggest, in order. 10000 first because it is the one this repository's own container suite settled on. */
export const CANDIDATE_OFFSETS: readonly number[] = [0, 10_000, 20_000, 30_000, 40_000];

/** The first candidate offset (other than the one already tried) at which every published port binds. `null` when none does. */
async function suggestOffset(deps: DoctorDeps, tried: number): Promise<number | null> {
    for (const candidate of CANDIDATE_OFFSETS) {
        if (candidate === tried) continue;
        let ok = true;
        try {
            for (const p of offsetPortMap(candidate)) {
                const free = p.protocol === 'tcp' ? await deps.tcpFree(p.host) : await deps.udpFree(p.host);
                if (!free) { ok = false; break; }
            }
        } catch {
            // `offsetPortMap` throws for an offset that would put a port out of
            // range. That candidate is simply not a suggestion.
            ok = false;
        }
        if (ok) return candidate;
    }
    return null;
}

// ── Formatting ───────────────────────────────────────────────────────────────

/**
 * The table.
 *
 * Column-aligned on the NAME only. The detail is deliberately allowed to run
 * long and is never truncated: every FAIL detail carries the command or the
 * variable that fixes it, and a doctor that elided the fix to keep its table
 * tidy would be a doctor whose output you have to go and read the source for.
 */
export function formatDoctorTable(checks: readonly DoctorCheck[]): string {
    const width = Math.max(0, ...checks.map((c) => c.name.length));
    const lines = checks.map((c) => `  ${c.status.padEnd(4)}  ${c.name.padEnd(width)}  ${c.detail}`);
    const failed = checks.filter((c) => c.status === 'FAIL').length;
    const warned = checks.filter((c) => c.status === 'WARN').length;
    const passed = checks.length - failed - warned;
    return [
        'EZiL OS — local mode doctor',
        '',
        ...lines,
        '',
        `  ${passed} pass, ${warned} warn, ${failed} fail`,
        failed === 0
            ? '  Nothing blocks a desktop from starting on this machine.'
            : '  A desktop will NOT start until every FAIL above is resolved.',
    ].join('\n');
}

// ── Production wiring ────────────────────────────────────────────────────────

/** Can this TCP port be bound on loopback? A BIND, so a wildcard listener elsewhere on the machine counts as busy — which is what `docker run --publish` will find. */
export function tcpPortFree(port: number): boolean {
    try {
        const socket = Bun.listen({ hostname: '127.0.0.1', port, socket: { data() { /* unused */ } } });
        socket.stop(true);
        return true;
    } catch {
        return false;
    }
}

/** The UDP half. The WebRTC mux is a UDP port and a TCP probe would say nothing about it. */
export async function udpPortFree(port: number): Promise<boolean> {
    try {
        const socket = await Bun.udpSocket({ hostname: '127.0.0.1', port });
        socket.close();
        return true;
    } catch {
        return false;
    }
}

/**
 * Create the directory and write a file in it.
 *
 * 🔴 A WRITE, NOT AN `access()` CHECK. A directory can be `W_OK` and still
 * refuse a write — a full filesystem, a read-only bind mount, an SELinux label
 * — and this is the one place in the product where "it looked writable" turns
 * into a user's files quietly not being saved. The probe file is removed
 * afterwards, and a failure to remove it is not a failure to write.
 */
export async function probeDirWritable(dir: string): Promise<string | null> {
    const probe = join(dir, `.ezil-doctor-${process.pid}`);
    try {
        await mkdir(dir, { recursive: true });
        await writeFile(probe, 'ok', 'utf8');
        return null;
    } catch (err) {
        return message(err);
    } finally {
        await rm(probe, { force: true }).catch(() => { /* the write is what mattered */ });
    }
}

/** Build the production dependency set. Exported so a test can assert the wiring itself, not only the pure core. */
export async function productionDeps(env: Env = process.env): Promise<DoctorDeps> {
    return {
        config: await loadConfig(env),
        env,
        spawn: spawnDocker,
        arch: osArch(),
        tcpFree: tcpPortFree,
        udpFree: udpPortFree,
        probeWritable: probeDirWritable,
    };
}

/**
 * The entry point.
 *
 * A configuration that cannot even be READ (a malformed `EZIL_LOCAL_PORT`, a
 * non-URL `EZIL_MCP_ENDPOINT`) throws out of `loadConfig` before any check
 * runs. That is reported as a one-line FAIL rather than a stack trace, because
 * it is the same class of answer as everything else in the table: something
 * about this machine is not the way the host needs it.
 */
export async function doctorMain(env: Env = process.env): Promise<number> {
    let deps: DoctorDeps;
    try {
        deps = await productionDeps(env);
    } catch (err) {
        console.error(formatDoctorTable([{ name: 'configuration', status: 'FAIL', detail: message(err) }]));
        return 1;
    }
    const report = await runDoctor(deps);
    console.info(formatDoctorTable(report.checks));
    return report.exitCode;
}

function firstLine(text: string): string {
    return (text ?? '').trim().split('\n')[0] ?? '';
}

function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

// `import.meta.main` is true only when this file is the process entry point, so
// importing it from a test runs nothing and exits nothing.
if (import.meta.main) {
    process.exit(await doctorMain());
}
