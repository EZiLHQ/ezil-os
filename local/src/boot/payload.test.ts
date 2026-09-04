/**
 * The boot payload and the `/os` document it is inlined into.
 *
 * Two questions, and only the second one is obvious:
 *   1. does the payload carry what the shell reads (and nothing invented)?
 *   2. can a string a USER controls escape the `<script>` element it is
 *      embedded in? `../contract/shell-api.ts` names the surface: the computer
 *      name and the email address are the user-controlled strings, and the
 *      failure "ships an XSS to every user running EZiL OS on their own
 *      machine, in a code path nobody diffs because it looks like a one-liner".
 *
 * The adversarial vector is T0's own (`../contract/shell-api.test.ts`), reused
 * verbatim so a change to what counts as adversarial happens in one place.
 */

import { describe, expect, it } from 'bun:test';

import { SHELL_APPS } from '../../../app/src/server/shell/boot-payload.ts';
import { SHELL_API_ROUTES } from '../contract/shell-api.ts';
import type { ShellBootComputer, ShellBootPayload } from '../contract/shell-api.ts';
import {
    LOCAL_COMPUTER_NAME,
    LOCAL_COMPUTER_SLOT,
    LOCAL_COMPUTER_ID_PREFIX,
    LOCAL_USER,
    buildLocalComputer,
    localComputerId,
} from './identity.ts';
import { OS_ASSET_PATHS, renderOsDocument } from './os-document.ts';
import { LOCAL_SHELL_APPS, buildLocalBootPayload, localDesktopState } from './payload.ts';

/** T0's `ADVERSARIAL` computer name, unchanged: `</script>`, `<!--`, U+2028, U+2029 and an img/onerror. */
const ADVERSARIAL_NAME = '</script> <!-- \u2028 \u2029 <img src=x onerror=alert(1)>';

function computer(overrides: Partial<ShellBootComputer> = {}): ShellBootComputer {
    return {
        ...buildLocalComputer({
            workspacePath: '/tmp/ezil-test-workspace',
            createdAt: '2026-09-04T00:00:00.000Z',
            lastOpenedAt: null,
            isNew: false,
        }),
        ...overrides,
    };
}

/** Pull `window.__EZIL_BOOT__=<json>;` back out of a rendered document. */
function extractPayload(html: string): unknown {
    const match = /window\.__EZIL_BOOT__=(.*?);<\/script>/s.exec(html);
    expect(match).not.toBeNull();
    return JSON.parse(match?.[1] ?? '') as unknown;
}

// ── Identity ─────────────────────────────────────────────────────────────────

describe('the local identity', () => {
    it('carries a string user.id, which is the one field every consumer dereferences', () => {
        // `shell/ezil/session.js:133` and `shell/ezil/telemetry.js:77` both
        // reject a payload whose `user.id` is not a string; `boot.js` treats a
        // null payload as a hard stop and never draws a desktop.
        expect(typeof LOCAL_USER.id).toBe('string');
        expect(LOCAL_USER.id.length).toBeGreaterThan(0);
    });

    it('never invents an email address', () => {
        // `boot-payload.ts`: "Supabase can return a user with no email (other
        // identity providers). Never faked." A local host has none.
        expect(LOCAL_USER.email).toBeNull();
    });

    it('derives the computer id from the workspace path, deterministically', () => {
        const a = localComputerId('/home/someone/.ezil-os/workspace');
        const b = localComputerId('/home/someone/.ezil-os/workspace');
        const c = localComputerId('/home/someone/other-workspace');
        expect(a).toBe(b);
        expect(a).not.toBe(c);
        expect(a.startsWith(LOCAL_COMPUTER_ID_PREFIX)).toBe(true);
    });

    it('is not a uuid, and does not leak the path it was derived from', () => {
        const path = '/home/a-very-identifying-login-name/work';
        const id = localComputerId(path);
        // A fake uuid would be the same value SHAPE as a Supabase computer id
        // and would eventually be read as one.
        expect(id).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        // The id is printed in the page source; a home directory carries the
        // user's login name.
        expect(id).not.toContain('a-very-identifying-login-name');
    });

    it('names and slots the computer the way the hosted schema defaults do', () => {
        // `app/src/server/db/schema/computers.ts:57` — `.default('Computer')`;
        // line 76 — `check(... slot in (1, 2))`.
        expect(LOCAL_COMPUTER_NAME).toBe('Computer');
        expect([1, 2]).toContain(LOCAL_COMPUTER_SLOT);
    });
});

// ── The payload ──────────────────────────────────────────────────────────────

describe('the boot payload', () => {
    it('publishes all nine endpoints and the flags the shell branches on', () => {
        const state = localDesktopState();
        expect(state.endpoints).toEqual(SHELL_API_ROUTES);
        // `shell/ezil/apps/desktop-window.js:1106` renders the "not configured"
        // panel and stops unless this is exactly `true`; `boot.js:654` refuses
        // to warm the container without it.
        expect(state.configured).toBe(true);
        // Local mode signs nothing, and this flag has ZERO readers in `shell/`
        // — its only occurrences anywhere are in the app's own tests. So `false`
        // disables nothing: every optional control is feature-detected from
        // `endpoints`, never from here.
        expect(state.hasHmacSecret).toBe(false);
        // `boot-payload.ts`: "ALWAYS 'idle' at boot... the server has no
        // observation of whether the desktop is up, and refuses to imply one."
        expect(state.status).toBe('idle');
    });

    it('lists exactly the apps the app server lists', () => {
        // Imported from `app/src/server/shell/boot-payload.ts`, not retyped:
        // "an entry exists only if the host can actually launch it today".
        expect(LOCAL_SHELL_APPS).toEqual(SHELL_APPS);
    });
});

