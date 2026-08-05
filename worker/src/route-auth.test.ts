/**
 * Route-level tests against the Worker's REAL `fetch()` entrypoint.
 *
 * Every other test in this package exercises a pure submodule, so nothing
 * proved that the route TABLE in `./index.ts` actually calls the authorizer it
 * is supposed to. That gap is exactly how `DELETE /sandbox/:name` shipped with
 * no authorization at all while every `/project-files/*` route had one — a
 * fully green suite coexisted with a live, exploitable, unauthenticated
 * destructive endpoint (see `docs/PLATFORM-NOTES.md`, "Verify the claim, not
 * the code").
 *
 * `./index.ts` cannot normally be imported under `bun test` because
 * `@cloudflare/sandbox` imports `cloudflare:workers`, which only resolves
 * inside the Workers runtime. `mock.module()` supplies that specifier, after
 * which `default.fetch(request, env)` runs the genuine route table — the same
 * regex matching, the same ordering, the same handlers. Only the Durable
 * Object namespace is faked (`fakeSandboxNamespace` below), and it RECORDS
 * every call, so "the handler was never reached" is an assertion rather than
 * an inference.
 *
 * This is not a substitute for the workerd boot test (`./boot.test.ts`) — that
 * one proves the entrypoint starts; this one proves what it routes.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';

// Must be registered before `./index.ts` is imported (see module doc). The
// shapes are only what `@cloudflare/sandbox` destructures at import time.
mock.module('cloudflare:workers', () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
  RpcTarget: class {},
  RpcStub: class {},
  env: {},
}));

import { hmacSha256Hex, PREVIEW_TOKEN_PAYLOAD, TOKEN_MAX_AGE_MS } from './hmac';

const SECRET = 'route-auth-test-secret';
const SANDBOX_NAME = 'guac-abcdef0123456789-fedcba9876543210';

/** Mint the SAME `t=<unix_ms>,v1=<hex>` envelope `/sandbox/preview` uses. */
async function mintToken(secret = SECRET, now = Date.now()): Promise<string> {
  return `t=${now},v1=${await hmacSha256Hex(secret, PREVIEW_TOKEN_PAYLOAD(now))}`;
}

interface CallLog {
  terminateSandbox: number;
  restartDesktopStack: Array<{ hostname: string; sandboxId: string; explicitMode: unknown; fallbackMode: unknown }>;
  destroy: number;
  flushWorkspaceNow: number;
  getExposedPorts: number;
  exec: number;
  /** Every `containerFetch(url, init, port)` the route table actually made. */
  containerFetch: Array<{ url: string; port: number; headers: Record<string, string> }>;
  /**
   * Every request that reached the Durable Object's HTTP entrypoint
   * (`stub.fetch`) — i.e. what the SDK's REAL `wsConnect()` delivered after its
   * own `switchPort()` ran. `port` is resolved exactly the way
   * `Sandbox.fetch` + `Container.fetch` resolve it, so a handler that loses the
   * upgrade headers is recorded as hitting port 3000, not 8443.
   */
  wsConnect: Array<{ url: string; port: number; method: string; headers: Record<string, string> }>;
  /** Every `exposePort(port, {hostname, token})` the route table actually made. */
  exposePort: Array<{ port: number; token: string; hostname: string }>;
}

/** Opaque stand-in for a `WebSocket`; only its identity is ever compared. */
const FAKE_UPSTREAM_WS = { id: 'upstream-ws' } as unknown as WebSocket;

/**
 * code-server's `authenticateOrigin` (`src/node/http.ts`), ported faithfully —
 * duplicated from `preview-bridge.test.ts` on purpose so each test module stays
 * self-contained. Runs on code-server's WS router only, which is why the editor
 * renders fine over HTTP and only the sockets 403.
 *
 * `getHost()` honours `Forwarded`, then `X-Forwarded-Host`, then `Host`.
 * Throws on rejection; code-server maps that to HTTP 403.
 */
function simulateCodeServerEnsureOrigin(headers: Record<string, string>, origin: string | null): void {
  if (!origin) return;
  const originHost = new URL(origin).host.trim().toLowerCase();
  let host: string | undefined;
  if (headers['forwarded'] !== undefined) {
    host = /host="?([^";]+)"?/.exec(headers['forwarded'])?.[1]?.trim().toLowerCase();
  } else if (headers['x-forwarded-host'] !== undefined && headers['x-forwarded-host'] !== '') {
    host = headers['x-forwarded-host'].split(',')[0]?.trim().toLowerCase();
  } else {
    host = headers['host'];
  }
  if (host === undefined) throw new Error('no host headers found');
  if (host !== originHost) throw new Error(`incorrect origin: ${originHost} does not match host ${host}`);
}

/**
 * A fake `DurableObjectNamespace` whose stub answers the handful of RPCs the
 * routes under test call, records every invocation, and returns a function for
 * anything else the SDK pokes at (`configure`, etc.).
 */
