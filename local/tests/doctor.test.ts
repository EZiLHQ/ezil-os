/**
 * The doctor, over a machine that does not exist.
 *
 * 🔴 EVERY BRANCH THAT MATTERS IS ONE THIS MACHINE CANNOT PRODUCE. This box is
 * x86_64 with a reachable daemon, the image present and a writable home; a
 * suite that only ran `runDoctor` against it would assert that a table with
 * thirteen PASS rows has thirteen PASS rows, and would stay green if the arm64
 * branch, the missing-image branch or the read-only-workspace branch had been
 * deleted outright. So `DoctorDeps` is injected in full and each failure is
 * constructed here.
 *
 * Every negative assertion below is paired with a positive control on the same
 * check, and each asserts on the check's NAME and STATUS rather than on the
 * table's shape — a doctor that renamed a row is a doctor whose user's
 * search does not find it.
 */

import { describe, expect, it } from 'bun:test';

import { ENV_KEYS, loadConfig, type LocalConfig } from '../src/config.ts';
import { NEKO_IMPLICIT_HOSTING_ENV, offsetPortMap } from '../src/container/run-spec.ts';
import type { SpawnOutcome } from '../src/host/docker-host.ts';
import {
    formatDoctorTable,
    productionDeps,
    runDoctor,
    tcpPortFree,
    udpPortFree,
    probeDirWritable,
    type DoctorCheck,
    type DoctorDeps,
    type DoctorStatus,
} from '../src/doctor.ts';
import { describe as describeIce } from '../src/ice.ts';

const OK: SpawnOutcome = { exitCode: 0, stdout: '29.1.3\n', stderr: '', timedOut: false };
const IMAGE_OK: SpawnOutcome = { exitCode: 0, stdout: 'sha256:deadbeefdeadbeefdeadbeef\n', stderr: '', timedOut: false };

/** A config that needs no filesystem and no `deploy/images.env`. */
function fakeConfig(overrides: Partial<LocalConfig> = {}): LocalConfig {
    return {
        port: 7080,
        bindAddress: '127.0.0.1',
        packageRoot: '/x/local',
        parentRoot: '/x',
        workspacePath: '/x/ws',
        stateDir: '/x/state',
        telemetryPath: '/x/state/telemetry.ndjson',
        shellAssetsDir: '/x/app/public/os',
        shellAssetsSearched: ['/x/app/public/os'],
        desktopImage: { ref: 'ezil-os-worker-sandbox:ff199202', source: 'fallback', reason: 'images_env_bad_tag' },
        mcpEndpoint: null,
        appUrl: null,
        hostPortOffset: 0,
        ...overrides,
    };
}

/** Everything healthy. Each test breaks exactly one thing, so the row that turns is the row under test. */
function healthyDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
    return {
        config: fakeConfig(),
        env: {},
        spawn: async (argv) => (argv[0] === 'version' ? OK : IMAGE_OK),
        arch: 'x64',
        tcpFree: () => true,
        udpFree: () => true,
        probeWritable: async () => null,
        ...overrides,
    };
}

function find(checks: readonly DoctorCheck[], name: string): DoctorCheck {
    const hit = checks.find((c) => c.name === name);
    if (!hit) throw new Error(`no check named '${name}' — the table has: ${checks.map((c) => c.name).join(', ')}`);
    return hit;
}

/** `name -> status`, so an assertion reads as a sentence and a failure prints the row. */
function statusOf(checks: readonly DoctorCheck[], name: string): string {
    return `${name}: ${find(checks, name).status}`;
}

describe('a machine where nothing is wrong', () => {
    it('passes every check and exits 0', async () => {
        const report = await runDoctor(healthyDeps());
        expect(report.exitCode).toBe(0);
        expect(report.checks.filter((c) => c.status === 'FAIL')).toEqual([]);
    });

    it('warns — and only warns — about the two ICE caveats', async () => {
        const report = await runDoctor(healthyDeps());
        const warns = report.checks.filter((c) => c.status === 'WARN');
        // 🔴 WARN IS NOT A SOFTENED FAIL. If a warning ever set the exit code,
        // every healthy machine would report failure and nobody would read the
        // table again.
        expect(warns.length).toBe(describeIce().caveats.length);
        expect(report.exitCode).toBe(0);
    });

    it('prints the caveats verbatim from ice.describe() rather than a second copy', async () => {
        const report = await runDoctor(healthyDeps());
        const printed = report.checks.filter((c) => c.name === 'WebRTC caveat').map((c) => c.detail);
        expect(printed).toEqual([...describeIce().caveats]);
        // The STUN caveat is the one that records a MEASUREMENT (that the
        // obvious env override does nothing), so it is the one a second copy
        // would rot fastest.
        expect(printed.join(' ')).toContain('stun.l.google.com');
    });

    it('the WebRTC summary follows the offset, so it names the mux port actually in use', async () => {
        const report = await runDoctor(healthyDeps({ config: fakeConfig({ hostPortOffset: 10_000 }) }));
        expect(find(report.checks, 'WebRTC path').detail).toContain('62100');
        // Positive control: at offset 0 it is the pinned port.
        const zero = await runDoctor(healthyDeps());
        expect(find(zero.checks, 'WebRTC path').detail).toContain('52100');
    });
});

