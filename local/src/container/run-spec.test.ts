/**
 * The drift guard for local mode's container contract.
 *
 * Two other rows build against `./run-spec.ts` in parallel, so the job of this
 * suite is not "does the code run" — it is "can either side of a shared number
 * move without anyone noticing". Every assertion here is written so that a
 * change in `worker/src/desktop-mode.ts` OR in `./run-spec.ts` turns it red.
 *
 * Every negative assertion below is paired with a positive control, and every
 * one asserts on the constraint NAME (`invalid_screen_width`,
 * `missing_neko_password`, `images_env_bad_tag`) rather than on "it threw".
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
    APP_PREVIEW_PORT,
    BROWSER_SIDECAR_PORT,
    CHROME_CDP_PORT,
    CODE_PREVIEW_PORT,
    CONTAINER_WORKSPACE_PATH,
    FOCUS_APPS,
    GUACAMOLE_HTTP_PORT,
    IMAGES_ENV_RELATIVE_PATH,
    LOCAL_BIND_ADDRESS,
    LOCAL_DESKTOP_IMAGE_FALLBACK,
    LOCAL_OS_HOST_PORT,
    LOCAL_PORT_MAP,
    NEKO_HTTP_PORT,
    NEKO_LOCAL_ICE_ENV,
    WEBRTC_MUX_PORT,
    buildContainerEnv,
    buildDockerExecArgv,
    buildDockerImageInspectArgv,
    buildDockerInspectRunningArgv,
    buildDockerLogsArgv,
    buildDockerRemoveArgv,
    buildDockerRunArgv,
    buildDockerVersionArgv,
    buildFocusExecArgv,
    containerBootCommand,
    formatLocalNekoScreen,
    isDockerTag,
    localUrlFor,
    parseImagesEnv,
    publishedPort,
    resolveDesktopImage,
    type DockerRunSpec,
} from './run-spec.ts';
import { portFor } from '../../../worker/src/desktop-mode.ts';

/** Repository root, from this file. `local/src/container/` -> three levels up. */
const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

/** A complete, valid spec every argv test starts from. */
const SPEC: DockerRunSpec = {
    containerName: 'ezil-os-local-c1',
    image: 'ezil-os-worker-sandbox:ff199202',
    mode: 'neko',
    screen: { width: 1920, height: 1080 },
    userPassword: 'u-pw',
    adminPassword: 'a-pw',
};

describe('the in-container ports are the ones worker/src/desktop-mode.ts decides', () => {
    // 🔴 THE NUMERIC LITERALS ARE THE POINT. `run-spec.ts` imports these from
    // `desktop-mode.ts` rather than retyping them, so an equality check between
    // the two would be vacuously true. Asserting the VALUE means a change on
    // either side of the import fails here.
    it('neko is 8181, and it is reached through portFor because upstream exports no bare constant', () => {
        expect(NEKO_HTTP_PORT).toBe(8181);
        expect(portFor('neko').port).toBe(8181);
        expect(NEKO_HTTP_PORT).toBe(portFor('neko').port);
    });

    it('the app preview is 3002 (never 3000 — reserved, PLATFORM-NOTES §5)', () => {
        expect(APP_PREVIEW_PORT).toBe(3002);
        expect(APP_PREVIEW_PORT).not.toBe(3000);
    });

    it('code-server is 8443', () => {
        expect(CODE_PREVIEW_PORT).toBe(8443);
    });

    it('the browser sidecar is 9223 and Chrome CDP is 9222 — different things', () => {
        expect(BROWSER_SIDECAR_PORT).toBe(9223);
        expect(CHROME_CDP_PORT).toBe(9222);
        expect(BROWSER_SIDECAR_PORT).not.toBe(CHROME_CDP_PORT);
    });

    it('guacamole is 8080 and the WebRTC mux is 52100', () => {
        expect(GUACAMOLE_HTTP_PORT).toBe(8080);
        expect(WEBRTC_MUX_PORT).toBe(52100);
    });

    it('the local /os host port is 7080 and collides with no container port', () => {
        expect(LOCAL_OS_HOST_PORT).toBe(7080);
        const containerPorts = LOCAL_PORT_MAP.map((p) => p.container);
        expect(containerPorts).not.toContain(LOCAL_OS_HOST_PORT);
    });

    it('no two published TCP ports share a host port', () => {
        const tcpHostPorts = LOCAL_PORT_MAP.filter((p) => p.protocol === 'tcp').map((p) => p.host);
        expect(new Set(tcpHostPorts).size).toBe(tcpHostPorts.length);
    });

    it('publishedPort finds every name in the table and names the miss otherwise', () => {
        for (const p of LOCAL_PORT_MAP) {
            expect(publishedPort(p.name).container).toBe(p.container);
        }
        // Negative + its message. The cast is the only way to ask for a name
        // the union forbids, which is exactly the runtime case being guarded.
        expect(() => publishedPort('nope' as never)).toThrow(/local_port_map_missing/);
    });

    it('localUrlFor is loopback HTTP, and refuses the UDP port instead of inventing a scheme', () => {
        expect(localUrlFor('desktop')).toBe('http://127.0.0.1:8181');
        expect(localUrlFor('appPreview')).toBe('http://127.0.0.1:3002');
        expect(localUrlFor('code')).toBe('http://127.0.0.1:8443');
        expect(() => localUrlFor('webrtcUdp')).toThrow(/local_url_not_http/);
    });
});