// ── The document ─────────────────────────────────────────────────────────────

describe('the /os document', () => {
    const payload: ShellBootPayload = buildLocalBootPayload(computer());

    it('round-trips the payload through JSON.parse', () => {
        const html = renderOsDocument(payload);
        expect(extractPayload(html)).toEqual(payload as unknown);
    });

    it('loads the three bundle files, in the one order that works', () => {
        const html = renderOsDocument(payload);
        expect(html).toContain(`<link rel="stylesheet" href="${OS_ASSET_PATHS.css}">`);
        // `app/src/app/os/page.tsx`: "the payload must exist before the bundle
        // runs, and the icons before the bundle that draws them".
        const iBoot = html.indexOf('window.__EZIL_BOOT__=');
        const iIcons = html.indexOf(OS_ASSET_PATHS.icons);
        const iBundle = html.indexOf(OS_ASSET_PATHS.bundle);
        expect(iBoot).toBeGreaterThan(-1);
        expect(iBoot).toBeLessThan(iIcons);
        expect(iIcons).toBeLessThan(iBundle);
    });

    it('is a complete document with the mount point the shell adopts', () => {
        const html = renderOsDocument(payload);
        expect(html.startsWith('<!doctype html>')).toBe(true);
        expect(html).toContain('id="ezil-os-root"');
        expect(html).toContain('class="desktop ezil-desktop"');
    });

    it('does not mark itself as a React document', () => {
        // `shell/ezil/boot.js:931`: `awaits_hydration()` is opt-IN and matches
        // the exact string "react". A page without the marker mounts
        // IMMEDIATELY; a page with it waits for an `ezil:hydrated` event that
        // this host never dispatches, up to HYDRATION_CAP_MS (3s).
        expect(renderOsDocument(payload)).not.toContain('data-awaits-hydration');
    });
});

// ── The breakout ─────────────────────────────────────────────────────────────

describe('a user-controlled string cannot escape the inline <script>', () => {
    const hostile: ShellBootPayload = buildLocalBootPayload(computer({ name: ADVERSARIAL_NAME }));

    it('the payload really does contain the adversarial text', () => {
        // POSITIVE CONTROL. Without it, every assertion below would pass on an
        // empty string.
        expect(hostile.computer.name).toContain('</script>');
        expect(hostile.computer.name).toContain('<!--');
        expect(hostile.computer.name).toContain('\u2028');
        expect(hostile.computer.name).toContain('\u2029');
    });

    it('the rendered document contains no raw </script> from the payload', () => {
        const html = renderOsDocument(hostile);
        const inline = /<script>(.*?)<\/script>/s.exec(html);
        expect(inline).not.toBeNull();
        const body = inline?.[1] ?? '';
        expect(body.toLowerCase().includes('</script')).toBe(false);
        // `<` is escaped as `<`, which is legal inside a JSON string and
        // parses back to `<` — so the shell sees the original text unchanged.
        expect(body).toContain('\\u003c');
        expect(body).toContain('\\u2028');
        expect(body).toContain('\\u2029');
    });

    it('the document still has exactly three script elements', () => {
        const html = renderOsDocument(hostile);
        // Structural, not textual: an escaped payload cannot open a fourth
        // element or close its own early, whatever it contains.
        expect((html.match(/<script/g) ?? []).length).toBe(3);
        expect((html.match(/<\/script>/g) ?? []).length).toBe(3);
    });

    it('and the shell still receives the original string, byte for byte', () => {
        const parsed = extractPayload(renderOsDocument(hostile)) as ShellBootPayload;
        // Escaping is not sanitising: the value must survive the trip intact.
        expect(parsed.computer.name).toBe(ADVERSARIAL_NAME);
    });

    it('🔴 MUTANT: the same document built with a naive serializer DOES break out', () => {
        // The mutation is applied HERE rather than to
        // `../contract/shell-api.ts` (row T0 owns that file): this is the
        // "it looks like a one-liner" version its header warns about —
        // `JSON.stringify` with no `<` escape, everything else identical.
        const naive = '<!doctype html><html><body>'
            + `<script>window.__EZIL_BOOT__=${JSON.stringify(hostile)};</script>`
            + `<script src="${OS_ASSET_PATHS.icons}" defer></script>`
            + `<script src="${OS_ASSET_PATHS.bundle}" defer></script>`
            + '</body></html>';

        // MUTANT BEHAVIOUR: the computer NAME closes the script element, so
        // there are FOUR `</script>` in a document with three script elements,
        // and the attacker's markup lands in the document body where the
        // browser will parse it as HTML.
        expect((naive.match(/<\/script>/g) ?? []).length).toBe(4);
        const afterFirstClose = naive.slice(naive.indexOf('</script>') + '</script>'.length);
        expect(afterFirstClose).toContain('onerror=alert(1)');

        // SHIPPED BEHAVIOUR, on the identical payload: three closes, and the
        // attacker's markup exists only as escaped text inside the JSON string.
        const shipped = renderOsDocument(hostile);
        expect((shipped.match(/<\/script>/g) ?? []).length).toBe(3);
        const shippedAfterFirstClose = shipped.slice(shipped.indexOf('</script>') + '</script>'.length);
        expect(shippedAfterFirstClose).not.toContain('onerror=alert(1)');
    });
});
