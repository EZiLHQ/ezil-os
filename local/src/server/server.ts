/**
 * The local host: `Bun.serve` on loopback, serving `/os`, the three shell
 * bundle files, and the nine `/api/shell/*` routes.
 *
 * 🔴 IT BINDS `127.0.0.1` AND THERE IS NO WAY TO MAKE IT BIND ANYTHING ELSE.
 * That is not a default; it is a guard with a named constraint
 * (`assertLoopbackBind`) that throws, plus a bind address taken from
 * `../container/run-spec.ts`'s `LOCAL_BIND_ADDRESS` — the same constant every
 * published container port binds to, for the same reason that file gives:
 * "a desktop with an unauthenticated automation surface must not be reachable
 * from the user's LAN". This process has NO authentication of any kind (see
 * `./http.ts` for why it correctly has none), so the network boundary IS the
 * boundary. On `0.0.0.0` it would hand every device on the coffee-shop Wi-Fi a
 * button that starts, restarts and resizes the user's desktop.
 * `./loopback.test.ts` proves it, with a positive control on the same server.
 */

import { mkdir, appendFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import { renderOsDocument } from '../boot/os-document.ts';
import { ASSET_ROUTES, shellAssetResponse } from '../boot/assets.ts';
import { buildLocalComputer, type LocalComputerFacts } from '../boot/identity.ts';
import { buildLocalBootPayload } from '../boot/payload.ts';
import type { LocalConfig } from '../config.ts';
import { LOCAL_BIND_ADDRESS } from '../container/run-spec.ts';
import type { ShellBootComputer } from '../contract/shell-api.ts';
import type { SandboxHost } from '../host/sandbox-host.ts';
import { shellError, shellThrownResponse } from './http.ts';
import { shellRoutes, type FrameProbe, type ShellRouterDeps } from './routes.ts';

/**
 * The only addresses this server will bind.
 *
 * `::1` is included because a machine with IPv6-only loopback exists; nothing
 * else is, and in particular `0.0.0.0`, `::` and a LAN address are not. A
 * hostname (`localhost`) is deliberately absent: it is resolved through
 * `/etc/hosts` and DNS, so what it points at is not a property of this code.
 */
export const LOOPBACK_BIND_ADDRESSES: readonly string[] = Object.freeze([LOCAL_BIND_ADDRESS, '::1']);

/**
 * Refuse to listen anywhere a second machine could reach.
 *
 * Throws with the constraint's own name so a test can assert on WHICH rule
 * fired rather than on "it threw".
 */
export function assertLoopbackBind(address: string): void {
    if (!LOOPBACK_BIND_ADDRESSES.includes(address)) {
        throw new Error(
            `refusing_non_loopback_bind: '${address}' is not a loopback address.`
            + ' The local host has no authentication, so anything that can reach it can start,'
            + ' restart and resize the desktop. Allowed: '
            + LOOPBACK_BIND_ADDRESSES.join(', '),
        );
    }
}

// ── The one computer's mutable facts ─────────────────────────────────────────

/**
 * The state a hosted deployment keeps in Postgres, kept in this process
 * instead.
 *
 * Three fields, and each is a fact this host can actually observe:
 * `createdAt` is the workspace directory's own birth time, `isNew` is whether
 * THIS process created it, and `lastOpenedAt` is when the desktop was opened
 * through this host. Nothing here is durable, and that is honest: a restarted
 * host genuinely does not know when the desktop was last opened, and inventing
 * a value would be worse than `null`.
 */
export class LocalComputerState {
    readonly workspacePath: string;
    readonly createdAt: string;
    private newLatch: boolean;
    private lastOpenedAt: string | null = null;
    private lastActivityAt: number | null = null;

    constructor(workspacePath: string, createdAt: string, createdThisBoot: boolean) {
        this.workspacePath = workspacePath;
        this.createdAt = createdAt;
        this.newLatch = createdThisBoot;
    }

    /**
     * 🔴 `isNew` IS A ONE-SHOT LATCH, matching the hosted meaning exactly:
     * "True only when THIS boot created the row". `getOrCreateDefault` returns
     * `created: true` once and `false` for every call after it, so a second
     * payload built in the same process must not keep claiming the workspace is
     * one second old.
     */
    snapshot(): ShellBootComputer {
        const facts: LocalComputerFacts = {
            workspacePath: this.workspacePath,
            createdAt: this.createdAt,
            lastOpenedAt: this.lastOpenedAt,
            isNew: this.newLatch,
        };
        const computer = buildLocalComputer(facts);
        this.newLatch = false;
        return computer;
    }

    /** The id, without consuming the `isNew` latch. Every route's gate reads this. */
    id(): string {
        return buildLocalComputer({
            workspacePath: this.workspacePath,
            createdAt: this.createdAt,
            lastOpenedAt: this.lastOpenedAt,
            isNew: false,
        }).id;
    }

    markOpened(now = Date.now()): void {
        this.lastOpenedAt = new Date(now).toISOString();
    }

    recordActivity(lastInputAgoMs: number, now = Date.now()): void {
        this.lastActivityAt = now - lastInputAgoMs;
    }

    /** For a future local idle policy, and for the startup line. Read by nothing today, which is why it is not on the wire. */
    presenceAt(): number | null {
        return this.lastActivityAt;
    }
}

/**
 * Create the workspace if it is not there, and report whether THIS call made it.
 *
 * `mkdir(recursive)` returns the first path it created and `undefined` when it
 * created nothing, which is exactly the `isNew` question — asked of the
 * filesystem rather than inferred from a stat race.
 */
export async function ensureWorkspace(
    workspacePath: string,
): Promise<{ readonly createdAt: string; readonly createdThisBoot: boolean }> {
    const made = await mkdir(workspacePath, { recursive: true });
    const st = await stat(workspacePath);
    // `birthtimeMs` is 0 on filesystems that do not record it; `ctimeMs` is the
    // honest fallback and is never 0 for a directory that exists.
    const born = st.birthtimeMs > 0 ? st.birthtimeMs : st.ctimeMs;
    return { createdAt: new Date(born).toISOString(), createdThisBoot: made !== undefined };
}

// ── The server ───────────────────────────────────────────────────────────────

export interface LocalServerOptions {
    readonly config: LocalConfig;
    /** The desktop runtime. Row T2's Docker adapter in production; `./fake-host.ts` in tests. */
    readonly host: SandboxHost;
    /** Overridable for tests. Defaults to a real GET at the desktop origin. */
    readonly probeFrame?: (url: string) => Promise<FrameProbe>;
    /** Overridable for tests so nothing writes to a user's home directory. */
    readonly telemetrySink?: (record: unknown) => Promise<void>;
}

export interface LocalServer {
    readonly port: number;
    readonly bindAddress: string;
    /** `http://127.0.0.1:<port>` — composed from the bind address, never a literal. */
    readonly url: string;
    readonly computer: LocalComputerState;
    stop(): Promise<void>;
}

/**
 * Append one telemetry batch as a line of NDJSON.
 *
 * 🔴 A FILE ON THIS MACHINE, NEVER A REQUEST. The hosted route writes to
 * Postgres and the shell cannot tell the difference — it always gets a 202.
 * Local mode must never turn a user's crash events into outbound traffic; that
 * is the single thing this product's premise would not survive.
 */
export function fileTelemetrySink(telemetryPath: string): (record: unknown) => Promise<void> {
    return async (record: unknown) => {
        await mkdir(dirname(telemetryPath), { recursive: true });
        await appendFile(telemetryPath, `${JSON.stringify(record)}\n`, 'utf8');
    };
}

/** `/` sends the browser to `/os` with a real 302, which the browser follows as a DOCUMENT LOAD — the one way `/os` may be entered (`docs/PLATFORM-NOTES.md` §17). */
const OS_PATH = '/os';

export async function startLocalServer(options: LocalServerOptions): Promise<LocalServer> {
    const { config, host } = options;

    assertLoopbackBind(config.bindAddress);

    const { createdAt, createdThisBoot } = await ensureWorkspace(config.workspacePath);
    const computerState = new LocalComputerState(config.workspacePath, createdAt, createdThisBoot);

    const appendTelemetry = options.telemetrySink ?? fileTelemetrySink(config.telemetryPath);
    const routes = shellRoutes();

    const deps: ShellRouterDeps = {
        host,
        // 🔴 TWO ACCESSORS, ON PURPOSE. The gate runs on every request
        // (including the two-second status poll) and must not consume the
        // `isNew` latch; only the routes that actually emit a payload may.
        // `LocalComputerState` stays the one owner of that latch.
        computerId: () => computerState.id(),
        bootComputer: () => computerState.snapshot(),
        markOpened: () => computerState.markOpened(),
        recordActivity: (ago) => computerState.recordActivity(ago),
        appendTelemetry,
        ...(options.probeFrame === undefined ? {} : { probeFrame: options.probeFrame }),
    };

    const server = Bun.serve({
        hostname: config.bindAddress,
        port: config.port,
        // Long enough for a cold container boot. The hosted routes declare
        // `maxDuration = 300` for exactly this (`docs/PLATFORM-NOTES.md` §13:
        // a cold boot is ~22-24s and the platform default would kill the
        // request first); Bun's own default is 10s, which would do the same.
        idleTimeout: 255,
        fetch: async (req: Request): Promise<Response> => {
            const url = new URL(req.url);
            const path = url.pathname;

            try {
                if (path === '/' && req.method === 'GET') {
                    return Response.redirect(new URL(OS_PATH, url).toString(), 302);
                }

                if (path === OS_PATH) {
                    if (req.method !== 'GET') return shellError('METHOD_NOT_SUPPORTED', 'GET only.');
                    return osDocumentResponse(computerState);
                }

                const assetFile = ASSET_ROUTES[path];
                if (assetFile !== undefined) {
                    if (req.method !== 'GET') return shellError('METHOD_NOT_SUPPORTED', 'GET only.');
                    if (config.shellAssetsDir === null) {
                        return shellError(
                            'NOT_FOUND',
                            `Shell bundle not found. Looked in: ${config.shellAssetsSearched.join(', ')}`,
                        );
                    }
                    const res = shellAssetResponse(config.shellAssetsDir, assetFile, req);
                    return res ?? shellError('NOT_FOUND', `${assetFile} is not in ${config.shellAssetsDir}`);
                }

                const route = routes[path];
                if (route !== undefined) {
                    if (!route.methods.includes(req.method)) {
                        return shellError('METHOD_NOT_SUPPORTED', `${req.method} is not allowed here.`);
                    }
                    return await route.handle(req, deps);
                }

                return shellError('NOT_FOUND', `No route for ${req.method} ${path}.`);
            } catch (err) {
                return shellThrownResponse(err, `${req.method} ${path}`);
            }
        },
    });

    // `Bun.serve` types `port` as optional because a unix-socket server has
    // none. This one always has a TCP port, and a server that came up without
    // one is a state nothing downstream could act on — so it is an error here
    // rather than an `undefined` that surfaces as an unreachable URL later.
    const boundPort = server.port;
    if (typeof boundPort !== 'number') {
        await server.stop(true);
        throw new Error('local_server_no_port: Bun.serve reported no TCP port');
    }

    return {
        port: boundPort,
        bindAddress: config.bindAddress,
        url: localServerUrl(config.bindAddress, boundPort),
        computer: computerState,
        stop: async () => {
            await server.stop(true);
        },
    };
}

/** `http://<addr>:<port>`, bracketing an IPv6 literal so the result is a URL and not a string that only looks like one. */
export function localServerUrl(address: string, port: number): string {
    const host = address.includes(':') ? `[${address}]` : address;
    return `http://${host}:${port}`;
}

/** The `/os` document, never cached: the payload is per-boot and carries `isNew`. */
function osDocumentResponse(state: LocalComputerState): Response {
    const html = renderOsDocument(buildLocalBootPayload(state.snapshot()));
    return new Response(html, {
        status: 200,
        headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store, no-cache, must-revalidate',
        },
    });
}
