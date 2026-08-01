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
  destroy: number;
  flushWorkspaceNow: number;
  getExposedPorts: number;
  exec: number;
  /** Every `containerFetch(url, init, port)` the route table actually made. */
  containerFetch: Array<{ url: string; port: number; headers: Record<string, string> }>;
  /** Every `exposePort(port, {hostname, token})` the route table actually made. */
  exposePort: Array<{ port: number; token: string; hostname: string }>;
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
}): { binding: unknown; calls: CallLog } {
  /** The sandbox id the Worker actually opened the DO with. */
  let openedWith = SANDBOX_NAME;
  const calls: CallLog = {
    terminateSandbox: 0,
    destroy: 0,
    flushWorkspaceNow: 0,
    getExposedPorts: 0,
    exec: 0,
    containerFetch: [],
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
      return (
        options.containerResponse?.() ??
        new Response('<html><head></head><body>upstream</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      );
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
    exec: async () => {
      calls.exec++;
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
    expect(appPreviewUrl.hostname.startsWith('3002-')).toBe(true);
    expect(appPreviewUrl.hostname.endsWith('-app.ezil.org')).toBe(true);
    expect(codePreviewUrl.hostname.startsWith('8443-')).toBe(true);
    expect(codePreviewUrl.hostname.endsWith('-code.ezil.org')).toBe(true);
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
    const { binding, calls } = fakeSandboxNamespace({
      containerResponse: () => new Response(null, { status: 101 }),
    });
    const { cookie } = await bootstrapCodeHost(worker, binding);

    const res = await worker.fetch(
      new Request(`https://${CODE_HOST}/?type=ExtensionHost&reconnectionToken=abc`, {
        headers: { cookie: `ezil_preview=${cookie}`, upgrade: 'websocket', connection: 'Upgrade' },
      }),
      { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET },
    );

    expect(res.status).toBe(101);
    expect(calls.containerFetch).toHaveLength(1);
    expect(calls.containerFetch[0].port).toBe(8443);
    expect(calls.containerFetch[0].headers.upgrade).toBe('websocket');
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
      expect(calls.terminateSandbox + calls.destroy + calls.exec).toBe(0);
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