function fakeSandboxNamespace(options: {
  exposedPorts?: Array<{ port: number; url: string; status: string }>;
  terminateResult?: Record<string, unknown>;
  /** Upstream response the fake container returns for `containerFetch`. */
  containerResponse?: () => Response;
  /**
   * Opt in to a container fake complete enough for `ensureDesktop` to run to
   * completion (`startProcess`/`waitForPort`/`exposePort`), so `POST
   * /sandbox/preview` can be exercised end to end. Return `false` for a port
   * to make that ONE exposure fail the way the real SDK does (throw), which
   * is how the app/code best-effort branches are reached without also killing
   * the mandatory desktop-port exposure.
   */
  exposePort?: (port: number) => boolean;
  /**
   * Canned response for `restartDesktopStack` — this fake stands in for the
   * WHOLE Durable Object (see this function's own doc comment), so it is the
   * DO's `restartDesktopStack` RPC method itself that is replaced here, not
   * the real one's internals. What THOSE internals do (`listProcesses` /
   * `killProcess` / `getProcess` / `unexposePort` / `ensureDesktop`) is
   * covered by the pure decision helpers in `sandbox-control.test.ts`
   * (`buildRestartReport`, `findDesktopLauncherProcess`) — exactly the same
   * split `terminateSandbox`/`buildTerminateReport` already uses. This block
   * only proves the ROUTE TABLE (auth, kill switch, response mapping).
   */
  restartResult?: Record<string, unknown>;
  /**
   * When set, any `exec()` command touching the container's boot-telemetry
   * NDJSON path (`ezil-telemetry.ndjson` — see `drainContainerBootTelemetry`,
   * `./index.ts`) returns this as `stdout` instead of the default `''`. Lets a
   * test prove boot-phase data actually reaches `spoolTelemetry()`.
   */
  containerTelemetryNdjson?: string;
}): { binding: unknown; calls: CallLog } {
  /** The sandbox id the Worker actually opened the DO with. */
  let openedWith = SANDBOX_NAME;
  const calls: CallLog = {
    terminateSandbox: 0,
    restartDesktopStack: [],
    destroy: 0,
    flushWorkspaceNow: 0,
    getExposedPorts: 0,
    exec: 0,
    containerFetch: [],
    wsConnect: [],
    exposePort: [],
  };

  const impl: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    containerFetch: async (...args: unknown[]) => {
      const [url, init, port] = args as [string, RequestInit | undefined, number];
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => {
        headers[k] = v;
      });
      calls.containerFetch.push({ url, port, headers });
      // 🔴 `containerFetch` is a Durable Object JSRPC method. When the
      // container answers an upgrade it returns 101 + `webSocket`, and that
      // return value cannot be serialized back across the RPC boundary —
      // workerd rejects the call with exactly this message (reproduced against
      // real workerd, and observed in production as a 502 on every code-server
      // socket). Modelling it here is what makes the WebSocket tests below
      // able to fail: the previous fake returned a bare
      // `new Response(null, {status: 101})`, the one shape RPC *can* carry and
      // the one shape production can never produce.
      if ((headers.upgrade ?? '').toLowerCase() === 'websocket') {
        throw new Error(
          'Could not serialize object of type "WebSocket". This type does not support serialization.',
        );
      }
      return (
        options.containerResponse?.() ??
        new Response('<html><head></head><body>upstream</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      );
    },
    // The Durable Object's HTTP entrypoint. Note this is NOT a stand-in for
    // `wsConnect()`: `getSandbox()` supplies the REAL `wsConnect`, which is
    // `switchPort()` + `stub.fetch()`, so the SDK's own implementation runs and
    // only this last hop is faked. Unlike a JSRPC method, this boundary CAN
    // carry a 101 + `webSocket` — it is the same one the working neko desktop
    // stream crosses, and a raw HTTP/1.1 upgrade through this exact shape was
    // verified end to end against real workerd.
    //
    // Port resolution mirrors `Sandbox.fetch` -> `Container.fetch` exactly,
    // including the trap: the WebSocket branch requires BOTH `Upgrade:
    // websocket` and a `Connection` containing `upgrade`, and anything that
    // misses it silently falls back to `determinePort(url)` — 3000, the SDK's
    // own control plane. A handler that drops either header is therefore
    // recorded here as talking to port 3000, not to the bridge port.
    fetch: async (...args: unknown[]) => {
      const [request] = args as [Request];
      const headers: Record<string, string> = {};
      request.headers.forEach((v, k) => {
        headers[k] = v;
      });
      const takesUpgradeBranch =
        (headers.upgrade ?? '').toLowerCase() === 'websocket' &&
        (headers.connection ?? '').toLowerCase().includes('upgrade');
      const proxyMatch = /^\/proxy\/(\d+)/.exec(new URL(request.url).pathname);
      const port = takesUpgradeBranch
        ? Number(headers['cf-container-target-port'])
        : proxyMatch
          ? Number(proxyMatch[1])
          : 3000;
      calls.wsConnect.push({ url: request.url, port, method: request.method, headers });
      if (!takesUpgradeBranch) {
        return new Response('sandbox control plane, not the bridge port', { status: 404 });
      }
      const res = new Response(null, { status: 101 });
      Object.defineProperty(res, 'webSocket', { value: FAKE_UPSTREAM_WS, configurable: true });
      return res;
    },
    terminateSandbox: async () => {
      calls.terminateSandbox++;
      return (
        options.terminateResult ?? {
          ok: true,
          terminated: true,
          stopped: true,
          outcome: 'destroyed',
          wasRunning: true,
          runningAfter: false,
        }
      );
    },
    restartDesktopStack: async (...args: unknown[]) => {
      const [hostname, sandboxId, explicitMode, fallbackMode] = args as [string, string, unknown, unknown];
      calls.restartDesktopStack.push({ hostname, sandboxId, explicitMode, fallbackMode });
      return (
        options.restartResult ?? {
          ok: true,
          mode: 'neko',
          outcome: 'restarted',
          wasRunning: true,
          stopConfirmed: true,
          bootOk: true,
        }
      );
    },
    destroy: async () => {
      calls.destroy++;
    },
    flushWorkspaceNow: async () => {
      calls.flushWorkspaceNow++;
      return {};
    },
    getExposedPorts: async () => {
      calls.getExposedPorts++;
      return options.exposedPorts ?? [];
    },
    exec: async (...args: unknown[]) => {
      calls.exec++;
      const [command] = args as [string | undefined];
      if (
        options.containerTelemetryNdjson !== undefined &&
        typeof command === 'string' &&
        command.includes('ezil-telemetry.ndjson')
      ) {
        return { exitCode: 0, stdout: options.containerTelemetryNdjson, stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    // Only wired when `options.exposePort` is supplied — otherwise the Proxy's
    // `async () => undefined` default keeps every pre-existing test's
    // behaviour byte-identical.
    ...(options.exposePort
      ? {
          startProcess: async () => ({
            waitForPort: async () => undefined,
            getLogs: async () => ({ stdout: '', stderr: '' }),
          }),
          exposePort: async (...args: unknown[]) => {
            const [port, opts] = args as [number, { hostname: string; token: string }];
            if (!options.exposePort!(port)) {
              throw new Error(`fake exposePort refused port ${port}`);
            }
            calls.exposePort.push({ port, token: opts.token, hostname: opts.hostname });
            // Compose the hostname the same way the real SDK does — from the
            // sandbox id the Worker actually opened the DO with, NOT a test
            // constant. `handlePreviewBootstrap` re-parses that id out of the
            // hostname and verifies the bootstrap token against it, so a fake
            // that invents an id would make the round-trip test below pass or
            // fail for the wrong reason.
            return { url: `https://${port}-${openedWith}-${opts.token}.${opts.hostname}` };
          },
        }
      : {}),
  };

  const stub = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== 'string' || prop === 'then') return undefined;
        if (prop in impl) return impl[prop];
        return async () => undefined;
      },
    },
  );

  return {
    binding: {
      idFromName: (name: string) => {
        openedWith = name;
        return { name };
      },
      get: () => stub,
    },
    calls,
  };
}

async function loadWorker(): Promise<{ fetch(request: Request, env: unknown): Promise<Response> }> {
  const mod = (await import('./index')) as unknown as {
    default: { fetch(request: Request, env: unknown): Promise<Response> };
  };
  return mod.default;
}

let worker: { fetch(request: Request, env: unknown): Promise<Response> };

beforeEach(async () => {
  worker = await loadWorker();
});

// ── DELETE /sandbox/:name — the exploitable defect ──────────────────────────