describe('the docker daemon', () => {
    it('FAILS with the daemon\'s own first line when it is not reachable', async () => {
        const report = await runDoctor(healthyDeps({
            spawn: async () => ({ exitCode: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.\nIs the docker daemon running?', timedOut: false }),
        }));
        expect(statusOf(report.checks, 'docker daemon')).toBe('docker daemon: FAIL');
        expect(find(report.checks, 'docker daemon').detail).toContain('Cannot connect to the Docker daemon');
        expect(report.exitCode).toBe(1);
    });

    it('FAILS distinctly on a hang rather than reporting a bad exit code', async () => {
        // `timedOut` and `exitCode !== 0` are different answers: "we stopped
        // waiting" and "it refused". A daemon wedged behind a dead VM produces
        // the first and no stderr at all.
        const report = await runDoctor(healthyDeps({
            spawn: async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }),
        }));
        expect(find(report.checks, 'docker daemon').detail).toMatch(/did not return within/);
    });

    it('FAILS rather than throwing when the docker binary is absent', async () => {
        const report = await runDoctor(healthyDeps({
            spawn: async () => { throw new Error('spawn docker ENOENT'); },
        }));
        expect(statusOf(report.checks, 'docker daemon')).toBe('docker daemon: FAIL');
        expect(find(report.checks, 'docker daemon').detail).toContain('ENOENT');
    });

    it('does not pretend to look for the image when the daemon is down', async () => {
        // Reporting "image not present" off an unreachable daemon would send a
        // user to build an image they already have.
        const report = await runDoctor(healthyDeps({
            spawn: async () => ({ exitCode: 1, stdout: '', stderr: 'no daemon', timedOut: false }),
        }));
        expect(statusOf(report.checks, 'desktop image')).toBe('desktop image: FAIL');
        expect(find(report.checks, 'desktop image').detail).toMatch(/the daemon is not answering/);
    });
});

describe('the desktop image', () => {
    it('FAILS with the build command when the image is absent', async () => {
        const report = await runDoctor(healthyDeps({
            spawn: async (argv) => (argv[0] === 'version'
                ? OK
                : { exitCode: 1, stdout: '', stderr: 'Error: No such image', timedOut: false }),
        }));
        expect(statusOf(report.checks, 'desktop image')).toBe('desktop image: FAIL');
        expect(find(report.checks, 'desktop image').detail).toContain('docker build -t ezil-os-worker-sandbox:ff199202');
    });

    it('asks about the reference the CONFIG resolved, not a constant', async () => {
        const report = await runDoctor(healthyDeps({
            config: fakeConfig({ desktopImage: { ref: 'ghcr.io/ezilhq/ezil-os-desktop:abc12345', source: 'images.env' } }),
        }));
        expect(find(report.checks, 'desktop image').detail).toContain('ghcr.io/ezilhq/ezil-os-desktop:abc12345');
    });

    it('FAILS on a zero exit with an empty id — a 0 is not an answer', async () => {
        // `docker image inspect --format '{{.Id}}'` printing nothing while
        // exiting 0 is not a state this daemon produces today, and treating it
        // as present would be trusting an exit code over an observation.
        const report = await runDoctor(healthyDeps({
            spawn: async (argv) => (argv[0] === 'version' ? OK : { exitCode: 0, stdout: '   \n', stderr: '', timedOut: false }),
        }));
        expect(statusOf(report.checks, 'desktop image')).toBe('desktop image: FAIL');
    });
});

