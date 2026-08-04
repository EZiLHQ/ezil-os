/**
 * Tests for the shell's boot payload.
 *
 * Two things matter here and neither is cosmetic:
 *
 *   1. The payload is INLINED INTO HTML inside a `<script>`. A computer name
 *      is user-controlled text, so if it can close that element it can run
 *      arbitrary script in the user's own session. `serializeBootPayload` is
 *      the only thing standing between those two facts.
 *   2. No secret is representable in the payload. The desktop Worker URL and
 *      the HMAC secret must never cross to the browser — the whole reason
 *      `cloudflareGuacamole` returns booleans instead of config.
 */

import { describe, expect, it } from 'vitest';

import type { Computer } from '@/server/db/schema';
import {
    SHELL_API_ROUTES,
    SHELL_APPS,
    bootPayloadScript,
    buildShellBootPayload,
    serializeBootPayload,
    toShellBootComputer,
    toShellDesktopState,
} from './boot-payload';

const USER = { id: '11111111-1111-1111-1111-111111111111', email: 'user@example.com' };

function computer(overrides: Partial<Computer> = {}): Computer {
    return {
        id: '33333333-3333-3333-3333-333333333333',
        userId: USER.id,
        name: 'Computer',
        slot: 1,
        createdAt: new Date('2026-07-31T09:00:00.000Z'),
        lastOpenedAt: null,
        deletedAt: null,
        metadata: null,
        ...overrides,
    };
}

describe('serializeBootPayload — the payload is inlined into a <script>', () => {
    it('escapes every "<" so a computer name cannot close the script element', () => {
        const payload = buildShellBootPayload({
            user: USER,
            computer: computer({ name: '</script><script>alert(1)</script>' }),
            isNew: false,
            provider: { isConfigured: true, hasHmacSecret: true },
        });

        const serialized = serializeBootPayload(payload);

        expect(serialized).not.toContain('<');
        expect(serialized).not.toContain('</script');
        // …and the shell still receives the ORIGINAL text, byte for byte.
        expect(JSON.parse(serialized).computer.name).toBe('</script><script>alert(1)</script>');
    });

    it('escapes "<!--", which would otherwise open an HTML comment mid-script', () => {
        const payload = buildShellBootPayload({
            user: { ...USER, email: 'a<!--b@example.com' },
            computer: computer(),
            isNew: false,
            provider: null,
        });

        const serialized = serializeBootPayload(payload);

        expect(serialized).not.toContain('<!--');
        expect(JSON.parse(serialized).user.email).toBe('a<!--b@example.com');
    });

    it('escapes U+2028 / U+2029 without changing what the shell parses', () => {
        const payload = buildShellBootPayload({
            user: USER,
            computer: computer({ name: 'a\u2028b\u2029c' }),
            isNew: false,
            provider: null,
        });

        const serialized = serializeBootPayload(payload);

        expect(serialized).not.toContain('\u2028');
        expect(serialized).not.toContain('\u2029');
        expect(JSON.parse(serialized).computer.name).toBe('a\u2028b\u2029c');
    });

    it('bootPayloadScript assigns the global and cannot bypass the escaping', () => {
        const script = bootPayloadScript(
            buildShellBootPayload({
                user: USER,
                computer: computer({ name: '</script>' }),
                isNew: true,
                provider: null,
            }),
        );

        expect(script.startsWith('window.__EZIL_BOOT__=')).toBe(true);
        expect(script).not.toContain('</script>');
        // It is valid JS that reproduces the payload.
        expect(JSON.parse(script.slice('window.__EZIL_BOOT__='.length, -1)).computer.name).toBe(
            '</script>',
        );
    });
});

