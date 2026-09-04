/**
 * The local ICE decision.
 *
 * Two properties, and both are stated as "always", because both are the kind of
 * thing that survives a refactor by being absent rather than by being wrong:
 * `NEKO_WEBRTC_NAT1TO1` must be in every block this module can produce (its
 * absence makes neko call `checkip.amazonaws.com` and advertise the user's
 * public IP), and no TURN field may ever appear (there is no relay to configure
 * and no credential to leak).
 */
import { describe as suite, expect, it } from 'bun:test';
import {
    LOCAL_ICE_ENV_NAMES,
    REFUSED_ICE_FIELDS,
    describe as describeIce,
    localIceEnv,
} from './ice.ts';
import { LOCAL_BIND_ADDRESS, WEBRTC_MUX_PORT, buildContainerEnv, buildDockerRunArgv } from './container/run-spec.ts';

/** Every offset this suite sweeps. 0 is the shipped case; the rest are a machine with a port already taken. */
const OFFSETS = [0, 1, 10_000, -1000];

suite('NEKO_WEBRTC_NAT1TO1 is present in every block this module can produce', () => {
    it('is set to loopback at every offset', () => {
        for (const offset of OFFSETS) {
            const env = localIceEnv({ hostPortOffset: offset });
            expect(env['NEKO_WEBRTC_NAT1TO1']).toBe(LOCAL_BIND_ADDRESS);
        }
    });

    it('is present in the argv the adapter actually hands docker', () => {
        // Positive control for the assertion below: the argv really is an argv
        // full of `--env` pairs, so "NAT1TO1 is in it" is a fact about NAT1TO1.
        const argv = buildDockerRunArgv({
            containerName: 'ezil-os-ice-1',
            image: 'ezil-os-worker-sandbox:ff199202',
            mode: 'neko',
            userPassword: 'u',
            adminPassword: 'a',
        });
        expect(argv.filter((a) => a === '--env').length).toBeGreaterThan(4);
        expect(argv).toContain(`NEKO_WEBRTC_NAT1TO1=${LOCAL_BIND_ADDRESS}`);
    });

    it('the four names are exactly the block, no more and no fewer', () => {
        expect(Object.keys(localIceEnv()).sort()).toEqual([...LOCAL_ICE_ENV_NAMES].sort());
    });

    it('MUTATION SENTINEL: a block with NAT1TO1 dropped is detectable by this suite', () => {
        // The guard above only proves something if its negation is observable.
        // Simulate the mutant (a `localIceEnvFor` that forgot the variable) and
        // assert the same predicate fails — so a real regression cannot pass by
        // making the assertion vacuous.
        const mutant: Record<string, string> = { ...localIceEnv() };
        delete mutant['NEKO_WEBRTC_NAT1TO1'];
        expect(mutant['NEKO_WEBRTC_NAT1TO1']).toBeUndefined();
        expect(Object.keys(mutant).sort()).not.toEqual([...LOCAL_ICE_ENV_NAMES].sort());
    });
});

suite('the mux port moves on both sides of the container boundary', () => {
    it('is the unoffset constant with no offset', () => {
        const env = localIceEnv();
        expect(env['NEKO_WEBRTC_UDPMUX']).toBe(String(WEBRTC_MUX_PORT));
        expect(env['NEKO_WEBRTC_TCPMUX']).toBe(String(WEBRTC_MUX_PORT));
    });

    it('an offset host publishes and an offset neko binds THE SAME number', () => {
        // This is the whole reason `localIceEnvFor` is parameterised. neko
        // advertises `nat1to1:<its own mux port>` as the ICE host candidate, so
        // if the container bound 52100 while the host published 62100 the
        // browser would dial a port nothing is listening on — and every HTTP
        // readiness probe would still pass.
        const offset = 10_000;
        const env = buildContainerEnv({
            containerName: 'ezil-os-ice-2',
            image: 'img:t',
            mode: 'neko',
            userPassword: 'u',
            adminPassword: 'a',
            hostPortOffset: offset,
        });
        const argv = buildDockerRunArgv({
            containerName: 'ezil-os-ice-2',
            image: 'img:t',
            mode: 'neko',
            userPassword: 'u',
            adminPassword: 'a',
            hostPortOffset: offset,
        });
        const inContainer = env['NEKO_WEBRTC_UDPMUX'];
        expect(inContainer).toBe(String(WEBRTC_MUX_PORT + offset));
        expect(argv).toContain(`${LOCAL_BIND_ADDRESS}:${WEBRTC_MUX_PORT + offset}:${inContainer}/udp`);
        expect(argv).toContain(`${LOCAL_BIND_ADDRESS}:${WEBRTC_MUX_PORT + offset}:${inContainer}/tcp`);
    });

    it('the udp and tcp mux are one port, not two', () => {
        for (const offset of OFFSETS) {
            const env = localIceEnv({ hostPortOffset: offset });
            expect(env['NEKO_WEBRTC_UDPMUX']).toBe(env['NEKO_WEBRTC_TCPMUX']);
        }
    });

    it('refuses an offset that would leave the port range instead of composing a nonsense port', () => {
        expect(() => localIceEnv({ hostPortOffset: -60_000 })).toThrow(/port_offset_out_of_range/);
        expect(() => localIceEnv({ hostPortOffset: 1.5 })).toThrow(/invalid_port_offset/);
    });
});