describe('docker run argv', () => {
    it('is exactly this, for a fully specified spec', () => {
        // A golden array rather than a set of spot checks: a new flag, a
        // reordering, or a changed environment value all show up here as a diff
        // a reviewer can read, instead of passing because nothing asserted on it.
        expect(buildDockerRunArgv(SPEC)).toEqual([
            'run', '--detach', '--name', 'ezil-os-local-c1',
            '--cpus=2',
            '--memory=8g',
            '--publish', '127.0.0.1:8181:8181/tcp',
            '--publish', '127.0.0.1:3002:3002/tcp',
            '--publish', '127.0.0.1:8443:8443/tcp',
            '--publish', '127.0.0.1:9223:9223/tcp',
            '--publish', '127.0.0.1:52100:52100/udp',
            '--publish', '127.0.0.1:52100:52100/tcp',
            '--env', 'DESKTOP_MODE=neko',
            '--env', 'NEKO_SCREEN=1920x1080x24',
            '--env', 'NEKO_MEMBER_MULTIUSER_USER_PASSWORD=u-pw',
            '--env', 'NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=a-pw',
            '--env', 'NEKO_WEBRTC_UDPMUX=52100',
            '--env', 'NEKO_WEBRTC_TCPMUX=52100',
            '--env', 'NEKO_WEBRTC_NAT1TO1=127.0.0.1',
            '--env', 'NEKO_WEBRTC_ICELITE=true',
            '--entrypoint', '/bin/bash',
            'ezil-os-worker-sandbox:ff199202',
            '-c', 'DESKTOP_MODE=neko bash /usr/local/bin/start-desktop.sh',
        ]);
    });

    it('publishes every container port on loopback only', () => {
        const argv = buildDockerRunArgv(SPEC);
        const published = argv.filter((_, i) => argv[i - 1] === '--publish');
        expect(published.length).toBe(LOCAL_PORT_MAP.length);
        for (const p of published) {
            expect(p.startsWith(`${LOCAL_BIND_ADDRESS}:`)).toBe(true);
        }
        // Positive control for the negative below: the argv really does contain
        // port publications, so "9222 is absent" is a fact about 9222 and not
        // about an empty list.
        expect(published).toContain('127.0.0.1:9223:9223/tcp');
    });

    it('never publishes Chrome CDP (9222) — unauthenticated and total', () => {
        const argv = buildDockerRunArgv(SPEC);
        expect(argv.some((a) => a.includes(String(CHROME_CDP_PORT)))).toBe(false);
    });

    it('boots the same script the hosted Worker boots', () => {
        // The hosted Worker runs `sandbox.startProcess('DESKTOP_MODE=<mode> bash
        // /usr/local/bin/start-desktop.sh')` (worker/src/index.ts). Local mode
        // must hand `docker run` the byte-identical command, or the two paths
        // are two products.
        expect(containerBootCommand('neko')).toBe('DESKTOP_MODE=neko bash /usr/local/bin/start-desktop.sh');
        const argv = buildDockerRunArgv(SPEC);
        expect(argv).toContain(containerBootCommand('neko'));
        expect(argv[argv.length - 2]).toBe('-c');
        expect(argv[argv.length - 3]).toBe(SPEC.image);
    });

    it('bind-mounts a workspace and sets EZIL_WORKSPACE_ROOT only when one is given', () => {
        const withMount = buildDockerRunArgv({ ...SPEC, workspaceHostPath: '/home/me/proj' });
        expect(withMount).toContain('--volume');
        expect(withMount).toContain(`/home/me/proj:${CONTAINER_WORKSPACE_PATH}`);
        expect(withMount).toContain(`EZIL_WORKSPACE_ROOT=${CONTAINER_WORKSPACE_PATH}`);

        const without = buildDockerRunArgv(SPEC);
        expect(without).not.toContain('--volume');
        expect(without.some((a) => a.startsWith('EZIL_WORKSPACE_ROOT='))).toBe(false);
    });

    it('refuses a relative workspace path by name', () => {
        expect(() => buildDockerRunArgv({ ...SPEC, workspaceHostPath: 'proj' }))
            .toThrow(/workspace_host_path_not_absolute/);
    });

    it('honours cpus/memory overrides', () => {
        const argv = buildDockerRunArgv({ ...SPEC, cpus: 4, memory: '16g' });
        expect(argv).toContain('--cpus=4');
        expect(argv).toContain('--memory=16g');
    });
});