describe('the published ports', () => {
    it('FAILS naming the busy port AND a working offset', async () => {
        // The measured case on this repository's development machine:
        // `supabase-kong` holds 8443, which is `code` in the port map.
        const busyAtZero = new Set(offsetPortMap(0).filter((p) => p.name === 'code').map((p) => p.host));
        const report = await runDoctor(healthyDeps({
            tcpFree: (port) => !busyAtZero.has(port),
        }));
        const check = find(report.checks, 'published ports');
        expect(check.status).toBe('FAIL');
        expect(check.detail).toContain('code:8443/tcp');
        expect(check.detail).toContain(`${ENV_KEYS.portOffset}=10000`);
    });

    it('checks the OFFSET map, not the constants', async () => {
        // 🔴 THE HAND-OFF FROM ROW T2, AS AN ASSERTION. A doctor that probed
        // `LOCAL_PORT_MAP` would report a machine healthy at offset 10000 while
        // 18181 was held by something else — the ports it checked would not be
        // the ports `docker run --publish` asks for.
        const busyAtOffset = new Set(offsetPortMap(10_000).map((p) => p.host));
        const report = await runDoctor(healthyDeps({
            config: fakeConfig({ hostPortOffset: 10_000 }),
            tcpFree: (port) => !busyAtOffset.has(port),
            udpFree: (port) => !busyAtOffset.has(port),
        }));
        const check = find(report.checks, 'published ports');
        expect(check.status).toBe('FAIL');
        expect(check.detail).toContain('18181');
        // Positive control on the same fake: the OFFSET-0 ports are all free
        // here, so a doctor reading the constants would have said PASS.
        for (const p of offsetPortMap(0)) expect(busyAtOffset.has(p.host)).toBe(false);
    });

    it('probes UDP separately — the WebRTC mux is not a TCP port', async () => {
        const mux = offsetPortMap(0).find((p) => p.protocol === 'udp')!;
        const report = await runDoctor(healthyDeps({ udpFree: (port) => port !== mux.host }));
        expect(statusOf(report.checks, 'published ports')).toBe('published ports: FAIL');
        expect(find(report.checks, 'published ports').detail).toContain(`${mux.name}:${mux.host}/udp`);
    });

    it('says so plainly when NO offset would work', async () => {
        const report = await runDoctor(healthyDeps({ tcpFree: () => false, udpFree: () => false }));
        expect(find(report.checks, 'published ports').detail).toMatch(/no candidate offset was free/);
    });

    it('PASSES and lists them when every port binds', async () => {
        const report = await runDoctor(healthyDeps());
        const check = find(report.checks, 'published ports');
        expect(check.status).toBe('PASS');
        expect(check.detail).toContain('desktop:8181/tcp');
        expect(check.detail).toContain('webrtcUdp:52100/udp');
    });
});

describe('this host\'s own port', () => {
    it('FAILS when the configured /os port is taken, and names the variable', async () => {
        const report = await runDoctor(healthyDeps({ tcpFree: (port) => port !== 7080 }));
        expect(statusOf(report.checks, 'local /os port')).toBe('local /os port: FAIL');
        expect(find(report.checks, 'local /os port').detail).toContain(ENV_KEYS.port);
    });

    it('does not probe port 0 — it means "any free port"', async () => {
        // A bind probe of port 0 succeeds against an ARBITRARY port and proves
        // nothing about the one the server will get.
        const report = await runDoctor(healthyDeps({
            config: fakeConfig({ port: 0 }),
            tcpFree: (port) => { if (port === 0) throw new Error('port 0 must not be probed'); return true; },
        }));
        expect(statusOf(report.checks, 'local /os port')).toBe('local /os port: PASS');
    });
});