describe('DELETE /sandbox/:name is HMAC-gated', () => {
  it('REJECTS an unsigned DELETE with 401 and never reaches the sandbox', async () => {
    const { binding, calls } = fakeSandboxNamespace({});
    const res = await worker.fetch(
      new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}`, { method: 'DELETE' }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('hmac_required');
    // The whole point: no teardown work happened.
    expect(calls.terminateSandbox).toBe(0);
    expect(calls.destroy).toBe(0);
    expect(calls.flushWorkspaceNow).toBe(0);
  });

  it('ACCEPTS a signed DELETE via `Authorization: Bearer` and terminates', async () => {
    const { binding, calls } = fakeSandboxNamespace({});
    const res = await worker.fetch(
      new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${await mintToken()}` },
      }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.terminated).toBe(true);
    expect(body.outcome).toBe('destroyed');
    expect(body.sandboxName).toBe(SANDBOX_NAME);
    expect(calls.terminateSandbox).toBe(1);
  });

  it('ACCEPTS a signed DELETE via `?token=` (the /preview-bootstrap precedent)', async () => {
    const { binding, calls } = fakeSandboxNamespace({});
    const token = encodeURIComponent(await mintToken());
    const res = await worker.fetch(
      new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}?token=${token}`, { method: 'DELETE' }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );
    expect(res.status).toBe(200);
    expect(calls.terminateSandbox).toBe(1);
  });

  it('ACCEPTS a signed DELETE via a JSON body `{token}` (same envelope as every POST route)', async () => {
    const { binding, calls } = fakeSandboxNamespace({});
    const res = await worker.fetch(
      new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}`, {
        method: 'DELETE',
        body: JSON.stringify({ token: await mintToken() }),
      }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );
    expect(res.status).toBe(200);
    expect(calls.terminateSandbox).toBe(1);
  });

  it('rejects a token signed with the WRONG secret', async () => {
    const { binding, calls } = fakeSandboxNamespace({});
    const res = await worker.fetch(
      new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${await mintToken('a-different-secret')}` },
      }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );
    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toBe('hmac_signature_mismatch');
    expect(calls.terminateSandbox).toBe(0);
  });

  it('rejects an EXPIRED token (replay of a captured signature)', async () => {
    const { binding, calls } = fakeSandboxNamespace({});
    const stale = await mintToken(SECRET, Date.now() - TOKEN_MAX_AGE_MS - 60_000);
    const res = await worker.fetch(
      new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${stale}` },
      }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );
    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toBe('hmac_token_expired');
    expect(calls.terminateSandbox).toBe(0);
  });

  it('rejects a malformed token', async () => {
    const { binding, calls } = fakeSandboxNamespace({});
    const res = await worker.fetch(
      new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer not-a-token' },
      }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );
    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toBe('hmac_malformed_token');
    expect(calls.terminateSandbox).toBe(0);
  });

  it('accepts the compatibility secret name and the additive mission alias', async () => {
    for (const env of [
      { CLOUDFLARE_GUACAMOLE_HMAC_SECRET: SECRET },
      { SANDBOX_HMAC_SECRET: 'primary', SANDBOX_MISSION_HMAC_SECRET: SECRET },
    ]) {
      const { binding, calls } = fakeSandboxNamespace({});
      const res = await worker.fetch(
        new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${await mintToken()}` },
        }),
        { Sandbox: binding, ...env },
      );
      expect(res.status).toBe(200);
      expect(calls.terminateSandbox).toBe(1);
    }
  });

  it('a malformed JSON body does not bypass auth (parse failure is not an allow)', async () => {
    const { binding, calls } = fakeSandboxNamespace({});
    const res = await worker.fetch(
      new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}`, {
        method: 'DELETE',
        body: '{not json',
      }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );
    expect(res.status).toBe(401);
    expect(calls.terminateSandbox).toBe(0);
  });

  it('still works keyless in local dev (no secret configured), unchanged', async () => {
    const { binding, calls } = fakeSandboxNamespace({});
    const res = await worker.fetch(
      new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}`, { method: 'DELETE' }),
      { Sandbox: binding },
    );
    expect(res.status).toBe(200);
    expect(calls.terminateSandbox).toBe(1);
  });
});

// ── DELETE honesty ──────────────────────────────────────────────────────────

describe('DELETE /sandbox/:name reports what actually happened', () => {
  it('does NOT claim terminated for a name that had nothing running (the live wrong-name case)', async () => {
    const { binding } = fakeSandboxNamespace({
      terminateResult: {
        ok: true,
        terminated: false,
        stopped: true,
        outcome: 'not_running',
        wasRunning: false,
        runningAfter: false,
      },
    });
    const res = await worker.fetch(
      new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}-nekodesktop`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${await mintToken()}` },
      }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.terminated).toBe(false);
    expect(body.outcome).toBe('not_running');
    expect(body.wasRunning).toBe(false);
  });

  it('is a 500 when the container is still running after destroy()', async () => {
    const { binding } = fakeSandboxNamespace({
      terminateResult: {
        ok: false,
        terminated: false,
        stopped: false,
        outcome: 'still_running',
        wasRunning: true,
        runningAfter: true,
        error: 'container_still_running_after_destroy',
      },
    });
    const res = await worker.fetch(
      new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${await mintToken()}` },
      }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.terminated).toBe(false);
    expect(body.outcome).toBe('still_running');
  });

  it('keeps `mode: "production"` on the wire (unknown external consumers)', async () => {
    const { binding } = fakeSandboxNamespace({});
    const res = await worker.fetch(
      new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${await mintToken()}` },
      }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );
    expect((await res.json() as Record<string, unknown>).mode).toBe('production');
  });
});

// ── GET /sandbox/:name/status — the confirmation signal ─────────────────────

describe('GET /sandbox/:name/status tells the truth for a neko desktop', () => {
  it('reports guacamoleRunning:true / mode:"neko" for a live neko desktop with no desktopMode param', async () => {
    const { binding, calls } = fakeSandboxNamespace({
      exposedPorts: [
        { port: 8181, url: 'https://8181-x-nekodesktop.ezil.org', status: 'active' },
        { port: 3002, url: 'https://3002-x-app.ezil.org', status: 'active' },
      ],
    });
    const res = await worker.fetch(
      new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}/status`),
      { Sandbox: binding },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // The exact assertion the live run failed: a streaming neko desktop used
    // to answer {"guacamoleRunning":false,"mode":"guacamole"}.
    expect(body.guacamoleRunning).toBe(true);
    expect(body.mode).toBe('neko');
    expect(body.modeSource).toBe('detected');
    expect(body.desktopRunning).toBe(true);
    expect(body.runningModes).toEqual(['neko']);
    expect(body.sandboxName).toBe(SANDBOX_NAME);
    expect(calls.getExposedPorts).toBe(1);
  });

  it('reports false for a sandbox with nothing exposed, and does not wake it', async () => {
    const { binding, calls } = fakeSandboxNamespace({ exposedPorts: [] });
    const res = await worker.fetch(
      new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}/status`),
      { Sandbox: binding },
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.guacamoleRunning).toBe(false);
    expect(body.desktopRunning).toBe(false);
    expect(body.modeSource).toBe('default');
    expect(calls.exec).toBe(0);
  });

  it('honors an explicit ?desktopMode= literally (unchanged contract)', async () => {
    const { binding } = fakeSandboxNamespace({
      exposedPorts: [{ port: 8181, url: 'https://x', status: 'active' }],
    });
    const res = await worker.fetch(
      new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}/status?desktopMode=guacamole`),
      { Sandbox: binding },
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.mode).toBe('guacamole');
    expect(body.modeSource).toBe('requested');
    expect(body.guacamoleRunning).toBe(false);
    expect(body.desktopRunning).toBe(true);
  });

  it('still 400s on an invalid desktopMode rather than silently coercing', async () => {
    const { binding } = fakeSandboxNamespace({});
    const res = await worker.fetch(
      new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}/status?desktopMode=novnc`),
      { Sandbox: binding },
    );
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain('invalid_desktop_mode');
  });

  it('reports a guacamole desktop unchanged (Phase 1 non-regression)', async () => {
    const { binding } = fakeSandboxNamespace({
      exposedPorts: [{ port: 8080, url: 'https://x', status: 'active' }],
    });
    const res = await worker.fetch(
      new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}/status`),
      { Sandbox: binding },
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.guacamoleRunning).toBe(true);
    expect(body.mode).toBe('guacamole');
  });
});

// ── GET /preview-status — the second unauthenticated mutating route ─────────

