/**
 * The local host listens on loopback and nowhere else.
 *
 * 🔴 THIS IS THE ONLY THING BETWEEN THE DESKTOP AND THE NETWORK. The process
 * has no authentication of any kind, correctly (see `./http.ts`): it serves one
 * user, on their own machine, as themselves. That makes the bind address the
 * entire security boundary. On `0.0.0.0` every device on the same Wi-Fi could
 * `POST /api/shell/restart`, `POST /api/shell/screen`, cold-boot a container,
 * and read `/os` — which inlines the workspace-derived computer id.
 *
 * A test that only asserted "not reachable from outside" would pass on a server
 * that never started, so every negative below is paired with a positive control
 * taken from the SAME run: the loopback address answers, and a second server
 * deliberately bound wide proves the external address is reachable at all on
 * this machine.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, type LocalConfig } from '../config.ts';
import { LOCAL_BIND_ADDRESS } from '../container/run-spec.ts';
import { FakeSandboxHost } from './fake-host.ts';
import {
    LOOPBACK_BIND_ADDRESSES,
    assertLoopbackBind,
    localServerUrl,
    startLocalServer,
    type LocalServer,
} from './server.ts';

let tmp: string;
let config: LocalConfig;
let server: LocalServer;

/** A non-loopback IPv4 address of this machine, or `null` when it has none. */
function externalIPv4(): string | null {
    for (const list of Object.values(networkInterfaces())) {
        for (const iface of list ?? []) {
            if (iface.family === 'IPv4' && !iface.internal) return iface.address;
        }
    }
    return null;
}

beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'ezil-t1-loopback-'));
    config = await loadConfig({
        EZIL_LOCAL_PORT: '0',
        EZIL_LOCAL_WORKSPACE: join(tmp, 'workspace'),
        EZIL_LOCAL_STATE_DIR: join(tmp, 'state'),
    });
    server = await startLocalServer({
        config,
        host: new FakeSandboxHost(),
        telemetrySink: async () => {},
    });
});

afterAll(async () => {
    await server.stop();
    await rm(tmp, { recursive: true, force: true });
});

describe('the bind guard', () => {
    it('accepts only loopback, and names the constraint when it refuses', () => {
        for (const ok of LOOPBACK_BIND_ADDRESSES) {
            expect(() => assertLoopbackBind(ok)).not.toThrow();
        }
        for (const bad of ['0.0.0.0', '::', '192.168.1.14', '10.0.0.1', 'localhost', '']) {
            // Asserting on the CONSTRAINT'S NAME, not on "it threw": a future
            // refactor that throws for an unrelated reason must not read as
            // this guard still working.
            expect(() => assertLoopbackBind(bad)).toThrow(/refusing_non_loopback_bind/);
        }
    });

    it('`localhost` is refused on purpose', () => {
        // It is resolved through `/etc/hosts` and DNS, so what it points at is
        // not a property of this code. `127.0.0.1` is.
        expect(LOOPBACK_BIND_ADDRESSES).not.toContain('localhost');
        expect(() => assertLoopbackBind('localhost')).toThrow(/refusing_non_loopback_bind/);
    });

    it('startLocalServer runs the guard before it opens a socket', async () => {
        // The guard is not advice sitting next to the call; a config carrying a
        // wide address never reaches `Bun.serve`.
        const wide = { ...config, bindAddress: '0.0.0.0' };
        await expect(
            startLocalServer({ config: wide, host: new FakeSandboxHost(), telemetrySink: async () => {} }),
        ).rejects.toThrow(/refusing_non_loopback_bind/);
    });
});

describe('the running listener', () => {
    it('binds the loopback address run-spec pins, not a hostname', () => {
        expect(server.bindAddress).toBe(LOCAL_BIND_ADDRESS);
        expect(server.url).toBe(localServerUrl(LOCAL_BIND_ADDRESS, server.port));
    });

    it('answers on 127.0.0.1 — the positive control for everything below', async () => {
        const res = await fetch(`${localServerUrl(LOCAL_BIND_ADDRESS, server.port)}/os`);
        expect(res.status).toBe(200);
    });

    it('🔴 is NOT reachable on this machine\'s own external address', async () => {
        const external = externalIPv4();
        if (external === null) {
            // NAMED SKIP, not a silent pass: this machine has no non-loopback
            // IPv4 interface, so there is no address to be unreachable at. The
            // guard tests above still ran, and `startLocalServer` still refuses
            // a wide bind. Reported as a skip in this row's evidence.
            console.warn('[loopback.test] SKIPPED the external-address probe: no non-loopback IPv4 interface');
            expect(externalIPv4()).toBeNull();
            return;
        }

        // POSITIVE CONTROL, on this same run: a server that DOES bind wide is
        // reachable at that address and port. Without this, "connection
        // refused" could just as well mean the address is unroutable here.
        const wide = Bun.serve({
            hostname: '0.0.0.0',
            port: 0,
            fetch: () => new Response('wide'),
        });
        try {
            const control = await fetch(`http://${external}:${wide.port}/`);
            expect(await control.text()).toBe('wide');
        } finally {
            await wide.stop(true);
        }

        // THE ASSERTION: our server, same machine, same kind of request, at the
        // external address — refused.
        let reached = false;
        try {
            await fetch(`http://${external}:${server.port}/os`, {
                signal: AbortSignal.timeout(2_000),
            });
            reached = true;
        } catch {
            reached = false;
        }
        expect(`${external}:${server.port} reachable = ${String(reached)}`)
            .toBe(`${external}:${server.port} reachable = false`);
    });
});