describe('the local ICE environment', () => {
    // 🔴 THE ASSERTION THIS SUITE EXISTS FOR.
    // `--webrtc.ip_retrieval_url` defaults to `https://checkip.amazonaws.com`
    // and neko fetches it whenever `nat1to1` is unset. Losing this variable is
    // not a broken desktop — it is a silent outbound call to Amazon from a
    // product whose premise is that it runs on your own machine.
    it('always carries NEKO_WEBRTC_NAT1TO1 in the built argv', () => {
        const argv = buildDockerRunArgv(SPEC);
        expect(argv).toContain('NEKO_WEBRTC_NAT1TO1=127.0.0.1');
        // And in the environment map, which is the other way it reaches docker.
        expect(buildContainerEnv(SPEC)['NEKO_WEBRTC_NAT1TO1']).toBe('127.0.0.1');
        // Present even when the caller passes unrelated extra environment.
        expect(buildDockerRunArgv({ ...SPEC, extraEnv: { EZIL_BROWSER_SIDECAR: 'on' } }))
            .toContain('NEKO_WEBRTC_NAT1TO1=127.0.0.1');
    });

    it('pins the mux to one port on both transports', () => {
        expect(NEKO_LOCAL_ICE_ENV['NEKO_WEBRTC_UDPMUX']).toBe('52100');
        expect(NEKO_LOCAL_ICE_ENV['NEKO_WEBRTC_TCPMUX']).toBe('52100');
        expect(NEKO_LOCAL_ICE_ENV['NEKO_WEBRTC_ICELITE']).toBe('true');
        // Measured against the pinned image: these are the env forms of
        // `--webrtc.{udpmux,tcpmux,nat1to1,icelite}`. Exactly four, so a fifth
        // added without a measurement fails here.
        expect(Object.keys(NEKO_LOCAL_ICE_ENV).sort()).toEqual([
            'NEKO_WEBRTC_ICELITE', 'NEKO_WEBRTC_NAT1TO1', 'NEKO_WEBRTC_TCPMUX', 'NEKO_WEBRTC_UDPMUX',
        ]);
    });

    it('mints no TURN credential and names no TURN server', () => {
        const argv = buildDockerRunArgv(SPEC).join(' ');
        expect(argv).not.toContain('ICESERVERS');
        expect(argv.toLowerCase()).not.toContain('turn');
        // Positive control: the argv is non-trivial and does carry ICE config.
        expect(argv).toContain('NEKO_WEBRTC_ICELITE=true');
    });
});