suite('no TURN field is ever emitted', () => {
    it('names no relay, no credential and no ICE server list, at any offset', () => {
        for (const offset of OFFSETS) {
            const serialised = JSON.stringify(localIceEnv({ hostPortOffset: offset }));
            for (const field of REFUSED_ICE_FIELDS) {
                expect(serialised).not.toContain(field);
            }
        }
        // Positive control: the strings being searched for are findable when
        // they are actually there, so the loop above is not passing because
        // `toContain` never matches anything.
        const hostedShape = JSON.stringify({
            NEKO_WEBRTC_ICESERVERS_FRONTEND: '[{"urls":["turn:example:3478"],"username":"u","credential":"c"}]',
            NEKO_WEBRTC_ICETRICKLE: 'true',
        });
        for (const field of ['turn:', 'ICESERVERS', 'ICETRICKLE']) {
            expect(hostedShape).toContain(field);
        }
    });

    it('icelite is on — a lite agent gathers no candidate of its own, which is right when only one can work', () => {
        expect(localIceEnv()['NEKO_WEBRTC_ICELITE']).toBe('true');
        expect(describeIce().iceLite).toBe(true);
        expect(describeIce().usesTurn).toBe(false);
    });
});

suite('checkIceConfig is not reachable from this package', () => {
    it('ice.ts imports nothing from worker/src/desktop-mode.ts', async () => {
        const src = await Bun.file(new URL('./ice.ts', import.meta.url)).text();
        // Positive control: the file really was read and really does import.
        expect(src).toContain("from './container/run-spec.ts'");
        expect(src).not.toMatch(/import\s[^;]*checkIceConfig/);
        expect(src).not.toMatch(/import\s[^;]*from\s+'\.\.\/\.\.\/worker\//);
    });

    it('nothing anywhere under local/src imports checkIceConfig', async () => {
        const { spawnSync } = await import('node:child_process');
        const root = new URL('./', import.meta.url).pathname;
        const hit = spawnSync('grep', ['-rn', '--include=*.ts', 'checkIceConfig', root], { encoding: 'utf8' });
        // grep exits 1 for "no match", which is the answer we want; anything on
        // stdout is a real import (or a mention) and must be looked at.
        const lines = (hit.stdout || '').split('\n').filter((l) => l.trim() !== '' && !l.includes('.test.ts'));
        // The only permitted mentions are prose in a doc comment saying it is
        // NOT used; an actual `import` is the failure.
        expect(lines.filter((l) => /^\s*\S+:\d+:\s*import/.test(l))).toEqual([]);
    });
});

suite('describe() is what a doctor can print', () => {
    it('states the port, the candidate address and that there is no TURN', () => {
        const d = describeIce();
        expect(d.muxPort).toBe(WEBRTC_MUX_PORT);
        expect(d.nat1to1).toBe(LOCAL_BIND_ADDRESS);
        expect(d.summary).toContain(String(WEBRTC_MUX_PORT));
        expect(d.summary).toContain('no TURN');
    });

    it('follows the offset so the doctor prints the port the user actually has', () => {
        expect(describeIce({ hostPortOffset: 10_000 }).muxPort).toBe(WEBRTC_MUX_PORT + 10_000);
    });

    it('carries the measured STUN caveat rather than implying local mode is call-free', () => {
        const caveats = describeIce().caveats.join(' ');
        expect(caveats).toContain('stun.l.google.com');
        expect(caveats).toContain(LOCAL_BIND_ADDRESS);
    });
});
