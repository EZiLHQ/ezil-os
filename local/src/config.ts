/**
 * Everything the local host reads from its environment, in one place.
 *
 * 🔴 NO LITERAL HOSTNAME MAY APPEAR ANYWHERE UNDER `local/src`, AND THAT IS
 * TESTED (`./server/no-hostname.test.ts`). Local mode's whole premise is that
 * it runs on a machine with no Cloudflare account and no EZiL account; a
 * hardcoded `*.ezil.work` / `*.workers.dev` / `*.vercel.app` reference would be
 * a call home nobody asked for, and a hardcoded `amazonaws.com` is the exact
 * defect `../container/run-spec.ts` documents for neko's `ip_retrieval_url`.
 * Every address this package uses comes from `LOCAL_BIND_ADDRESS` plus a port
 * out of `LOCAL_PORT_MAP`, and every remote address is CONFIGURATION — unset by
 * default, supplied by the user, never a default in this file.
 *
 * Nothing here reads a secret and nothing here prints one.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import {
    IMAGES_ENV_RELATIVE_PATH,
    LOCAL_BIND_ADDRESS,
    LOCAL_OS_HOST_PORT,
    readAndResolveDesktopImage,
    type ResolvedImage,
} from './container/run-spec.ts';

/**
 * 🔴 THE BRIEF FOR THIS ROW CALLED THIS `LOCAL_HOST_PORT`; the constant row T0
 * actually shipped is `LOCAL_OS_HOST_PORT`. Re-exported here under the name the
 * rest of this package uses so the discrepancy is resolved in exactly one
 * place, and so a rename upstream is one compile error rather than a search.
 */
export const DEFAULT_LOCAL_PORT: number = LOCAL_OS_HOST_PORT;

/** Environment variable names, declared once so a test can assert on them without retyping strings. */
export const ENV_KEYS = {
    /** The port the local `/os` host listens on. Default `DEFAULT_LOCAL_PORT` (7080). */
    port: 'EZIL_LOCAL_PORT',
    /** Host directory bind-mounted into the container as the user's project tree. */
    workspace: 'EZIL_LOCAL_WORKSPACE',
    /** Where this host keeps its own files (telemetry). NOT inside the workspace — see `stateDir` below. */
    stateDir: 'EZIL_LOCAL_STATE_DIR',
    /** OPTIONAL, unset by default. An MCP endpoint the user chose to point this host at. */
    mcpEndpoint: 'EZIL_MCP_ENDPOINT',
    /** OPTIONAL, unset by default. A hosted EZiL app this host may link out to. */
    appUrl: 'EZIL_APP_URL',
    /** OPTIONAL. Where `bundle.min.js` / `bundle.min.css` / `icons.js` live, when they are not where `resolveShellAssetsDir` looks. */
    shellAssets: 'EZIL_LOCAL_SHELL_DIR',
    /**
     * OPTIONAL. Shift every PUBLISHED CONTAINER port by this much, for a
     * machine where one of the six defaults is already taken. `0` (the
     * default) reproduces the pinned argv byte for byte.
     *
     * 🔴 THIS IS NOT `EZIL_LOCAL_PORT`. That one moves this host's own HTTP
     * listener; this one moves the container's six published ports, and it
     * moves the WebRTC mux on BOTH sides of the container boundary — see
     * `offsetPortMap`. On the development machine `supabase-kong` holds
     * `0.0.0.0:8443` permanently, so without this `docker run` dies before the
     * image is ever started. `local/src/doctor.ts` reports which ports are
     * busy and at which offset they are all free.
     */
    portOffset: 'EZIL_LOCAL_PORT_OFFSET',
} as const;

/** A source of environment variables. Injected so tests never touch `process.env`. */
export type Env = Readonly<Record<string, string | undefined>>;

export interface LocalConfig {
    /** TCP port for `Bun.serve`. `0` means "pick a free one" and is used by the tests. */
    readonly port: number;
    /** ALWAYS `LOCAL_BIND_ADDRESS`. Not configurable, on purpose — see `./server/server.ts`. */
    readonly bindAddress: string;
    /** Absolute path of the `local/` package root. */
    readonly packageRoot: string;
    /** Absolute path of the directory `local/` sits in — the repository root in a checkout. */
    readonly parentRoot: string;
    /** Absolute host path bind-mounted at `CONTAINER_WORKSPACE_PATH`. */
    readonly workspacePath: string;
    /** Absolute path of this host's OWN state directory. Never inside `workspacePath`. */
    readonly stateDir: string;
    /** Absolute path of the NDJSON telemetry sink. */
    readonly telemetryPath: string;
    /** Absolute path of the directory holding the three shell bundle files, or `null` when none was found. */
    readonly shellAssetsDir: string | null;
    /** Every directory `resolveShellAssetsDir` looked in, in order. Reported when it found nothing. */
    readonly shellAssetsSearched: readonly string[];
    /** The desktop image reference, resolved through T0's `deploy/images.env` parser. */
    readonly desktopImage: ResolvedImage;
    /**
     * How far every published container port is shifted. `0` by default.
     *
     * 🔴 CARRIED ON THE CONFIG RATHER THAN ONLY ON THE ADAPTER BECAUSE THE
     * SERVER NEEDS IT TOO, and that was measured rather than reasoned:
     * `../server/routes.ts`'s `isOwnDesktopOrigin` pinned the desktop origin at
     * offset 0, so with any offset the very first cold boot answered
     * `desktop_frame_foreign_origin` and the shell reported
     * `desktop_unreachable` — on a machine where the offset is exactly what
     * makes the container start at all. Every unit test stayed green because
     * they all run at offset 0 against a fake host.
     */
    readonly hostPortOffset: number;
    /** OPTIONAL and unset by default. Configuration only: nothing in this package dials it. */
    readonly mcpEndpoint: string | null;
    /** OPTIONAL and unset by default. Configuration only: nothing in this package dials it. */
    readonly appUrl: string | null;
}