describe('the container environment', () => {
    it('fails closed on an empty password rather than inheriting neko\'s public defaults', () => {
        expect(() => buildContainerEnv({ ...SPEC, userPassword: '' })).toThrow(/missing_neko_password/);
        expect(() => buildContainerEnv({ ...SPEC, adminPassword: '' })).toThrow(/missing_neko_password/);
        // Positive control: the same builder succeeds with both set.
        expect(buildContainerEnv(SPEC)['NEKO_MEMBER_MULTIUSER_USER_PASSWORD']).toBe('u-pw');
    });

    it('refuses the guacamole mode by name instead of booting the wrong desktop', () => {
        expect(() => buildContainerEnv({ ...SPEC, mode: 'guacamole' })).toThrow(/unsupported_local_mode/);
    });

    it('refuses an environment name that could smuggle a second assignment', () => {
        expect(() => buildContainerEnv({ ...SPEC, extraEnv: { 'A=B': 'c' } })).toThrow(/invalid_env_name/);
        expect(() => buildContainerEnv({ ...SPEC, extraEnv: { '1BAD': 'c' } })).toThrow(/invalid_env_name/);
        // Positive control: a legal name is accepted.
        expect(buildContainerEnv({ ...SPEC, extraEnv: { EZIL_BROWSER_SIDECAR: 'on' } })['EZIL_BROWSER_SIDECAR']).toBe('on');
    });

    it('defaults NEKO_SCREEN to 1920x1080x24 and enforces what X would silently take away', () => {
        const noScreen: DockerRunSpec = {
            containerName: SPEC.containerName, image: SPEC.image, mode: SPEC.mode,
            userPassword: SPEC.userPassword, adminPassword: SPEC.adminPassword,
        };
        expect(buildContainerEnv(noScreen)['NEKO_SCREEN']).toBe('1920x1080x24');
        expect(formatLocalNekoScreen({ width: 1176, height: 1448 })).toBe('1176x1448x24');
        // Xvfb floors width to a multiple of 8 and reports success for the ask.
        expect(() => formatLocalNekoScreen({ width: 900, height: 1600 })).toThrow(/invalid_screen_width/);
        // An odd height is vp8 chroma artefacts.
        expect(() => formatLocalNekoScreen({ width: 1280, height: 721 })).toThrow(/invalid_screen_height/);
        expect(() => formatLocalNekoScreen({ width: 0, height: 720 })).toThrow(/invalid_screen/);
    });
});

describe('docker exec argv', () => {
    it('passes the command through as an array, never as a shell string', () => {
        expect(buildDockerExecArgv('c1', ['bash', '-lc', 'echo hi']))
            .toEqual(['exec', 'c1', 'bash', '-lc', 'echo hi']);
        expect(buildDockerExecArgv('c1', ['ls'], { user: 'neko' }))
            .toEqual(['exec', '--user', 'neko', 'c1', 'ls']);
        expect(() => buildDockerExecArgv('c1', [])).toThrow(/empty_exec_argv/);
    });

    it('builds the focus command from the closed enum only', () => {
        expect(buildFocusExecArgv('c1', 'chromium'))
            .toEqual(['exec', 'c1', '/usr/local/bin/neko-switch-app.sh', 'chromium']);
        expect(() => buildFocusExecArgv('c1', 'firefox' as never)).toThrow(/invalid_focus_app/);
    });

    it('the rest of the verb set is the shape the SandboxHost interface implies', () => {
        expect(buildDockerRemoveArgv('c1')).toEqual(['rm', '--force', 'c1']);
        expect(buildDockerInspectRunningArgv('c1')).toEqual(['inspect', '--format', '{{.State.Running}}', 'c1']);
        expect(buildDockerLogsArgv('c1', 40)).toEqual(['logs', '--tail', '40', 'c1']);
        expect(buildDockerLogsArgv('c1')).toEqual(['logs', '--tail', '200', 'c1']);
        expect(() => buildDockerLogsArgv('c1', 0)).toThrow(/invalid_tail_lines/);
        expect(buildDockerVersionArgv()).toEqual(['version', '--format', '{{.Server.Version}}']);
        expect(buildDockerImageInspectArgv('a:b')).toEqual(['image', 'inspect', '--format', '{{.Id}}', 'a:b']);
    });
});

describe('FOCUS_APPS has not drifted from the Worker', () => {
    // A SOURCE-TEXT check rather than an import, and the reason is measured:
    // `worker/src/sandbox-control.ts` typechecks clean under the Worker's own
    // tsconfig but reports TS2532 at 243:21 and TS2322 at 415:5 under this
    // package's `noUncheckedIndexedAccess`. T0 does not own that file, so it is
    // held to this copy by text — the same technique `worker/src/
    // screen-modes.test.ts` uses for its own cross-deploy-target twin.
    const SOURCE = readFileSync(join(REPO_ROOT, 'worker', 'src', 'sandbox-control.ts'), 'utf8');

    it('the upstream literal was actually found (positive control for the diff below)', () => {
        expect(SOURCE.length).toBeGreaterThan(1000);
        expect(SOURCE).toContain('export const FOCUS_APPS');
    });

    it('lists the same apps, in the same order', () => {
        const m = SOURCE.match(/export const FOCUS_APPS = \[([^\]]*)\] as const;/);
        expect(m).not.toBeNull();
        const upstream = (m?.[1] ?? '').split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter((s) => s !== '');
        // Non-empty, or the comparison below would be `[] === []`.
        expect(upstream.length).toBeGreaterThan(0);
        expect(upstream).toEqual([...FOCUS_APPS]);
    });
});