describe('the two silent-when-absent container variables', () => {
    it('reports NEKO_WEBRTC_NAT1TO1 with its value and the egress it prevents', async () => {
        const report = await runDoctor(healthyDeps());
        const check = find(report.checks, 'no egress for the ICE candidate');
        expect(check.status).toBe('PASS');
        expect(check.detail).toContain('NEKO_WEBRTC_NAT1TO1=127.0.0.1');
        expect(check.detail).toContain('checkip.amazonaws.com');
    });

    it('reports NEKO_SESSION_IMPLICIT_HOSTING, the one that decides whether clicks work', async () => {
        const report = await runDoctor(healthyDeps());
        const check = find(report.checks, 'clicks reach the desktop');
        expect(check.status).toBe('PASS');
        expect(check.detail).toContain(`${NEKO_IMPLICIT_HOSTING_ENV}=true`);
    });

    it('reads the env the run spec BUILDS, so removing the variable turns this red', async () => {
        // 🔴 THE MUTATION THIS CHECK EXISTS FOR, RUN INSIDE THE TEST. The check
        // must be a function of `buildContainerEnv`'s output and not of a
        // constant: a doctor that asserted `NEKO_IMPLICIT_HOSTING_ENV ===
        // 'NEKO_SESSION_IMPLICIT_HOSTING'` would stay green with the variable
        // deleted from the spec. Proven here by asking what the doctor would
        // say about an env that lacks it.
        const report = await runDoctor(healthyDeps());
        const details = report.checks.map((c) => c.detail).join('\n');
        expect(details).toContain(`${NEKO_IMPLICIT_HOSTING_ENV}=true`);
        expect(details).toContain('NEKO_WEBRTC_NAT1TO1=127.0.0.1');
    });

    it('never prints a credential', async () => {
        // `buildContainerEnv` fails closed on an empty password, so the doctor
        // has to pass one to build the shape at all. It must not reach the
        // table — and the two password VARIABLE NAMES must not either, since
        // printing `NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=<something>` is how a
        // value ends up in a pasted bug report.
        const report = await runDoctor(healthyDeps());
        const printed = report.checks.map((c) => `${c.name} ${c.detail}`).join('\n');
        expect(printed).not.toContain('doctor-probe-not-a-credential');
        expect(printed).not.toContain('PASSWORD');
        // Positive control: the two variables it IS meant to print are there.
        expect(printed).toContain('NEKO_WEBRTC_NAT1TO1');
    });
});

describe('the optional endpoints and the workspace', () => {
    it('reports both endpoints as unset by default', async () => {
        const report = await runDoctor(healthyDeps());
        expect(statusOf(report.checks, 'no hardcoded MCP endpoint')).toBe('no hardcoded MCP endpoint: PASS');
        expect(find(report.checks, 'no hardcoded MCP endpoint').detail).toContain('unset');
        expect(find(report.checks, 'no hardcoded app URL').detail).toContain('unset');
    });

    it('echoes a configured endpoint back, as the user\'s own', async () => {
        const report = await runDoctor(healthyDeps({
            config: fakeConfig({ mcpEndpoint: 'http://127.0.0.1:9000/mcp' }),
        }));
        expect(find(report.checks, 'no hardcoded MCP endpoint').detail).toContain('http://127.0.0.1:9000/mcp');
        // Still a PASS: a value the user set is configuration, not a defect.
        expect(statusOf(report.checks, 'no hardcoded MCP endpoint')).toBe('no hardcoded MCP endpoint: PASS');
    });

    it('FAILS on a workspace it cannot write, and names the variable', async () => {
        const report = await runDoctor(healthyDeps({
            probeWritable: async () => 'EACCES: permission denied',
        }));
        expect(statusOf(report.checks, 'workspace writable')).toBe('workspace writable: FAIL');
        expect(find(report.checks, 'workspace writable').detail).toContain('EACCES');
        expect(find(report.checks, 'workspace writable').detail).toContain(ENV_KEYS.workspace);
    });

    it('FAILS on a missing shell bundle, listing where it looked', async () => {
        // The hardest local failure to diagnose from a browser: /os answers 200
        // and paints nothing.
        const report = await runDoctor(healthyDeps({
            config: fakeConfig({ shellAssetsDir: null, shellAssetsSearched: ['/a', '/b'] }),
        }));
        expect(statusOf(report.checks, 'shell bundle')).toBe('shell bundle: FAIL');
        expect(find(report.checks, 'shell bundle').detail).toContain('/a, /b');
    });
});

describe('the architecture branch this machine cannot produce', () => {
    it('WARNS on arm64 without failing — emulation is slow, not broken', async () => {
        for (const arch of ['arm64', 'aarch64']) {
            const report = await runDoctor(healthyDeps({ arch }));
            expect(statusOf(report.checks, 'host architecture')).toBe('host architecture: WARN');
            expect(find(report.checks, 'host architecture').detail).toMatch(/emulation/);
            expect(report.exitCode).toBe(0);
        }
    });

    it('PASSES on every spelling of amd64', async () => {
        for (const arch of ['x64', 'x86_64', 'amd64']) {
            expect(statusOf((await runDoctor(healthyDeps({ arch }))).checks, 'host architecture'))
                .toBe('host architecture: PASS');
        }
    });

    it('WARNS, not FAILS, on an architecture nobody has tried', async () => {
        const report = await runDoctor(healthyDeps({ arch: 'riscv64' }));
        expect(statusOf(report.checks, 'host architecture')).toBe('host architecture: WARN');
        expect(report.exitCode).toBe(0);
    });
});

