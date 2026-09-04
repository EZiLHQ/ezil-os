/**
 * The two questions `SandboxHost` cannot answer, over a fake neko.
 *
 * The container suite proves these work against a real desktop. It cannot prove
 * what they do when neko answers something UNEXPECTED — a renamed field, a 401,
 * a body that is not an array — and those are the answers that decide whether a
 * future neko bump quietly downgrades every desktop to `ready_unverified`
 * (survivable) or shows every user a failure panel over a working picture
 * (`docs/PLATFORM-NOTES.md` §16b: "the same lie as the one being fixed, sign
 * flipped, and total").
 *
 * So every branch is driven here through the `fetch` seam, and every negative
 * has a positive control on the same fake.
 */

import { describe, expect, it } from 'bun:test';

import {
    canIntrospect,
    countWatchers,
    readImplicitHosting,
} from '../src/host/display-probe.ts';
import { DockerHost, NEKO_ROOM_SETTINGS_PATH } from '../src/host/docker-host.ts';
import { FakeSandboxHost } from '../src/server/fake-host.ts';
import { NEKO_ADMIN_PASSWORD_ENV, NEKO_USER_PASSWORD_ENV } from '../src/container/run-spec.ts';

/** A 32-character value, because `assertNotDefault` refuses anything shorter as a weak credential. */
const FAKE_PW = 'f'.repeat(32);
const ID = 'c1';

/** A `docker inspect` that reports one running container carrying credentials, so `credentialsFor` resolves without a daemon. */
function inspectingSpawn() {
    return async () => ({
        exitCode: 0,
        stdout: `true\t0\timg\t${JSON.stringify([`${NEKO_USER_PASSWORD_ENV}=${FAKE_PW}`, `${NEKO_ADMIN_PASSWORD_ENV}=${FAKE_PW}`])}`,
        stderr: '',
        timedOut: false,
    });
}

/** A neko that answers a scripted body for each path. Records what was asked, so "it logged out" is an observation. */
function fakeNeko(routes: Record<string, { status?: number; body?: unknown; text?: string }>) {
    const seen: string[] = [];
    const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
        const path = new URL(input).pathname;
        seen.push(`${init?.method ?? 'GET'} ${path}`);
        const route = routes[path];
        if (route === undefined) return new Response('not scripted', { status: 404 });
        const status = route.status ?? 200;
        const body = route.text ?? JSON.stringify(route.body ?? null);
        return new Response(body, { status, headers: { 'content-type': 'application/json' } });
    };
    return { fetch, seen };
}

const LOGIN_OK = { body: { id: 'x', token: 't-123', profile: { is_admin: true }, state: {} } };

function hostWith(routes: Record<string, { status?: number; body?: unknown; text?: string }>) {
    const neko = fakeNeko(routes);
    const host = new DockerHost({ spawn: inspectingSpawn(), fetch: neko.fetch, credentialSecret: 's' });
    return { host, neko };
}

describe('countWatchers — the strict parse §16b demands', () => {
    it('counts only entries whose is_watching is a real boolean', () => {
        expect(countWatchers([
            { state: { is_watching: true } },
            { state: { is_watching: false } },
            { state: { is_watching: true } },
        ])).toEqual({ sessions: 3, watching: 2 });
    });

    it('an empty list is understood, and it means nobody is watching', () => {
        // Distinct from "not understood": zero sessions is an ANSWER.
        expect(countWatchers([])).toEqual({ sessions: 0, watching: 0 });
    });

    it('ONE unreadable entry makes the WHOLE count untrustworthy', () => {
        // 🔴 The rule this function exists for. The unreadable entry could be
        // the watcher, so a count that skipped it would report `blank` over a
        // streaming desktop.
        for (const bad of [
            { state: { is_watching: 'true' } },
            { state: { is_watching: 1 } },
            { state: {} },
            { state: null },
            {},
            null,
            'not an object',
        ]) {
            expect(countWatchers([{ state: { is_watching: true } }, bad])).toBe(null);
        }
        // Positive control: the same list without the bad entry parses.
        expect(countWatchers([{ state: { is_watching: true } }])).toEqual({ sessions: 1, watching: 1 });
    });

    it('anything that is not an array is not understood', () => {
        for (const body of [null, undefined, {}, 'x', 3]) expect(countWatchers(body)).toBe(null);
    });
});

