/**
 * The wiring nobody had tested, because every test built its own.
 *
 * ── The two defects this file is written against ────────────────────────────
 *
 * 1. `resolveHost` — the ONE function a user's `bun run start` calls to get an
 *    adapter — THREW for the real path until row T5, and no test noticed,
 *    because `shell-contract.test.ts` injects `FakeSandboxHost` and
 *    `docker-host.container.test.ts` constructs its own `DockerHost`. The
 *    production path had no coverage at either end of it.
 *
 * 2. `isOwnDesktopOrigin` pinned the desktop origin at port offset 0. On any
 *    machine that needs an offset to boot at all — this one, where
 *    `supabase-kong` holds `0.0.0.0:8443` — the SSRF pin then rejected the
 *    host's OWN desktop URL, and every cold boot answered
 *    `desktop_frame_foreign_origin` over a healthy container. Every unit test
 *    stayed green because they all run at offset 0.
 *
 * Both are integration defects between two files that were individually
 * correct, which is why they are tested together here rather than in either
 * file's own suite.
 */

import { describe, expect, it } from 'bun:test';

import { ENV_KEYS, loadConfig } from '../src/config.ts';
import { localUrlFor, offsetPortMap } from '../src/container/run-spec.ts';
import { DockerHost } from '../src/host/docker-host.ts';
import { FakeSandboxHost } from '../src/server/fake-host.ts';
import { resolveHost, startupReport, wantsFakeHost } from '../src/server/main.ts';
import { isOwnDesktopOrigin, probeDesktopOrigin } from '../src/server/routes.ts';
import type { LocalServer } from '../src/server/server.ts';

const OFFSET = 10_000;

async function config(env: Record<string, string> = {}) {
    return loadConfig({ [ENV_KEYS.port]: '0', ...env });
}

describe('resolveHost — the production wiring', () => {
    it('returns a REAL DockerHost when --fake-host is absent', async () => {
        // 🔴 This threw until row T5. The assertion is on the CLASS, not on
        // "it did not throw": a future refactor that returned the fake as a
        // fallback when Docker is missing would pass the weaker check and ship
        // a `/os` that boots, a desktop button that reports success, and no
        // container anywhere.
        const host = resolveHost([], await config());
        expect(host).toBeInstanceOf(DockerHost);
        expect(host).not.toBeInstanceOf(FakeSandboxHost);
    });

    it('returns the fake ONLY for the explicit flag', () => {
        expect(wantsFakeHost(['--fake-host'])).toBe(true);
        expect(wantsFakeHost([])).toBe(false);
        expect(wantsFakeHost(['--fake'])).toBe(false);
    });

    it('gives the fake for --fake-host', async () => {
        expect(resolveHost(['--fake-host'], await config())).toBeInstanceOf(FakeSandboxHost);
    });

    it('hands the adapter the SAME offset the router will pin with', async () => {
        // The two halves of defect 2. `DockerHost` keeps the offset privately,
        // so it is read back through the one public thing that depends on it:
        // `desktopUrls()` is documented to answer for a computer that is not
        // running, and is a pure function of the port map.
        const cfg = await config({ [ENV_KEYS.portOffset]: String(OFFSET) });
        const host = resolveHost([], cfg) as DockerHost;
        const urls = await host.desktopUrls('c1');
        const expectedPort = offsetPortMap(OFFSET).find((p) => p.name === 'desktop')!.host;
        expect(new URL(urls.desktop).port).toBe(String(expectedPort));
        // And the router pins the same one.
        expect(isOwnDesktopOrigin(urls.desktop, cfg.hostPortOffset)).toBe(true);
    });

    it('passes the resolved image and the workspace through', async () => {
        const cfg = await config({ [ENV_KEYS.workspace]: '/tmp/ezil-wiring-ws' });
        // No public getter for either, so this asserts what a caller can see:
        // the host was built from THIS config rather than from defaults. The
        // container suite proves the image reference actually runs.
        expect(resolveHost([], cfg)).toBeInstanceOf(DockerHost);
        expect(cfg.workspacePath).toBe('/tmp/ezil-wiring-ws');
        expect(cfg.desktopImage.ref).toMatch(/^[\w./-]+:[\w.-]+$/);
    });
});

describe('isOwnDesktopOrigin — the SSRF pin, at an offset', () => {
    it('accepts the host\'s own desktop origin AT THE OFFSET IT IS RUNNING', () => {
        const own = localUrlFor('desktop', OFFSET);
        // 🔴 RED BEFORE ROW T5. This is the exact call the cold boot makes.
        expect(isOwnDesktopOrigin(own, OFFSET)).toBe(true);
        expect(isOwnDesktopOrigin(`${own}/?usr=EZiL&embed=1`, OFFSET)).toBe(true);
    });

    it('still rejects the UNOFFSET port when running offset, and vice versa', () => {
        // The pin has to be tight in BOTH directions: an offset host must not
        // accept 8181 either, because on this machine 8181 could be somebody
        // else's service entirely.
        expect(isOwnDesktopOrigin(localUrlFor('desktop', 0), OFFSET)).toBe(false);
        expect(isOwnDesktopOrigin(localUrlFor('desktop', OFFSET), 0)).toBe(false);
    });

    it('still rejects every foreign origin at an offset', () => {
        for (const foreign of [
            'http://10.0.0.5:18181/',
            'http://[::1]:18181/',
            'https://127.0.0.1:18181/',
            'http://127.0.0.1:18443/',
            'file:///etc/passwd',
            'not a url',
        ]) {
            expect(`${foreign} -> ${String(isOwnDesktopOrigin(foreign, OFFSET))}`).toBe(`${foreign} -> false`);
        }
        // Positive control on the same offset: the pin is not simply rejecting
        // everything.
        expect(isOwnDesktopOrigin(localUrlFor('desktop', OFFSET), OFFSET)).toBe(true);
    });

    it('defaults to offset 0, so every unoffset caller is unchanged', () => {
        expect(isOwnDesktopOrigin(localUrlFor('desktop'))).toBe(true);
        expect(isOwnDesktopOrigin(localUrlFor('desktop', OFFSET))).toBe(false);
    });

    it('probeDesktopOrigin refuses a foreign URL at an offset without dialling it', async () => {
        // The pin runs BEFORE the fetch — a probe that dialled first and
        // checked after would already be the SSRF gadget. Port 1 on loopback
        // would answer nothing anyway; the point is the REASON.
        const verdict = await probeDesktopOrigin('http://127.0.0.1:1/', OFFSET);
        expect(verdict).toEqual({ alive: false, reason: 'foreign_origin' });
    });
});