describe('deploy/images.env', () => {
    const IMAGES_ENV_PATH = join(REPO_ROOT, IMAGES_ENV_RELATIVE_PATH);
    const TEXT = readFileSync(IMAGES_ENV_PATH, 'utf8');
    const ENTRIES = parseImagesEnv(TEXT);

    it('parses to the four pinned keys, comments and blanks dropped', () => {
        expect(Object.keys(ENTRIES).sort()).toEqual([
            'EZIL_DESKTOP_IMAGE', 'EZIL_DESKTOP_TAG', 'EZIL_NEKO_IMAGE', 'EZIL_NEKO_TAG',
        ]);
        expect(ENTRIES['EZIL_DESKTOP_IMAGE']).toBe('ghcr.io/ezilhq/ezil-os-desktop');
        expect(ENTRIES['EZIL_NEKO_IMAGE']).toBe('ghcr.io/ezilhq/ezil-neko-vscode');
        expect(ENTRIES['EZIL_NEKO_TAG']).toBe('d74052bb-049931d7');
    });

    it('never pins a floating tag', () => {
        expect(ENTRIES['EZIL_DESKTOP_TAG']).not.toBe('latest');
        expect(ENTRIES['EZIL_NEKO_TAG']).not.toBe('latest');
    });

    // Stated as an INVARIANT, so it stays true after row T3 pins a real tag:
    // a usable tag resolves from the file, an unusable one resolves to the
    // fallback and says why. Today the file carries the placeholder, so this
    // exercises the fallback branch against real shipped content.
    it('resolves to a runnable reference either way, and never composes a placeholder', () => {
        const resolved = resolveDesktopImage(ENTRIES);
        const tag = ENTRIES['EZIL_DESKTOP_TAG'] ?? '';
        if (isDockerTag(tag)) {
            expect(resolved.source).toBe('images.env');
            expect(resolved.ref).toBe(`${ENTRIES['EZIL_DESKTOP_IMAGE']}:${tag}`);
        } else {
            expect(resolved.source).toBe('fallback');
            expect(resolved.reason).toMatch(/images_env_bad_tag/);
            expect(resolved.ref).toBe(LOCAL_DESKTOP_IMAGE_FALLBACK);
        }
        // Whichever branch ran, the result is a syntactically valid reference —
        // this is the assertion that would have caught `<to be pinned by CI>`.
        expect(resolved.ref).toMatch(/^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9_][A-Za-z0-9._-]*$/);
        expect(resolved.ref).not.toContain(' ');
        expect(resolved.ref).not.toContain('<');
    });

    it('the shipped placeholder is rejected by the tag grammar (positive control: a real tag is not)', () => {
        expect(isDockerTag('<to be pinned by CI>')).toBe(false);
        expect(isDockerTag('')).toBe(false);
        expect(isDockerTag('-leading-dash')).toBe(false);
        expect(isDockerTag('d74052bb-049931d7')).toBe(true);
        expect(isDockerTag('ff199202')).toBe(true);
        expect(isDockerTag('0.3.1')).toBe(true);
    });

    it('falls back with a named reason for every unusable shape', () => {
        expect(resolveDesktopImage({}).reason).toMatch(/images_env_incomplete/);
        expect(resolveDesktopImage({ EZIL_DESKTOP_IMAGE: 'ghcr.io/x/y' }).reason).toMatch(/images_env_incomplete/);
        expect(resolveDesktopImage({ EZIL_DESKTOP_IMAGE: 'BAD NAME', EZIL_DESKTOP_TAG: 'v1' }).reason)
            .toMatch(/images_env_bad_image_name/);
        // Positive control: a good pair resolves from the file with no reason.
        const ok = resolveDesktopImage({ EZIL_DESKTOP_IMAGE: 'ghcr.io/ezilhq/ezil-os-desktop', EZIL_DESKTOP_TAG: 'abc12345' });
        expect(ok).toEqual({ ref: 'ghcr.io/ezilhq/ezil-os-desktop:abc12345', source: 'images.env' });
    });

    it('the parser drops comments and blanks and keeps values containing "="', () => {
        expect(parseImagesEnv('# c\n\nA=1\nB=x=y\n  C = 3  \n=bad\n')).toEqual({ A: '1', B: 'x=y', C: '3' });
    });
});