describe('buildShellBootPayload', () => {
    it('carries exactly { user, computer, apps, desktopState } and nothing else', () => {
        const payload = buildShellBootPayload({
            user: USER,
            computer: computer(),
            isNew: false,
            provider: { isConfigured: true, hasHmacSecret: true },
        });

        expect(Object.keys(payload).sort()).toEqual(['apps', 'computer', 'desktopState', 'user']);
    });

    it('crosses dates as ISO strings — the shell is jQuery, there is no superjson', () => {
        const payload = buildShellBootPayload({
            user: USER,
            computer: computer({ lastOpenedAt: new Date('2026-07-31T10:30:00.000Z') }),
            isNew: false,
            provider: null,
        });

        expect(payload.computer.createdAt).toBe('2026-07-31T09:00:00.000Z');
        expect(payload.computer.lastOpenedAt).toBe('2026-07-31T10:30:00.000Z');
        // Round-trips through JSON with no transformer and no loss.
        expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
    });

    it('reports a never-opened computer as null rather than inventing a timestamp', () => {
        const payload = buildShellBootPayload({
            user: USER,
            computer: computer({ lastOpenedAt: null }),
            isNew: true,
            provider: null,
        });

        expect(payload.computer.lastOpenedAt).toBeNull();
        expect(payload.computer.isNew).toBe(true);
    });

    it('never fakes an email for an identity with none', () => {
        const payload = buildShellBootPayload({
            user: { id: USER.id },
            computer: computer(),
            isNew: false,
            provider: null,
        });

        expect(payload.user.email).toBeNull();
    });

    it('leaks no row internals the shell has no business with', () => {
        const payload = buildShellBootPayload({
            user: USER,
            computer: computer(),
            isNew: false,
            provider: null,
        });

        // `userId` is redundant (it is `user.id`), `deletedAt` is always null
        // for a row that reached here, and `metadata` is server-side.
        expect(Object.keys(payload.computer).sort()).toEqual([
            'createdAt',
            'id',
            'isNew',
            'lastOpenedAt',
            'name',
            'slot',
        ]);
    });

    it('carries no absolute URL, so it can hold no route to the Worker', () => {
        const serialized = serializeBootPayload(
            buildShellBootPayload({
                user: USER,
                computer: computer(),
                isNew: false,
                provider: { isConfigured: true, hasHmacSecret: true },
            }),
        );

        // Every endpoint in the payload is same-origin and relative. An
        // absolute URL appearing here would mean the Worker's address (or a
        // signed preview URL) had reached the browser through this file — the
        // exact thing `cloudflareGuacamole.isConfigured` returns booleans to
        // avoid.
        expect(serialized).not.toMatch(/https?:\/\//);
        expect(serialized).not.toContain('workers.dev');
    });

    it('exposes the desktop provider as booleans only — never its configuration', () => {
        const { desktopState } = buildShellBootPayload({
            user: USER,
            computer: computer(),
            isNew: false,
            provider: { isConfigured: true, hasHmacSecret: true },
        });

        // `hasHmacSecret` is a boolean about a secret, not the secret. Assert
        // the type, because a regression that swapped the flag for the value
        // would still pass a key-name check.
        expect(typeof desktopState.configured).toBe('boolean');
        expect(typeof desktopState.hasHmacSecret).toBe('boolean');
        expect(Object.keys(desktopState).sort()).toEqual([
            'configured',
            'endpoints',
            'hasHmacSecret',
            'provider',
            'status',
        ]);
    });
});

describe('toShellDesktopState — never implies an observation it does not have', () => {
    it('is "idle" at boot, because the page never asks the container anything', () => {
        expect(toShellDesktopState({ isConfigured: true, hasHmacSecret: true }).status).toBe('idle');
    });

    it('treats a FAILED provider lookup as not configured, not as configured', () => {
        // `/os` swallows an isConfigured failure so the page still paints. The
        // honest reading of "we don't know" is "don't promise a desktop".
        const state = toShellDesktopState(null);
        expect(state.configured).toBe(false);
        expect(state.hasHmacSecret).toBe(false);
    });

    it('publishes the endpoints the shell must call, and only those', () => {
        expect(toShellDesktopState(null).endpoints).toEqual({
            session: '/api/shell/session',
            desktop: '/api/shell/desktop',
            previewUrl: '/api/shell/preview-url',
            // MODIFIED BY EZIL 2026-08-01 (T7): the code-server counterpart of
            // `previewUrl` — see `cloudflareGuacamole.codePreviewUrl`.
            codePreviewUrl: '/api/shell/code-preview-url',
            focus: '/api/shell/focus',
            telemetry: '/api/shell/telemetry',
            restart: '/api/shell/restart',
            // Container-billing fix: the activity heartbeat's feature flag —
            // see the dedicated test below.
            activity: '/api/shell/activity',
        });
    });

    /**
     * 🔴 `focus` is not documentation, it is a FEATURE FLAG, and this test
     * exists so nobody removes it thinking otherwise.
     *
     * `shell/ezil/apps/desktop-window.js` draws its in-stream app switcher if
     * and only if `desktopState.endpoints.focus` is truthy — the deliberate
     * "never POST to a URL this file invented" rule. For the whole of Wave A
     * the key did not exist, so the switcher was silently never drawn even
     * though the Worker route it needs was built and tested. Deleting the key
     * would put it straight back in that state, silently, with every test
     * still green except this one.
     */
    it('carries `focus`, the key the shell in-stream switcher feature-detects on', () => {
        expect(toShellDesktopState({ isConfigured: true, hasHmacSecret: true }).endpoints.focus).toBe(
            '/api/shell/focus',
        );
    });

    /**
     * Same feature-flag shape as `focus` above, for the telemetry beacon
     * module (`shell/ezil/telemetry.js`, scratchpad/telemetry-design.md §4.3):
     * deleting this key silently turns off all crash reporting for every
     * client that reads it, with no other test noticing.
     */
    it('carries `telemetry`, the key shell/ezil/telemetry.js feature-detects on', () => {
        expect(toShellDesktopState({ isConfigured: true, hasHmacSecret: true }).endpoints.telemetry).toBe(
            '/api/shell/telemetry',
        );
    });

    /**
     * 🔴 Third instance of the same feature flag, and the one that has already
     * failed once. The Worker built `POST /sandbox/:name/restart` and the shell
     * built the Settings Troubleshoot tab in the same round, but nobody
     * published this key or the Route Handler behind it — so
     * `shell/ezil/session.js`'s `restartEndpoint()` returned `null`, the button
     * rendered permanently disabled saying "Not available in this deployment
     * yet", and every test on both sides stayed green. Deleting this key puts
     * the product straight back into that exact silence.
     */
    it('carries `restart`, the key the Settings Troubleshoot button feature-detects on', () => {
        expect(toShellDesktopState({ isConfigured: true, hasHmacSecret: true }).endpoints.restart).toBe(
            '/api/shell/restart',
        );
    });

    /**
     * 🔴 Fourth instance of the same feature flag — the container-billing
     * fix's whole reason for existing. `shell/ezil/apps/desktop-window.js`'s
     * heartbeat calls `session.reportActivity()` only when
     * `session.js#activityEndpoint()` reads a truthy
     * `desktopState.endpoints.activity` here; deleting this key silently
     * turns every desktop window's heartbeat into a no-op, and the container
     * that heartbeat exists to keep cool goes back to being resident (and
     * billed) for as long as a tab is merely left open — with every other
     * test on both sides still green.
     */
    it('carries `activity`, the key the desktop window heartbeat feature-detects on', () => {
        expect(toShellDesktopState({ isConfigured: true, hasHmacSecret: true }).endpoints.activity).toBe(
            '/api/shell/activity',
        );
    });
});

describe('the app registry', () => {
    it('lists only apps the host can actually launch today', () => {
        // One entry, because one thing exists: the streamed Linux desktop.
        // An icon for anything else would be an icon that does nothing.
        expect(SHELL_APPS.map((app) => app.id)).toEqual(['desktop']);
        expect(SHELL_APPS.every((app) => app.kind === 'desktop')).toBe(true);
    });
});

describe('SHELL_API_ROUTES', () => {
    it('matches the Route Handler paths on disk', async () => {
        const { existsSync } = await import('node:fs');
        const { fileURLToPath } = await import('node:url');

        for (const route of Object.values(SHELL_API_ROUTES)) {
            const handler = fileURLToPath(
                new URL(`../../app${route}/route.ts`, import.meta.url),
            );
            expect(existsSync(handler), `${route} -> ${handler}`).toBe(true);
        }
    });
});

describe('toShellBootComputer', () => {
    it('reports isNew only as told, never inferred from a fresh createdAt', () => {
        const fresh = computer({ createdAt: new Date() });
        expect(toShellBootComputer(fresh, false).isNew).toBe(false);
        expect(toShellBootComputer(fresh, true).isNew).toBe(true);
    });
});