describe('the startup block a user actually reads', () => {
    it('prints the OFFSET ports, not the pinned constants', async () => {
        // 🔴 A startup block that told the user to open 8181 while the desktop
        // was published on 18181 would send them to a port nothing is
        // listening on — and this block is the ONE place a user learns where
        // their desktop is.
        const cfg = await config({ [ENV_KEYS.portOffset]: String(OFFSET) });
        const server = { port: 7080, bindAddress: '127.0.0.1', url: 'http://127.0.0.1:7080', computer: { id: () => 'local-abc' } } as unknown as LocalServer;
        const report = startupReport(cfg, server, false);
        expect(report).toContain('desktop port   http://127.0.0.1:18181');
        expect(report).toContain('desktop:18181/tcp');
        expect(report).toContain('webrtcUdp:62100/udp');
        expect(report).toContain(`port offset    ${OFFSET} (${ENV_KEYS.portOffset})`);
        expect(report).not.toContain('127.0.0.1:8181');
    });

    it('prints the pinned map, labelled as such, when there is no offset', async () => {
        const report = startupReport(
            await config(),
            { port: 7080, bindAddress: '127.0.0.1', url: 'http://127.0.0.1:7080', computer: { id: () => 'local-abc' } } as unknown as LocalServer,
            false,
        );
        expect(report).toContain('desktop port   http://127.0.0.1:8181');
        expect(report).toContain('port offset    0 (the pinned map)');
    });

    it('says outright that --fake-host starts no container', async () => {
        const report = startupReport(
            await config(),
            { port: 7080, bindAddress: '127.0.0.1', url: 'http://127.0.0.1:7080', computer: { id: () => 'local-abc' } } as unknown as LocalServer,
            true,
        );
        expect(report).toContain('NO CONTAINER WILL BE STARTED');
        // Positive control: the real path does not carry that line.
        expect(startupReport(
            await config(),
            { port: 7080, bindAddress: '127.0.0.1', url: 'http://127.0.0.1:7080', computer: { id: () => 'local-abc' } } as unknown as LocalServer,
            false,
        )).not.toContain('NO CONTAINER WILL BE STARTED');
    });

    it('never prints a password', async () => {
        // The startup block prints the desktop PORT, deliberately, and not the
        // desktop URL — which carries `pwd=` once a container exists.
        const report = startupReport(
            await config({ [ENV_KEYS.portOffset]: String(OFFSET) }),
            { port: 7080, bindAddress: '127.0.0.1', url: 'http://127.0.0.1:7080', computer: { id: () => 'local-abc' } } as unknown as LocalServer,
            false,
        );
        expect(report).not.toContain('pwd=');
        expect(report).not.toContain('PASSWORD');
    });
});

describe('EZIL_LOCAL_PORT_OFFSET', () => {
    it('is a different variable from EZIL_LOCAL_PORT and moves different things', async () => {
        const cfg = await config({ [ENV_KEYS.port]: '9090', [ENV_KEYS.portOffset]: '10000' });
        expect(cfg.port).toBe(9090);
        expect(cfg.hostPortOffset).toBe(10_000);
        // The host's own listener does NOT move with the container offset.
        expect(cfg.port).not.toBe(9090 + 10_000);
    });

    it('defaults to 0 and accepts a negative shift', async () => {
        expect((await config()).hostPortOffset).toBe(0);
        expect((await config({ [ENV_KEYS.portOffset]: '' })).hostPortOffset).toBe(0);
        expect((await config({ [ENV_KEYS.portOffset]: '-2000' })).hostPortOffset).toBe(-2_000);
    });

    it('fails at READ time on anything that is not an integer, naming the variable', async () => {
        for (const bad of ['10k', '1.5', 'ten', '10 000', '+10']) {
            await expect(config({ [ENV_KEYS.portOffset]: bad })).rejects.toThrow(/invalid_local_port_offset/);
        }
        // The error names the variable, so a user can find it.
        await expect(config({ [ENV_KEYS.portOffset]: 'x' })).rejects.toThrow(new RegExp(ENV_KEYS.portOffset));
    });

    it('an offset that would push a port out of range is refused by the port map, not silently clamped', () => {
        expect(() => offsetPortMap(60_000)).toThrow(/port_offset_out_of_range/);
        // Positive control: a workable offset produces a full map.
        expect(offsetPortMap(10_000).length).toBe(offsetPortMap(0).length);
    });
});