describe('readImplicitHosting — only a literal true is implicit', () => {
    it('reads the field neko actually returns', () => {
        // The MEASURED body, verbatim from the pinned image.
        expect(readImplicitHosting({
            private_mode: false, locked_logins: false, locked_controls: false, control_protection: false,
            implicit_hosting: true, inactive_cursors: false, merciful_reconnect: true, heartbeat_interval: 10, plugins: null,
        })).toBe('implicit');
    });

    it('is manual for false, for a stringly true, for a missing field and for a non-object', () => {
        expect(readImplicitHosting({ implicit_hosting: false })).toBe('manual');
        expect(readImplicitHosting({ implicit_hosting: 'true' })).toBe('manual');
        expect(readImplicitHosting({})).toBe('manual');
        expect(readImplicitHosting(null)).toBe('manual');
        expect(readImplicitHosting('implicit_hosting: true')).toBe('manual');
    });
});

describe('canIntrospect — the capability seam', () => {
    it('recognises a DockerHost', () => {
        expect(canIntrospect(new DockerHost())).toBe(true);
    });

    it('does NOT recognise the fake host, which is what keeps the honest fallback reachable', () => {
        // 🔴 THE POSITIVE CONTROL FOR THE `unknown` BRANCH. `shell-contract.test.ts`
        // asserts that `confirm=display` answers `unknown` over the fake host;
        // that test is only meaningful because this is false.
        expect(canIntrospect(new FakeSandboxHost())).toBe(false);
    });

    it('refuses half a capability and every non-object', () => {
        expect(canIntrospect({ probeDisplay: () => {} })).toBe(false);
        expect(canIntrospect({ readControlMode: () => {} })).toBe(false);
        expect(canIntrospect({ probeDisplay: 1, readControlMode: 2 })).toBe(false);
        for (const v of [null, undefined, 'x', 3, []]) expect(canIntrospect(v)).toBe(false);
    });
});

describe('DockerHost.probeDisplay', () => {
    it('is live when a peer is watching, and reports the counts', async () => {
        const { host } = hostWith({
            '/api/login': LOGIN_OK,
            '/api/sessions': { body: [{ state: { is_watching: true } }, { state: { is_watching: false } }] },
            '/api/logout': { body: {} },
        });
        expect(await host.probeDisplay(ID)).toEqual({ display: 'live', sessions: 2, watching: 1 });
    });

    it('is blank — not unknown — when the list is understood and nobody is watching', async () => {
        const { host } = hostWith({
            '/api/login': LOGIN_OK,
            '/api/sessions': { body: [{ state: { is_watching: false } }] },
            '/api/logout': { body: {} },
        });
        expect(await host.probeDisplay(ID)).toEqual({ display: 'blank', sessions: 1, watching: 0 });
    });

    it('is unknown for a login failure, a 401, a non-array and an unreadable entry', async () => {
        const cases: Array<[string, Record<string, { status?: number; body?: unknown; text?: string }>, RegExp]> = [
            ['login refused', { '/api/login': { status: 401, body: {} } }, /login_failed/],
            ['login without a token', { '/api/login': { body: { profile: { is_admin: true } } } }, /login_failed/],
            ['sessions 401', { '/api/login': LOGIN_OK, '/api/sessions': { status: 401, body: {} }, '/api/logout': { body: {} } }, /http_error_401/],
            ['sessions not an array', { '/api/login': LOGIN_OK, '/api/sessions': { body: { sessions: [] } }, '/api/logout': { body: {} } }, /unrecognised/],
            ['a renamed field', { '/api/login': LOGIN_OK, '/api/sessions': { body: [{ state: { watching: true } }] }, '/api/logout': { body: {} } }, /unrecognised/],
            ['a body that is not JSON', { '/api/login': LOGIN_OK, '/api/sessions': { text: '<html>' }, '/api/logout': { body: {} } }, /unrecognised/],
        ];
        for (const [label, routes, reason] of cases) {
            const { host } = hostWith(routes);
            const probe = await host.probeDisplay(ID);
            // 🔴 NEVER `blank`. A renamed field must downgrade every desktop to
            // `ready_unverified`, never show a failure panel over a working one.
            expect(`${label}: ${probe.display}`).toBe(`${label}: unknown`);
            expect(probe.reason ?? '').toMatch(reason);
        }
    });

    it('is unknown, not a throw, when the transport fails', async () => {
        const host = new DockerHost({
            spawn: inspectingSpawn(),
            fetch: async () => { throw new Error('ECONNREFUSED'); },
            credentialSecret: 's',
        });
        const probe = await host.probeDisplay(ID);
        expect(probe.display).toBe('unknown');
        expect(probe.reason).toMatch(/login_failed|unreachable/);
    });

    it('LOGS OUT every session it opens', async () => {
        // 🔴 The shell polls this gate about once a second. A login per poll
        // with no logout mints a session per poll — and every leaked session is
        // another entry in the array this very function counts, so the probe
        // would end up measuring itself. Measured while writing this row: five
        // un-logged-out probe logins left five sessions in `GET /api/sessions`.
        const { host, neko } = hostWith({
            '/api/login': LOGIN_OK,
            '/api/sessions': { body: [] },
            '/api/logout': { body: {} },
        });
        await host.probeDisplay(ID);
        expect(neko.seen).toEqual(['POST /api/login', 'GET /api/sessions', 'POST /api/logout']);
        // And on the failure path too, where it is easiest to forget.
        const failing = hostWith({ '/api/login': LOGIN_OK, '/api/sessions': { status: 500, body: {} }, '/api/logout': { body: {} } });
        await failing.host.probeDisplay(ID);
        expect(failing.neko.seen).toContain('POST /api/logout');
    });
});