describe('GET /preview-status is no longer anonymous', () => {
  const APP_HOST = `3002-${SANDBOX_NAME}-app.ezil.org`;

  it('REJECTS an unsigned poll and never execs into the container', async () => {
    const { binding, calls } = fakeSandboxNamespace({});
    const res = await worker.fetch(new Request(`https://${APP_HOST}/preview-status`), {
      Sandbox: binding,
      SANDBOX_HMAC_SECRET: SECRET,
    });
    expect(res.status).toBe(401);
    // `probeAppPreviewStatus` can exec `buildDevserverRestartCommand()` — an
    // anonymous caller must not be able to restart a dev server or cold-boot
    // (bill) a container.
    expect(calls.exec).toBe(0);
  });

  it('ACCEPTS the ezil_preview cookie minted by /preview-bootstrap', async () => {
    const { mintPreviewCookie } = await import('./hmac');
    const { binding, calls } = fakeSandboxNamespace({});
    const cookie = await mintPreviewCookie(SECRET, SANDBOX_NAME);
    const res = await worker.fetch(
      new Request(`https://${APP_HOST}/preview-status`, { headers: { cookie: `ezil_preview=${cookie}` } }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );
    expect(res.status).toBe(200);
    expect(calls.exec).toBeGreaterThan(0);
  });

  it('ACCEPTS the sandboxId-bound bootstrap token (server-side pollers)', async () => {
    const { mintPreviewBootstrapToken } = await import('./hmac');
    const { binding } = fakeSandboxNamespace({});
    const token = encodeURIComponent(await mintPreviewBootstrapToken(SECRET, SANDBOX_NAME));
    const res = await worker.fetch(new Request(`https://${APP_HOST}/preview-status?token=${token}`), {
      Sandbox: binding,
      SANDBOX_HMAC_SECRET: SECRET,
    });
    expect(res.status).toBe(200);
  });

  it("rejects a bootstrap token minted for a DIFFERENT sandbox (no cross-tenant replay)", async () => {
    const { mintPreviewBootstrapToken } = await import('./hmac');
    const { binding, calls } = fakeSandboxNamespace({});
    const token = encodeURIComponent(await mintPreviewBootstrapToken(SECRET, 'guac-someone-else'));
    const res = await worker.fetch(new Request(`https://${APP_HOST}/preview-status?token=${token}`), {
      Sandbox: binding,
      SANDBOX_HMAC_SECRET: SECRET,
    });
    expect(res.status).toBe(401);
    expect(calls.exec).toBe(0);
  });

  it('is unchanged in local dev (no secret configured)', async () => {
    const { binding } = fakeSandboxNamespace({});
    const res = await worker.fetch(new Request(`https://${APP_HOST}/preview-status`), { Sandbox: binding });
    expect(res.status).toBe(200);
  });
});

// ── POST /sandbox/:name/focus ────────────────────────────────────────────────
// Mirrors the `DELETE /sandbox/:name` coverage above: same shared HMAC
// envelope (`authorizeSignedControlRequest`), but with the additional
// closed-enum `app` body field this route adds on top.

describe('POST /sandbox/:name/focus is HMAC-gated with a closed-enum `app`', () => {
  it('REJECTS an unsigned request with 401 and never execs', async () => {
    const { binding, calls } = fakeSandboxNamespace({});
    const res = await worker.fetch(
      new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}/focus`, {
        method: 'POST',
        body: JSON.stringify({ app: 'vscode' }),
      }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );
    expect(res.status).toBe(401);
    expect(calls.exec).toBe(0);
  });

  it('ACCEPTS a signed request via `Authorization: Bearer` and execs neko-switch-app.sh vscode', async () => {
    const { binding, calls } = fakeSandboxNamespace({});
    const res = await worker.fetch(
      new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}/focus`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await mintToken()}` },
        body: JSON.stringify({ app: 'vscode' }),
      }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.app).toBe('vscode');
    expect(calls.exec).toBe(1);
  });

  it('ACCEPTS `chromium` too', async () => {
    const { binding, calls } = fakeSandboxNamespace({});
    const res = await worker.fetch(
      new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}/focus`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await mintToken()}` },
        body: JSON.stringify({ app: 'chromium' }),
      }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );
    expect(res.status).toBe(200);
    expect(calls.exec).toBe(1);
  });

  it('REJECTS an app outside the closed enum, even when properly signed', async () => {
    const { binding, calls } = fakeSandboxNamespace({});
    const res = await worker.fetch(
      new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}/focus`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await mintToken()}` },
        body: JSON.stringify({ app: 'firefox' }),
      }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain('invalid_focus_app');
    expect(calls.exec).toBe(0);
  });

  it('REJECTS a shell-metacharacter injection attempt in `app`, even when properly signed', async () => {
    const { binding, calls } = fakeSandboxNamespace({});
    const res = await worker.fetch(
      new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}/focus`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await mintToken()}` },
        body: JSON.stringify({ app: 'vscode; rm -rf /' }),
      }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );
    expect(res.status).toBe(400);
    expect(calls.exec).toBe(0);
  });

  it('ACCEPTS a signed request via `?token=` (the /preview-bootstrap precedent)', async () => {
    const { binding, calls } = fakeSandboxNamespace({});
    const token = encodeURIComponent(await mintToken());
    const res = await worker.fetch(
      new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}/focus?token=${token}`, {
        method: 'POST',
        body: JSON.stringify({ app: 'vscode' }),
      }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );
    expect(res.status).toBe(200);
    expect(calls.exec).toBe(1);
  });

  it('rejects a token signed with the WRONG secret', async () => {
    const { binding, calls } = fakeSandboxNamespace({});
    const res = await worker.fetch(
      new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}/focus`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await mintToken('a-different-secret')}` },
        body: JSON.stringify({ app: 'vscode' }),
      }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );
    expect(res.status).toBe(401);
    expect(calls.exec).toBe(0);
  });

  it('the kill switch (SANDBOX_FOCUS=off) hard-disables the route with a 404, before auth runs', async () => {
    const { binding, calls } = fakeSandboxNamespace({});
    const res = await worker.fetch(
      new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}/focus`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await mintToken()}` },
        body: JSON.stringify({ app: 'vscode' }),
      }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET, SANDBOX_FOCUS: 'off' },
    );
    expect(res.status).toBe(404);
    expect(calls.exec).toBe(0);
  });

  it('still works keyless in local dev (no secret configured), unchanged', async () => {
    const { binding, calls } = fakeSandboxNamespace({});
    const res = await worker.fetch(
      new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}/focus`, {
        method: 'POST',
        body: JSON.stringify({ app: 'vscode' }),
      }),
      { Sandbox: binding },
    );
    expect(res.status).toBe(200);
    expect(calls.exec).toBe(1);
  });

  it('surfaces a non-zero exec exit code as a 500, not a false success', async () => {
    // A one-off binding whose `exec` fails, rather than `fakeSandboxNamespace`'s
    // always-succeeds fake — everything else routes through the same Proxy
    // fallback that binding uses for RPCs this test doesn't care about.
    const failingBinding = {
      idFromName: (name: string) => ({ name }),
      get: () =>
        new Proxy(
          {},
          {
            get(_t, prop) {
              if (prop === 'exec') return async () => ({ exitCode: 1, stdout: '', stderr: 'no such display' });
              if (typeof prop !== 'string' || prop === 'then') return undefined;
              return async () => undefined;
            },
          },
        ),
    };
    const res = await worker.fetch(
      new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}/focus`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await mintToken()}` },
        body: JSON.stringify({ app: 'vscode' }),
      }),
      { Sandbox: failingBinding, SANDBOX_HMAC_SECRET: SECRET },
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('focus_switch_failed');
  });
});

// ── POST /sandbox/:name/restart ──────────────────────────────────────────────
// Same shared-HMAC envelope as `DELETE /sandbox/:name` and `/focus`. The DO's
// OWN restart logic (SIGTERM reusing terminate_stack, stop-confirm polling,
// unexpose-then-relaunch, the neko-only guard) is covered by the pure
// decision helpers in `sandbox-control.test.ts` — see `fakeSandboxNamespace`'s
// doc comment on `restartResult`. This block proves the ROUTE TABLE: auth,
// the kill switch, mode resolution, and status-code mapping from `outcome`.

describe('POST /sandbox/:name/restart is HMAC-gated the same way as DELETE/focus', () => {
  it('REJECTS an unsigned request with 401 and never calls the DO', async () => {
    const { binding, calls } = fakeSandboxNamespace({});
    const res = await worker.fetch(
      new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}/restart`, { method: 'POST' }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );
    expect(res.status).toBe(401);
    expect(calls.restartDesktopStack.length).toBe(0);
  });

  it('rejects a token signed with the WRONG secret', async () => {
    const { binding, calls } = fakeSandboxNamespace({});
    const res = await worker.fetch(
      new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}/restart`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await mintToken('a-different-secret')}` },
      }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );
    expect(res.status).toBe(401);
    expect(calls.restartDesktopStack.length).toBe(0);
  });

  it('ACCEPTS a signed request via `Authorization: Bearer` and calls the DO exactly once', async () => {
    const { binding, calls } = fakeSandboxNamespace({});
    const res = await worker.fetch(
      new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}/restart`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await mintToken()}` },
      }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.outcome).toBe('restarted');
    expect(calls.restartDesktopStack.length).toBe(1);
    expect(calls.restartDesktopStack[0].sandboxId).toBe(SANDBOX_NAME);
    // No explicit `?desktopMode=` — auto-detection is the DO's job, so the
    // route passes `undefined` through rather than guessing.
    expect(calls.restartDesktopStack[0].explicitMode).toBeUndefined();
  });

  it('ACCEPTS a signed request via `?token=` (the /preview-bootstrap precedent)', async () => {
    const { binding, calls } = fakeSandboxNamespace({});
    const token = encodeURIComponent(await mintToken());
    const res = await worker.fetch(
      new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}/restart?token=${token}`, { method: 'POST' }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );
    expect(res.status).toBe(200);
    expect(calls.restartDesktopStack.length).toBe(1);
  });

  it('forwards an explicit `?desktopMode=` through to the DO', async () => {
    const { binding, calls } = fakeSandboxNamespace({});
    const res = await worker.fetch(
      new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}/restart?desktopMode=neko`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await mintToken()}` },
      }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );
    expect(res.status).toBe(200);
    expect(calls.restartDesktopStack[0].explicitMode).toBe('neko');
  });

  it('rejects an invalid `?desktopMode=` with a 400, before calling the DO', async () => {
    const { binding, calls } = fakeSandboxNamespace({});
    const res = await worker.fetch(
      new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}/restart?desktopMode=bogus`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await mintToken()}` },
      }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );
    expect(res.status).toBe(400);
    expect(calls.restartDesktopStack.length).toBe(0);
  });

  it('the kill switch (SANDBOX_RESTART=off) hard-disables the route with a 404, before auth runs', async () => {
    const { binding, calls } = fakeSandboxNamespace({});
    const res = await worker.fetch(
      new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}/restart`, { method: 'POST' }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET, SANDBOX_RESTART: 'off' },
    );
    expect(res.status).toBe(404);
    expect(calls.restartDesktopStack.length).toBe(0);
  });

  it('still works keyless in local dev (no secret configured), unchanged', async () => {
    const { binding, calls } = fakeSandboxNamespace({});
    const res = await worker.fetch(
      new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}/restart`, { method: 'POST' }),
      { Sandbox: binding },
    );
    expect(res.status).toBe(200);
    expect(calls.restartDesktopStack.length).toBe(1);
  });

  it('maps a `stop_timed_out` / `boot_failed` outcome to a 500 (fail loud, never a false 200)', async () => {
    const { binding, calls } = fakeSandboxNamespace({
      restartResult: {
        ok: false,
        mode: 'neko',
        outcome: 'stop_timed_out',
        wasRunning: true,
        stopConfirmed: false,
        bootOk: false,
        error: 'desktop_stack_did_not_stop_within_grace_period',
      },
    });
    const res = await worker.fetch(
      new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}/restart`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await mintToken()}` },
      }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; outcome: string };
    expect(body.ok).toBe(false);
    expect(body.outcome).toBe('stop_timed_out');
    expect(calls.restartDesktopStack.length).toBe(1);
  });

  it('maps an `unsupported_mode` outcome (Guacamole has no teardown trap) to a 400, not a 500', async () => {
    const { binding } = fakeSandboxNamespace({
      restartResult: {
        ok: false,
        mode: 'guacamole',
        outcome: 'unsupported_mode',
        wasRunning: false,
        stopConfirmed: false,
        bootOk: false,
        error: 'restart_not_supported_for_mode:guacamole',
      },
    });
    const res = await worker.fetch(
      new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}/restart`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await mintToken()}` },
      }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { outcome: string };
    expect(body.outcome).toBe('unsupported_mode');
  });

  it('never calls terminateSandbox or destroy — restart must never tear down the container', async () => {
    const { binding, calls } = fakeSandboxNamespace({});
    await worker.fetch(
      new Request(`https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}/restart`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await mintToken()}` },
      }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );
    expect(calls.terminateSandbox).toBe(0);
    expect(calls.destroy).toBe(0);
  });
});