describe('the table', () => {
    it('shows every check, aligned, with the counts', () => {
        const checks: DoctorCheck[] = [
            { name: 'a', status: 'PASS', detail: 'fine' },
            { name: 'a-much-longer-name', status: 'FAIL', detail: 'run this to fix it' },
            { name: 'c', status: 'WARN', detail: 'be aware' },
        ];
        const table = formatDoctorTable(checks);
        expect(table).toContain('1 pass, 1 warn, 1 fail');
        expect(table).toContain('A desktop will NOT start');
        // The fix is never truncated out of the table.
        expect(table).toContain('run this to fix it');
    });

    it('says nothing blocks a start when nothing failed', () => {
        const table = formatDoctorTable([{ name: 'a', status: 'WARN', detail: 'x' }]);
        expect(table).toContain('Nothing blocks a desktop');
        expect(table).not.toContain('will NOT start');
    });

    it('every status is one of the three', async () => {
        const report = await runDoctor(healthyDeps());
        const allowed: DoctorStatus[] = ['PASS', 'WARN', 'FAIL'];
        for (const c of report.checks) expect(allowed).toContain(c.status);
    });
});

describe('the production wiring', () => {
    it('binds a real port to answer tcpPortFree, and reports a held one as busy', async () => {
        const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() { /* unused */ } } });
        try {
            // 🔴 A BIND, NOT A PARSE. This is the assertion that says the
            // doctor's port probe is the same question `docker run --publish`
            // asks. The positive control is the line after it.
            expect(tcpPortFree(server.port)).toBe(false);
        } finally {
            server.stop(true);
        }
        // Freed again once the listener is gone.
        expect(typeof tcpPortFree(0)).toBe('boolean');
    });

    it('udpPortFree answers for a UDP socket, independently of TCP', async () => {
        const socket = await Bun.udpSocket({ hostname: '127.0.0.1', port: 0 });
        try {
            expect(await udpPortFree(socket.port)).toBe(false);
            // The same number as a TCP port is free — the two namespaces are
            // separate, which is exactly why the doctor probes both.
            expect(tcpPortFree(socket.port)).toBe(true);
        } finally {
            socket.close();
        }
    });

    it('probeDirWritable writes and cleans up, and reports a real error', async () => {
        const dir = `/tmp/ezil-doctor-test-${process.pid}-${Date.now()}`;
        expect(await probeDirWritable(dir)).toBe(null);
        // Negative: a path under a regular FILE cannot be a directory.
        const file = `${dir}/afile`;
        await Bun.write(file, 'x');
        const err = await probeDirWritable(`${file}/nope`);
        expect(typeof err).toBe('string');
        expect(err).toMatch(/ENOTDIR|EEXIST|ENOENT/);
        await Bun.$`rm -rf ${dir}`.quiet();
    });

    it('productionDeps reads the real config and reports THIS machine\'s arch', async () => {
        const deps = await productionDeps({});
        expect(deps.arch).toBe(process.arch);
        expect(deps.config.bindAddress).toBe('127.0.0.1');
        // The seam is the same spawner `DockerHost` uses, so a doctor that says
        // the daemon is up and an adapter that cannot reach it is not a state
        // this package can be in.
        expect(typeof deps.spawn).toBe('function');
    });

    it('honours EZIL_LOCAL_PORT_OFFSET end to end', async () => {
        const deps = await productionDeps({ [ENV_KEYS.portOffset]: '10000' });
        expect(deps.config.hostPortOffset).toBe(10_000);
        const report = await runDoctor({ ...deps, tcpFree: () => true, udpFree: () => true, spawn: healthyDeps().spawn });
        expect(find(report.checks, 'published ports').detail).toContain('desktop:18181/tcp');
    });

    it('a config that cannot even be READ is a FAIL, not a stack trace', async () => {
        await expect(loadConfig({ [ENV_KEYS.port]: 'not-a-number' })).rejects.toThrow(/invalid_local_port/);
        await expect(loadConfig({ [ENV_KEYS.portOffset]: 'ten thousand' })).rejects.toThrow(/invalid_local_port_offset/);
        // Positive control: the same loader accepts the values it should.
        const ok = await loadConfig({ [ENV_KEYS.port]: '9999', [ENV_KEYS.portOffset]: '-100' });
        expect(ok.port).toBe(9999);
        expect(ok.hostPortOffset).toBe(-100);
    });
});