describe('DockerHost.readControlMode', () => {
    it('is implicit only when neko itself says implicit_hosting is true', async () => {
        const { host, neko } = hostWith({
            '/api/login': LOGIN_OK,
            [NEKO_ROOM_SETTINGS_PATH]: { body: { implicit_hosting: true, heartbeat_interval: 10 } },
            '/api/logout': { body: {} },
        });
        expect(await host.readControlMode(ID)).toBe('implicit');
        // 🔴 A READ, NOT A WRITE. The hosted `enableImplicitHosting` POSTs the
        // merged settings back when the flag is off; this host set it at BOOT,
        // so a POST here would mean the environment variable had not taken and
        // we were papering over it. There must be exactly one GET.
        expect(neko.seen.filter((s) => s.endsWith(NEKO_ROOM_SETTINGS_PATH))).toEqual([`GET ${NEKO_ROOM_SETTINGS_PATH}`]);
    });

    it('is manual for false — the image default, and the container-level mutation this row proves', async () => {
        const { host } = hostWith({
            '/api/login': LOGIN_OK,
            // Exactly what a container booted WITHOUT
            // NEKO_SESSION_IMPLICIT_HOSTING answers, because the image's
            // /etc/neko/neko.yaml sets it false.
            [NEKO_ROOM_SETTINGS_PATH]: { body: { implicit_hosting: false } },
            '/api/logout': { body: {} },
        });
        expect(await host.readControlMode(ID)).toBe('manual');
    });

    it('is manual for a login failure, a 500, a non-JSON body and a thrown transport', async () => {
        expect(await hostWith({ '/api/login': { status: 401, body: {} } }).host.readControlMode(ID)).toBe('manual');
        expect(await hostWith({
            '/api/login': LOGIN_OK,
            [NEKO_ROOM_SETTINGS_PATH]: { status: 500, body: {} },
            '/api/logout': { body: {} },
        }).host.readControlMode(ID)).toBe('manual');
        expect(await hostWith({
            '/api/login': LOGIN_OK,
            [NEKO_ROOM_SETTINGS_PATH]: { text: 'not json' },
            '/api/logout': { body: {} },
        }).host.readControlMode(ID)).toBe('manual');
        const thrown = new DockerHost({ spawn: inspectingSpawn(), fetch: async () => { throw new Error('boom'); }, credentialSecret: 's' });
        expect(await thrown.readControlMode(ID)).toBe('manual');
    });

    it('logs out its session too', async () => {
        const { host, neko } = hostWith({
            '/api/login': LOGIN_OK,
            [NEKO_ROOM_SETTINGS_PATH]: { body: { implicit_hosting: true } },
            '/api/logout': { body: {} },
        });
        await host.readControlMode(ID);
        expect(neko.seen).toEqual(['POST /api/login', `GET ${NEKO_ROOM_SETTINGS_PATH}`, 'POST /api/logout']);
    });

    it('is manual — never a throw — for a container running on the image\'s own passwords', async () => {
        // `credentialsFor` THROWS for a container with no password env, because
        // connecting to it would be connecting to a desktop anyone can log
        // into. That refusal must not escape onto the desktop-open path.
        const noCreds = new DockerHost({
            spawn: async () => ({ exitCode: 0, stdout: 'true\t0\timg\t[]', stderr: '', timedOut: false }),
            fetch: async () => new Response('{}', { status: 200 }),
            credentialSecret: 's',
        });
        expect(await noCreds.readControlMode(ID)).toBe('manual');
        const probe = await noCreds.probeDisplay(ID);
        expect(probe.display).toBe('unknown');
        expect(probe.reason).toMatch(/container_without_credentials/);
    });
});