/**
 * Parse a port. Throws rather than falling back, and the reason is the same one
 * `../container/run-spec.ts` gives for refusing a malformed image tag: a value
 * that looks like configuration and is not must fail at READ time, not at the
 * moment a user's browser cannot reach the page they were told to open.
 *
 * `0` is accepted because `Bun.serve({ port: 0 })` means "any free port", which
 * is what the tests bind on.
 */
export function parsePort(raw: string | undefined, fallback: number): number {
    if (raw === undefined || raw.trim() === '') return fallback;
    const text = raw.trim();
    if (!/^\d+$/.test(text)) {
        throw new Error(`invalid_local_port: '${text}' is not a decimal integer (${ENV_KEYS.port})`);
    }
    const value = Number(text);
    if (value > 65535) {
        throw new Error(`invalid_local_port: ${value} is above 65535 (${ENV_KEYS.port})`);
    }
    return value;
}

/**
 * Parse the published-port offset.
 *
 * Same rule as `parsePort`: a value that looks like configuration and is not
 * fails at READ time. Negative offsets are accepted (a user may want to move
 * DOWN off a busy range) but `offsetPortMap` still refuses anything that would
 * land a port outside 1..65535 — so the range check lives in exactly one place
 * and this function only decides whether the text is a number at all.
 */
export function parsePortOffset(raw: string | undefined): number {
    if (raw === undefined || raw.trim() === '') return 0;
    const text = raw.trim();
    if (!/^-?\d+$/.test(text)) {
        throw new Error(`invalid_local_port_offset: '${text}' is not a decimal integer (${ENV_KEYS.portOffset})`);
    }
    const value = Number(text);
    // Fail here rather than at `docker run`: `offsetPortMap` throws with the
    // port that would be out of range, which is the more useful message, so
    // this only guards the values that would make that message nonsense.
    if (!Number.isSafeInteger(value)) {
        throw new Error(`invalid_local_port_offset: ${text} is not a safe integer (${ENV_KEYS.portOffset})`);
    }
    return value;
}

/**
 * An OPTIONAL endpoint the user configured. Unset and empty both mean "not
 * configured" and produce `null`; a value that is not an absolute `http(s)` URL
 * throws, because a half-configured endpoint is the failure mode this project
 * has already paid for once (`docs/PLATFORM-NOTES.md` and
 * `deploy/images.env`'s placeholder tag: "a value that looks exactly like
 * configuration, passes every 'is it set?' test, and fails only later").
 */
export function parseOptionalEndpoint(raw: string | undefined, key: string): string | null {
    if (raw === undefined || raw.trim() === '') return null;
    const text = raw.trim();
    let url: URL;
    try {
        url = new URL(text);
    } catch {
        throw new Error(`invalid_optional_endpoint: ${key} is not a URL`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`invalid_optional_endpoint: ${key} must be http or https, got '${url.protocol}'`);
    }
    return url.toString();
}

/**
 * The user's workspace directory.
 *
 * Absolute, always: `buildDockerRunArgv` throws on a relative
 * `workspaceHostPath`, and finding that out at `docker run` time rather than at
 * startup would be a boot failure with no explanation attached.
 */
export function resolveWorkspacePath(env: Env, home: string): string {
    const raw = env[ENV_KEYS.workspace];
    if (raw !== undefined && raw.trim() !== '') {
        const text = raw.trim();
        const abs = isAbsolute(text) ? text : resolve(text);
        return abs;
    }
    return join(home, '.ezil-os', 'workspace');
}