// ── POST /sandbox/preview hands back ready-to-embed bridge URLs ─────────────
//
// Exercised through the REAL route table with a container fake complete enough
// for `ensureDesktop` to run to completion, rather than by asserting on the
// source text of `handlePreview` — the whole point of the field is that a
// caller can navigate straight to it, and only a real response proves the
// composed URL is well-formed.

describe('POST /sandbox/preview returns appPreviewUrl + codePreviewUrl', () => {
  async function preview(env: Record<string, unknown>, binding: unknown) {
    const res = await worker.fetch(
      new Request('https://api-desktop.ezil.org/sandbox/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: await mintToken(),
          projectId: 'proj-1',
          userId: 'user-1',
          desktopMode: 'neko',
        }),
      }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET, ...env },
    );
    return { res, body: (await res.json()) as Record<string, unknown> };
  }

  it('exposes 3002/app AND 8443/code and returns a bootstrap URL for each', async () => {
    const { binding, calls } = fakeSandboxNamespace({ exposePort: () => true });
    const { res, body } = await preview({}, binding);

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);

    // Both bridge ports were actually exposed, with the tokens the routes bind.
    const exposures = calls.exposePort.map((e) => `${e.port}/${e.token}`);
    expect(exposures).toContain('3002/app');
    expect(exposures).toContain('8443/code');

    const appPreviewUrl = new URL(String(body.appPreviewUrl));
    const codePreviewUrl = new URL(String(body.codePreviewUrl));
    expect(/^3002-[a-zA-Z0-9-]+-app\.ezil\.org$/.test(appPreviewUrl.hostname)).toBe(true);
    expect(/^8443-[a-zA-Z0-9-]+-code\.ezil\.org$/.test(codePreviewUrl.hostname)).toBe(true);
    for (const u of [appPreviewUrl, codePreviewUrl]) {
      expect(u.protocol).toBe('https:');
      expect(u.pathname).toBe('/preview-bootstrap');
      expect(u.searchParams.get('token')).toMatch(/^t=\d+,v1=[0-9a-f]+$/);
    }
  });

  it('the returned URL is one the bridge host itself accepts (round trip)', async () => {
    // The strongest available check short of a live container: take the URL
    // `/sandbox/preview` handed back and feed it to `fetch()` again. A wrong
    // secret, a wrong sandboxId binding, or a malformed hostname all fail here
    // and cannot be papered over by a source-text assertion.
    const { binding } = fakeSandboxNamespace({ exposePort: () => true });
    const { body } = await preview({}, binding);

    for (const field of ['appPreviewUrl', 'codePreviewUrl'] as const) {
      const res = await worker.fetch(new Request(String(body[field])), {
        Sandbox: binding,
        SANDBOX_HMAC_SECRET: SECRET,
      });
      expect(`${field} -> ${res.status}`).toBe(`${field} -> 302`);
      expect(res.headers.get('set-cookie')).toContain('Partitioned');
      expect(res.headers.get('location')).toContain('ezil_pv=');
    }
  });

  it('🔴 still returns both URLs on a WARM call (desktop already exposed)', async () => {
    // The second and every subsequent /sandbox/preview for a project takes
    // ensureDesktop's already-exposed fast path, which skips re-exposure. If
    // that path reports the bridge ports as not-exposed, the URLs go null and
    // the shell gets a working window on the first open of a project and an
    // empty one forever after — a 200 with no error anywhere. `getExposedPorts`
    // is the authority and is already fetched on that path.
    const host = 'ezil.org';
    const id = 'guac-warmwarmwarmwarm-poolpoolpoolpool';
    const { binding, calls } = fakeSandboxNamespace({
      exposedPorts: [
        { port: 8181, url: `https://8181-${id}-nekodesktop.${host}`, status: 'open' },
        { port: 3002, url: `https://3002-${id}-app.${host}`, status: 'open' },
        { port: 8443, url: `https://8443-${id}-code.${host}`, status: 'open' },
      ],
    });
    const { res, body } = await preview({}, binding);

    expect(res.status).toBe(200);
    // Fast path really was taken: nothing was re-exposed.
    expect(calls.exposePort).toHaveLength(0);
    expect(String(body.appPreviewUrl)).toContain(`3002-${id}-app.${host}/preview-bootstrap?token=`);
    expect(String(body.codePreviewUrl)).toContain(`8443-${id}-code.${host}/preview-bootstrap?token=`);
    expect((body.codePreviewExpose as { attempted: boolean; exposed: boolean }).attempted).toBe(false);
    expect((body.codePreviewExpose as { attempted: boolean; exposed: boolean }).exposed).toBe(true);
  });

  it('is null (never absent) when the port could not be exposed', async () => {
    // Desktop port (8181) still exposes; the two bridge ports throw, which is
    // exactly the shape of the original port-3000 reservation bug. The preview
    // response must still be a 200 — the desktop itself is up.
    const { binding } = fakeSandboxNamespace({ exposePort: (port) => port === 8181 });
    const { res, body } = await preview({}, binding);
    expect(res.status).toBe(200);
    expect('appPreviewUrl' in body).toBe(true);
    expect('codePreviewUrl' in body).toBe(true);
    expect(body.appPreviewUrl).toBeNull();
    expect(body.codePreviewUrl).toBeNull();
    // …and the failure is surfaced, not swallowed.
    expect((body.codePreviewExpose as { attempted: boolean; exposed: boolean }).attempted).toBe(true);
    expect((body.codePreviewExpose as { attempted: boolean; exposed: boolean }).exposed).toBe(false);
  });
});