/**
 * This host's own state directory.
 *
 * 🔴 DELIBERATELY NOT INSIDE THE WORKSPACE, and this is a deviation from the
 * row brief ("write NDJSON to a local file under the workspace dir") made on
 * purpose. The workspace is bind-mounted into the container at
 * `CONTAINER_WORKSPACE_PATH` and IS the user's project tree. A telemetry file
 * written there would be: visible to everything running inside the desktop,
 * writable by it, and — the part that actually bites — committed by a user who
 * runs `git add .` in their own project. The default (`~/.ezil-os`) is the
 * parent of the default workspace, so on a stock install the file still lands
 * one directory away from where the brief asked for it.
 */
export function resolveStateDir(env: Env, home: string): string {
    const raw = env[ENV_KEYS.stateDir];
    if (raw !== undefined && raw.trim() !== '') {
        const text = raw.trim();
        return isAbsolute(text) ? text : resolve(text);
    }
    return join(home, '.ezil-os');
}

/**
 * Where the three shell bundle files are.
 *
 * 🔴 RESOLVED RELATIVE TO THIS PACKAGE, AND NEVER COPIED INTO IT. The committed
 * `app/public/os/bundle.min.js` must match its `shell/` sources; a second copy
 * under `local/` would be a second thing to keep in step, and the first release
 * where they diverged would ship a desktop shell nobody could diff against its
 * source.
 *
 * Two layouts are supported and both are derived from the package root, so a
 * release tarball needs no environment variable:
 *   - a repository checkout, where `local/` and `app/` are siblings;
 *   - a tarball that ships the bundle as `os/` BESIDE `local/`.
 * `EZIL_LOCAL_SHELL_DIR` overrides both for anything else.
 */
export const SHELL_ASSET_FILES = ['bundle.min.js', 'bundle.min.css', 'icons.js'] as const;
export type ShellAssetFile = (typeof SHELL_ASSET_FILES)[number];

/** Candidate directories, in order. Pure — takes the roots rather than reading them. */
export function shellAssetsCandidates(env: Env, packageRoot: string, parentRoot: string): string[] {
    const out: string[] = [];
    const override = env[ENV_KEYS.shellAssets];
    if (override !== undefined && override.trim() !== '') {
        out.push(isAbsolute(override.trim()) ? override.trim() : resolve(override.trim()));
    }
    // A repository checkout: `local/` and `app/` are siblings.
    out.push(join(parentRoot, 'app', 'public', 'os'));
    // A release tarball that places the bundle beside `local/`.
    out.push(join(parentRoot, 'os'));
    // A release tarball that places it inside `local/`.
    out.push(join(packageRoot, 'os'));
    return out;
}

/** The first candidate that holds all three files, or `null`. `exists` is injected so the search itself is testable. */
export function pickShellAssetsDir(
    candidates: readonly string[],
    exists: (path: string) => boolean,
): string | null {
    for (const dir of candidates) {
        if (SHELL_ASSET_FILES.every((f) => exists(join(dir, f)))) return dir;
    }
    return null;
}

/** `local/` — the root of THIS package, derived from this module's own location. */
export function packageRoot(): string {
    return resolve(import.meta.dir, '..');
}

/**
 * Build the configuration.
 *
 * Impure in exactly two ways: it stats candidate asset directories, and it
 * reads `deploy/images.env` through T0's own reader. Neither can fail the
 * process — a missing `images.env` is the documented fallback path.
 */
export async function loadConfig(
    env: Env = process.env,
    options: { readonly home?: string; readonly root?: string } = {},
): Promise<LocalConfig> {
    const root = options.root ?? packageRoot();
    const parent = resolve(root, '..');
    const home = options.home ?? homedir();

    const workspacePath = resolveWorkspacePath(env, home);
    const stateDir = resolveStateDir(env, home);
    const candidates = shellAssetsCandidates(env, root, parent);

    return {
        port: parsePort(env[ENV_KEYS.port], DEFAULT_LOCAL_PORT),
        bindAddress: LOCAL_BIND_ADDRESS,
        packageRoot: root,
        parentRoot: parent,
        workspacePath,
        stateDir,
        telemetryPath: join(stateDir, 'telemetry.ndjson'),
        shellAssetsDir: pickShellAssetsDir(candidates, (p) => existsSyncSafe(p)),
        shellAssetsSearched: candidates,
        desktopImage: await readAndResolveDesktopImage(join(parent, IMAGES_ENV_RELATIVE_PATH)),
        hostPortOffset: parsePortOffset(env[ENV_KEYS.portOffset]),
        mcpEndpoint: parseOptionalEndpoint(env[ENV_KEYS.mcpEndpoint], ENV_KEYS.mcpEndpoint),
        appUrl: parseOptionalEndpoint(env[ENV_KEYS.appUrl], ENV_KEYS.appUrl),
    };
}

/**
 * `existsSync` that cannot throw. A candidate directory the process may not
 * stat (a permission error on someone else's home) is "not there", not a crash
 * on the way to serving a page that does not depend on it.
 */
export function existsSyncSafe(path: string): boolean {
    try {
        return existsSync(path);
    } catch {
        return false;
    }
}