// ── Telemetry: boot phase/outcome data reaches the R2 spool ─────────────────
//
// Before this, `proc.getLogs()` was read only on the FAILURE path inside
// `ensureDesktop`, and nowhere durable at all — a healthy boot's own
// container-emitted phase timings were invisible everywhere except a live
// `wrangler tail`. This proves the fix end to end through the REAL route
// table: a fake R2 bucket stands in for `TELEMETRY_R2_BUCKET`, and the fake
// container's `exec()` answers the boot-telemetry drain command
// (`ezil-telemetry.ndjson`) with canned NDJSON — see `fakeSandboxNamespace`'s
// `containerTelemetryNdjson` option.
describe('telemetry: boot phase/outcome data reaches the R2 spool on a SUCCESSFUL boot', () => {
  function fakeTelemetryBucket(): { bucket: unknown; puts: Array<{ key: string; body: string }> } {
    const puts: Array<{ key: string; body: string }> = [];
    return {
      puts,
      bucket: {
        put: async (key: string, body: string) => {
          puts.push({ key, body });
          return {};
        },
      },
    };
  }

  const CONTAINER_NDJSON = [
    '{"eventClass":"boot_phase","source":"container","site":"xvfb","code":"ok","outcome":"ok","durationMs":210}',
    '{"eventClass":"boot_summary","source":"container","site":"ready","code":"ok","outcome":"ok","durationMs":5900}',
  ].join('\n');

  async function preview(env: Record<string, unknown>, binding: unknown) {
    const res = await worker.fetch(
      new Request('https://api-desktop.ezil.org/sandbox/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: await mintToken(),
          projectId: 'proj-telemetry',
          userId: 'user-telemetry',
          desktopMode: 'neko',
        }),
      }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET, ...env },
    );
    return { res, body: (await res.json()) as Record<string, unknown> };
  }

  it('spools ONE ndjson object containing the worker boot_summary AND the container-emitted lines', async () => {
    const { binding } = fakeSandboxNamespace({ exposePort: () => true, containerTelemetryNdjson: CONTAINER_NDJSON });
    const { bucket, puts } = fakeTelemetryBucket();
    const { res, body } = await preview({ TELEMETRY_R2_BUCKET: bucket }, binding);

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);

    expect(puts).toHaveLength(1);
    const lines = puts[0].body.split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    // The Worker's own boot_summary (sandbox.preview.desktop_ready, ok).
    expect(lines.some((l) => l.eventClass === 'boot_summary' && l.source === 'worker' && l.outcome === 'ok')).toBe(
      true,
    );
    // The container's own two lines, drained via the exec() fake.
    expect(lines.some((l) => l.source === 'container' && l.site === 'xvfb')).toBe(true);
    expect(lines.some((l) => l.source === 'container' && l.eventClass === 'boot_summary' && l.site === 'ready')).toBe(
      true,
    );
    // Every row is correlated to THIS request, joinable across worker+container.
    const correlationId = body.correlationId as string;
    expect(correlationId).toBeTruthy();
    expect(lines.every((l) => l.correlationId === correlationId)).toBe(true);
    // Keyed by that same correlation id (design doc §4.1's v1/dt=/hh=/ layout).
    expect(puts[0].key).toContain(`/${correlationId}.ndjson`);
    expect(puts[0].key.startsWith('v1/dt=')).toBe(true);
  });

  it('is a silent no-op when TELEMETRY_R2_BUCKET is not configured — never fails the preview', async () => {
    const { binding } = fakeSandboxNamespace({ exposePort: () => true, containerTelemetryNdjson: CONTAINER_NDJSON });
    const { res, body } = await preview({}, binding);
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    // No bucket binding at all — nothing to assert on except that this didn't throw.
  });

  it('still spools the worker boot_summary even with NO container telemetry present (older image)', async () => {
    const { binding } = fakeSandboxNamespace({ exposePort: () => true }); // no containerTelemetryNdjson
    const { bucket, puts } = fakeTelemetryBucket();
    const { res } = await preview({ TELEMETRY_R2_BUCKET: bucket }, binding);
    expect(res.status).toBe(200);
    expect(puts).toHaveLength(1);
    const lines = puts[0].body.split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.every((l) => l.source === 'worker')).toBe(true);
    expect(lines.some((l) => l.eventClass === 'boot_summary')).toBe(true);
  });
});

// ── code-server bridge host, whole journey through the REAL route table ─────
//
// The failure this block exists to catch: code-server is launched with
// `--auth none` and no proxy base-path, so it emits ROOT-ABSOLUTE asset URLs
// and opens its extension-host WebSocket at the root. A dispatcher that only
// understands `/preview*` 404s every one of those and the editor renders
// blank, with a completely green unit suite — this project's signature
// "correct in isolation, broken in composition" failure. Every assertion here
// runs through `worker.fetch()`, not through the handler functions directly.

const CODE_HOST = `8443-${SANDBOX_NAME}-code.ezil.org`;
const APP_HOST = `3002-${SANDBOX_NAME}-app.ezil.org`;

async function bootstrapCodeHost(
  worker: { fetch(request: Request, env: unknown): Promise<Response> },
  binding: unknown,
): Promise<{ cookie: string; fallbackParam: string; location: string; res: Response }> {
  const { mintPreviewBootstrapToken } = await import('./hmac');
  const token = await mintPreviewBootstrapToken(SECRET, SANDBOX_NAME);
  const res = await worker.fetch(
    new Request(`https://${CODE_HOST}/preview-bootstrap?token=${encodeURIComponent(token)}`),
    { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
  );
  const setCookie = res.headers.get('set-cookie') ?? '';
  const cookie = /ezil_preview=([^;]+)/.exec(setCookie)?.[1] ?? '';
  const location = res.headers.get('location') ?? '';
  const fallbackParam = new URLSearchParams(location.split('?')[1] ?? '').get('ezil_pv') ?? '';
  return { cookie, fallbackParam, location, res };
}

describe('code-server bridge host (8443-<id>-code.ezil.org)', () => {
  it('bootstraps with a CHIPS-partitioned cookie AND the ezil_pv fallback on the redirect', async () => {
    const { binding } = fakeSandboxNamespace({});
    const { res, cookie, fallbackParam, location } = await bootstrapCodeHost(worker, binding);

    expect(res.status).toBe(302);
    const setCookie = res.headers.get('set-cookie') ?? '';
    // All four are load-bearing together: without `Partitioned`, Chrome drops
    // a SameSite=None cookie in a cross-site iframe outright.
    expect(setCookie).toContain('Partitioned');
    expect(setCookie).toContain('SameSite=None');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('HttpOnly');
    expect(location.startsWith('/preview/')).toBe(true);
    // The fallback carries the SAME value as the cookie, so it can never be a
    // weaker credential than the cookie it stands in for.
    expect(fallbackParam).toBe(cookie);
    expect(cookie.length).toBeGreaterThan(0);
  });

  it('proxies /preview/ to port 8443 and does NOT inject RUNTIME_SHIM', async () => {
    const { binding, calls } = fakeSandboxNamespace({});
    const { cookie } = await bootstrapCodeHost(worker, binding);

    const res = await worker.fetch(
      new Request(`https://${CODE_HOST}/preview/`, { headers: { cookie: `ezil_preview=${cookie}` } }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );

    expect(res.status).toBe(200);
    expect(calls.containerFetch).toHaveLength(1);
    expect(calls.containerFetch[0].port).toBe(8443);
    expect(calls.containerFetch[0].url).toBe('http://127.0.0.1:8443/');
    const body = await res.text();
    // 🔴 The known landmine: RUNTIME_SHIM monkey-patches window.WebSocket and
    // would break code-server's extension host instantly.
    expect(body).not.toContain('window.WebSocket');
    expect(body).not.toContain('/preview-ws');
    expect(body).toContain('upstream');
  });

  it('proxies ROOT-ABSOLUTE code-server asset paths instead of 404ing them', async () => {
    const { binding, calls } = fakeSandboxNamespace({
      containerResponse: () =>
        new Response('console.log(1)', { status: 200, headers: { 'content-type': 'application/javascript' } }),
    });
    const { cookie } = await bootstrapCodeHost(worker, binding);

    for (const assetPath of [
      '/_static/out/vs/workbench/workbench.web.main.js',
      '/stable-abc123/static/out/media/letterpress-dark.svg',
      '/manifest.json',
      '/healthz',
    ]) {
      calls.containerFetch.length = 0;
      const res = await worker.fetch(
        new Request(`https://${CODE_HOST}${assetPath}`, { headers: { cookie: `ezil_preview=${cookie}` } }),
        { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
      );
      expect(`${assetPath} -> ${res.status}`).toBe(`${assetPath} -> 200`);
      expect(calls.containerFetch).toHaveLength(1);
      expect(calls.containerFetch[0].url).toBe(`http://127.0.0.1:8443${assetPath}`);
      expect(calls.containerFetch[0].port).toBe(8443);
    }
  });

  it('preserves the query string (minus ezil_pv) on a proxied code-server request', async () => {
    const { binding, calls } = fakeSandboxNamespace({});
    const { cookie, fallbackParam } = await bootstrapCodeHost(worker, binding);

    await worker.fetch(
      new Request(
        `https://${CODE_HOST}/?folder=/home/neko/project&ezil_pv=${encodeURIComponent(fallbackParam)}`,
        { headers: { cookie: `ezil_preview=${cookie}` } },
      ),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );

    expect(calls.containerFetch).toHaveLength(1);
    expect(calls.containerFetch[0].url).toContain('folder=');
    // The internal auth parameter must never reach code-server itself.
    expect(calls.containerFetch[0].url).not.toContain('ezil_pv');
  });

  it('routes a WebSocket upgrade at the ROOT to the WS proxy on 8443', async () => {
    // code-server opens its extension-host / terminal sockets at the base
    // path, NOT under `/preview-ws/` (RUNTIME_SHIM, which performs that
    // rewrite for Next/Vite HMR, is deliberately never injected here) — so
    // the upgrade must be detected by header, not by path prefix.
    const { binding, calls } = fakeSandboxNamespace({});
    const { cookie } = await bootstrapCodeHost(worker, binding);

    const res = await worker.fetch(
      new Request(`https://${CODE_HOST}/?type=ExtensionHost&reconnectionToken=abc`, {
        headers: {
          cookie: `ezil_preview=${cookie}`,
          upgrade: 'websocket',
          connection: 'Upgrade',
          origin: `https://${CODE_HOST}`,
        },
      }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );

    expect(res.status).toBe(101);
    // 🔴 The socket itself has to survive the hop. A 101 with no `webSocket`
    // is not an upgrade — it is the shape the old fake invented, and the one
    // the platform cannot actually return through JSRPC.
    expect(res.webSocket).toBe(FAKE_UPSTREAM_WS);
    // 🔴 …and it must NOT have gone through the RPC boundary at all.
    expect(calls.containerFetch).toHaveLength(0);
    expect(calls.wsConnect).toHaveLength(1);
    expect(calls.wsConnect[0].port).toBe(8443);
    expect(calls.wsConnect[0].url).toBe('http://127.0.0.1:8443/?type=ExtensionHost&reconnectionToken=abc');
    expect(calls.wsConnect[0].headers.upgrade).toBe('websocket');
    expect(calls.wsConnect[0].headers.connection.toLowerCase()).toContain('upgrade');
  });

  it("🔴 forwards the REAL bridge host, so code-server's WS origin check can pass", async () => {
    const { binding, calls } = fakeSandboxNamespace({});
    const { cookie } = await bootstrapCodeHost(worker, binding);

    await worker.fetch(
      new Request(`https://${CODE_HOST}/?type=ExtensionHost`, {
        headers: {
          cookie: `ezil_preview=${cookie}`,
          upgrade: 'websocket',
          connection: 'Upgrade',
          origin: `https://${CODE_HOST}`,
          // A caller-supplied `Forwarded` outranks `X-Forwarded-Host` in
          // code-server's `getHost()`, so it must not survive the hop.
          forwarded: 'host=attacker.example;proto=https',
        },
      }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );

    const forwarded = calls.wsConnect[0].headers;
    expect(forwarded['x-forwarded-host']).toBe(CODE_HOST);
    expect(forwarded['x-forwarded-host']).not.toBe('preview.local');
    expect(forwarded.forwarded).toBeUndefined();
    // Behavioural, not string-shaped: run code-server's own algorithm.
    expect(() => simulateCodeServerEnsureOrigin(forwarded, `https://${CODE_HOST}`)).not.toThrow();
    expect(() => simulateCodeServerEnsureOrigin(forwarded, 'https://ezil-os.vercel.app')).toThrow(
      /incorrect origin/,
    );
    // The shipped bug, for contrast: `preview.local` rejects every origin,
    // including the bridge host's own.
    expect(() =>
      simulateCodeServerEnsureOrigin({ 'x-forwarded-host': 'preview.local' }, `https://${CODE_HOST}`),
    ).toThrow(/incorrect origin/);
  });

  it('🔴 forwards the REAL bridge host on the code host HTTP path too (one identity, not two)', async () => {
    const { binding, calls } = fakeSandboxNamespace({});
    const { cookie } = await bootstrapCodeHost(worker, binding);

    await worker.fetch(
      new Request(`https://${CODE_HOST}/`, { headers: { cookie: `ezil_preview=${cookie}` } }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );
    expect(calls.containerFetch[0].headers['x-forwarded-host']).toBe(CODE_HOST);
  });

  it('🔴 an upgrade whose hop-by-hop `Connection` was stripped still lands on 8443', async () => {
    // `Connection` is hop-by-hop; nothing guarantees it survives to the
    // Worker. If the bridge merely forwards what it received, `Sandbox.fetch`
    // misses its WebSocket branch and quietly falls back to
    // `determinePort(url)` = 3000 — the SDK's own control plane, not
    // code-server. The socket would "connect" to the wrong service.
    const { binding, calls } = fakeSandboxNamespace({});
    const { cookie } = await bootstrapCodeHost(worker, binding);

    const res = await worker.fetch(
      new Request(`https://${CODE_HOST}/?type=ExtensionHost`, {
        headers: { cookie: `ezil_preview=${cookie}`, upgrade: 'websocket', origin: `https://${CODE_HOST}` },
      }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );

    expect(res.status).toBe(101);
    expect(calls.wsConnect[0].port).toBe(8443);
    expect(calls.wsConnect[0].port).not.toBe(3000);
  });

  it('🔴 an unauthenticated WebSocket upgrade never reaches the container', async () => {
    // code-server runs `--auth none`; this gate is the only thing between the
    // public internet and a root shell. The WS path must not be an exception.
    const { binding, calls } = fakeSandboxNamespace({});
    const res = await worker.fetch(
      new Request(`https://${CODE_HOST}/?type=ExtensionHost`, {
        headers: { upgrade: 'websocket', connection: 'Upgrade', origin: `https://${CODE_HOST}` },
      }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );
    expect(res.status).toBe(401);
    expect(calls.wsConnect).toHaveLength(0);
    expect(calls.containerFetch).toHaveLength(0);
  });

  it('🔴 the catch-all opens NO hole: every code-host path 401s without auth', async () => {
    const { binding, calls } = fakeSandboxNamespace({});
    for (const p of ['/', '/preview/', '/_static/x.js', '/stable-abc/static/y.css', '/healthz']) {
      const res = await worker.fetch(new Request(`https://${CODE_HOST}${p}`), {
        Sandbox: binding,
        SANDBOX_HMAC_SECRET: SECRET,
      });
      expect(`${p} -> ${res.status}`).toBe(`${p} -> 401`);
    }
    // code-server runs `--auth none`, so "the request never reached the
    // container" is the assertion that matters, not just the status code.
    expect(calls.containerFetch).toHaveLength(0);
  });

  it('accepts the ezil_pv query fallback when the browser dropped the cookie entirely', async () => {
    const { binding, calls } = fakeSandboxNamespace({});
    const { fallbackParam } = await bootstrapCodeHost(worker, binding);

    const res = await worker.fetch(
      new Request(`https://${CODE_HOST}/_static/x.js?ezil_pv=${encodeURIComponent(fallbackParam)}`),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );
    expect(res.status).toBe(200);
    expect(calls.containerFetch).toHaveLength(1);
  });

  it('rejects an ezil_pv minted for a DIFFERENT sandbox', async () => {
    const { binding, calls } = fakeSandboxNamespace({});
    const { mintPreviewCookie } = await import('./hmac');
    const foreign = await mintPreviewCookie(SECRET, 'guac-1111111111111111-2222222222222222');
    const res = await worker.fetch(
      new Request(`https://${CODE_HOST}/_static/x.js?ezil_pv=${encodeURIComponent(foreign)}`),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );
    expect(res.status).toBe(401);
    expect(calls.containerFetch).toHaveLength(0);
  });

  it('leaves the APP host 404 contract untouched (no accidental catch-all there)', async () => {
    const { binding, calls } = fakeSandboxNamespace({});
    const { mintPreviewBootstrapToken } = await import('./hmac');
    const token = await mintPreviewBootstrapToken(SECRET, SANDBOX_NAME);
    const boot = await worker.fetch(
      new Request(`https://${APP_HOST}/preview-bootstrap?token=${encodeURIComponent(token)}`),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );
    const cookie = /ezil_preview=([^;]+)/.exec(boot.headers.get('set-cookie') ?? '')?.[1] ?? '';
    expect(cookie.length).toBeGreaterThan(0);

    const res = await worker.fetch(
      new Request(`https://${APP_HOST}/_next/static/chunk.js`, {
        headers: { cookie: `ezil_preview=${cookie}` },
      }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );
    expect(res.status).toBe(404);
    expect(calls.containerFetch).toHaveLength(0);
  });

  it('still injects RUNTIME_SHIM on the APP host (no cross-target regression)', async () => {
    const { binding } = fakeSandboxNamespace({});
    const { mintPreviewBootstrapToken } = await import('./hmac');
    const token = await mintPreviewBootstrapToken(SECRET, SANDBOX_NAME);
    const boot = await worker.fetch(
      new Request(`https://${APP_HOST}/preview-bootstrap?token=${encodeURIComponent(token)}`),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );
    const cookie = /ezil_preview=([^;]+)/.exec(boot.headers.get('set-cookie') ?? '')?.[1] ?? '';

    const res = await worker.fetch(
      new Request(`https://${APP_HOST}/preview/`, { headers: { cookie: `ezil_preview=${cookie}` } }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );
    const body = await res.text();
    expect(body).toContain('window.WebSocket');
    expect(body).toContain('/preview-ws');
  });

  it('the APP host HMR socket also crosses via wsConnect, still under `preview.local`', async () => {
    // Same platform fix (never JSRPC for a socket), deliberately WITHOUT the
    // forwarded-host change: the user's dev server is untrusted project code
    // and must keep seeing one synthetic host, never the sandbox-scoped bridge
    // hostname. Only code-server needs the real one, and only because it
    // origin-checks its own sockets against it.
    const { binding, calls } = fakeSandboxNamespace({});
    const { mintPreviewBootstrapToken } = await import('./hmac');
    const token = await mintPreviewBootstrapToken(SECRET, SANDBOX_NAME);
    const boot = await worker.fetch(
      new Request(`https://${APP_HOST}/preview-bootstrap?token=${encodeURIComponent(token)}`),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );
    const cookie = /ezil_preview=([^;]+)/.exec(boot.headers.get('set-cookie') ?? '')?.[1] ?? '';

    const res = await worker.fetch(
      new Request(`https://${APP_HOST}/preview-ws/_next/webpack-hmr`, {
        headers: { cookie: `ezil_preview=${cookie}`, upgrade: 'websocket', connection: 'Upgrade' },
      }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );

    expect(res.status).toBe(101);
    expect(res.webSocket).toBe(FAKE_UPSTREAM_WS);
    expect(calls.containerFetch).toHaveLength(0);
    expect(calls.wsConnect).toHaveLength(1);
    expect(calls.wsConnect[0].port).toBe(3002);
    expect(calls.wsConnect[0].url).toBe('http://127.0.0.1:3002/_next/webpack-hmr');
    expect(calls.wsConnect[0].headers['x-forwarded-host']).toBe('preview.local');
    expect(calls.wsConnect[0].headers['x-forwarded-host']).not.toContain(SANDBOX_NAME);
  });
});

// ── Whole-surface guard ─────────────────────────────────────────────────────

describe('no other mutating route is reachable unauthenticated', () => {
  it('every mutating route rejects an unsigned request when a secret is configured', async () => {
    const mutating: Array<{ method: string; url: string }> = [
      { method: 'POST', url: `https://api-desktop.ezil.org/sandbox/preview` },
      { method: 'POST', url: `https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}/workspace-diag` },
      { method: 'POST', url: `https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}/cpu-diag` },
      { method: 'POST', url: `https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}/twen` },
      { method: 'POST', url: `https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}/focus` },
      { method: 'POST', url: `https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}/restart` },
      { method: 'POST', url: `https://api-desktop.ezil.org/project-files/put` },
      { method: 'POST', url: `https://api-desktop.ezil.org/project-files/delete` },
      { method: 'POST', url: `https://api-desktop.ezil.org/project-files/list` },
      { method: 'DELETE', url: `https://api-desktop.ezil.org/sandbox/${SANDBOX_NAME}` },
    ];

    for (const { method, url } of mutating) {
      const { binding, calls } = fakeSandboxNamespace({});
      const res = await worker.fetch(
        new Request(url, { method, ...(method === 'POST' ? { body: '{}' } : {}) }),
        { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
      );
      expect(`${method} ${new URL(url).pathname} -> ${res.status}`).toBe(
        `${method} ${new URL(url).pathname} -> 401`,
      );
      expect(calls.terminateSandbox + calls.destroy + calls.exec + calls.restartDesktopStack.length).toBe(0);
    }
  });

  it('/health stays open and unauthenticated (read-only, no sandbox touched)', async () => {
    const { binding, calls } = fakeSandboxNamespace({});
    const res = await worker.fetch(new Request('https://api-desktop.ezil.org/health'), { Sandbox: binding });
    expect(res.status).toBe(200);
    expect((await res.json() as { build: string }).build).toBe('ezil-os');
    expect(calls.getExposedPorts + calls.exec).toBe(0);
  });

  it('an unknown path 404s rather than falling through to a raw forward', async () => {
    const { binding } = fakeSandboxNamespace({});
    const res = await worker.fetch(
      new Request('https://api-desktop.ezil.org/sandbox/a/b/c', { method: 'DELETE' }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );
    expect(res.status).toBe(404);
  });
});
