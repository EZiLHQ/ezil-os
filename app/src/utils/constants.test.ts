import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
    Routes, SHELL_APP_ALIASES, SHELL_APP_IDS, getReturnUrlQueryParam, isShellAppId, returnUrlFor, safeReturnUrl, shellAppRoute,
} from './constants';

/**
 * `returnUrl` is attacker-controlled: it is a query parameter on a link that
 * anyone can send to anyone. It ends up in a navigation primitive — since the
 * sign-in path moved off `redirect()` and onto `window.location.assign` (see
 * `app/login/actions.ts` and docs/PLATFORM-NOTES.md §17), literally in the
 * address bar. An unfiltered value is an open redirect out of a page the user
 * has just typed their password into.
 */
describe('safeReturnUrl', () => {
    it('keeps ordinary same-origin paths, including the ones this app uses', () => {
        expect(safeReturnUrl('/os')).toBe('/os');
        expect(safeReturnUrl(Routes.COMPUTERS)).toBe(Routes.COMPUTERS);
        expect(safeReturnUrl('/computer/9d5b0a1e-0000-4000-8000-000000000000')).toBe(
            '/computer/9d5b0a1e-0000-4000-8000-000000000000',
        );
        expect(safeReturnUrl('/computers?created=1#top')).toBe('/computers?created=1#top');
    });

    it('🔴 refuses an absolute URL to another origin', () => {
        expect(safeReturnUrl('https://evil.example/steal')).toBe(Routes.COMPUTERS);
        expect(safeReturnUrl('http://evil.example')).toBe(Routes.COMPUTERS);
        expect(safeReturnUrl('javascript:alert(1)')).toBe(Routes.COMPUTERS);
        expect(safeReturnUrl('data:text/html,<script>1</script>')).toBe(Routes.COMPUTERS);
    });

    it('🔴 refuses protocol-relative and backslash forms, which LOOK like paths', () => {
        // The browser reads "//evil.example" as "https://evil.example". This
        // is the one that gets past a `startsWith('/')` check.
        expect(safeReturnUrl('//evil.example/steal')).toBe(Routes.COMPUTERS);
        expect(safeReturnUrl('/\\evil.example')).toBe(Routes.COMPUTERS);
    });

    it('refuses control characters and whitespace used to smuggle a second URL', () => {
        expect(safeReturnUrl('/os\n\rLocation: https://evil.example')).toBe(Routes.COMPUTERS);
        expect(safeReturnUrl('/ /evil.example')).toBe(Routes.COMPUTERS);
        expect(safeReturnUrl('\t//evil.example')).toBe(Routes.COMPUTERS);
    });

    /**
     * 🔴 Two DIFFERENT fallbacks, deliberately. An absent `returnUrl` is an
     * ordinary sign-in with nothing to reject, and lands on `Routes.OS` — the
     * product's entry point. A `returnUrl` that WAS supplied but is malformed
     * (not absent — present and wrong) is treated as anomalous and lands on
     * the more conservative `Routes.COMPUTERS`, not the shell.
     *
     * Both directions: flip the first branch's `Routes.OS` back to
     * `Routes.COMPUTERS` and this test goes red (login stops landing in the
     * OS by default). Delete the branch split entirely (route everything
     * through one fallback) and either this test or the malformed-input test
     * below goes red, because the two groups no longer disagree.
     */
    it('🔴 an absent or empty returnUrl lands on the OS — the default entry point', () => {
        expect(safeReturnUrl(undefined)).toBe(Routes.OS);
        expect(safeReturnUrl(null)).toBe(Routes.OS);
        expect(safeReturnUrl('')).toBe(Routes.OS);
        // No value survived the repeated-param collapse below either.
        expect(safeReturnUrl([])).toBe(Routes.OS);
    });

    it('a returnUrl that was supplied but is malformed lands on /computers, not the OS', () => {
        // Present, but not a path at all — different from "nothing supplied".
        expect(safeReturnUrl('relative/path')).toBe(Routes.COMPUTERS);
    });

    it('takes the first value when a query string repeats the parameter', () => {
        // `?returnUrl=/os&returnUrl=https://evil.example` must not widen.
        expect(safeReturnUrl(['/os', 'https://evil.example'])).toBe('/os');
        expect(safeReturnUrl(['https://evil.example', '/os'])).toBe(Routes.COMPUTERS);
    });

    it('round-trips with the builder that produces these links', () => {
        const qs = getReturnUrlQueryParam(Routes.OS);
        const value = new URLSearchParams(qs).get('returnUrl');
        expect(safeReturnUrl(value)).toBe(Routes.OS);
    });
});

const P = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const R = '12345678-9abc-4def-8123-456789abcdef';

describe('safeReturnUrl — the OS routes (docs/APP-ROUTES.md)', () => {
    it('keeps /os and /app/<shell app id> with their whole query', () => {
        for (const url of [
            '/os', '/os?app=code', `/os?app=code&computer=${P}`, '/os?settings=billing&upgrade=pro',
            '/app/code', `/app/code?project=${P}&repo=${R}&path=src`, `/app/code?project=${P}&repo=${R}&path=src/main.ts`,
            '/app/settings?tab=billing', '/app/browser', '/app/desktop?computer=x#top', '/app/app-store', '/app/preview',
            // A query is data, not a path: these are only ever query values.
            '/os?next=//evil.example', '/app/code?path=src%2Fmain.ts', '/app/settings?tab=..',
            '/billing/return?session_id=cs_test_1',
        ]) {
            expect(safeReturnUrl(url), url).toBe(url);
        }
    });

    it('🔴 an /app path it cannot vouch for lands on the OS itself', () => {
        for (const url of [
            '/app/unknown', '/app/../admin', '/app/%2e%2e/x', '/app/%2E%2E/x', '/app/code/../../admin', '/app/./code',
            '/app/code%2f..%2fadmin', '/app/code%5cx', '/app', '/app/', '/app/code/', '/app/code/x', '/app/Code',
            '/app/__proto__', '/app/constructor', '/app/hasOwnProperty',
        ]) {
            expect(safeReturnUrl(url), url).toBe(Routes.OS);
        }
    });

    it('🔴 hostile shapes and pages this app never returns to land on /computers', () => {
        for (const url of [
            '//evil.com', '//evil.com/app/code', '/\\evil', '/app\\..\\admin', '/os?x=\\y', 'https://evil', 'https://evil/app/code',
            'javascript:alert(1)', '/os/../admin', '/os/%2e%2e/admin', '/os%2fadmin', '/computers/../admin', '/admin', '/pricing',
            '/login', '/os/', '/os/bundle.min.js', '/computer/not-a-uuid', '/computer/../os', '/api/trpc/x', '/osx',
        ]) {
            expect(safeReturnUrl(url), url).toBe(Routes.COMPUTERS);
        }
    });

    it('positive controls for every page this app sends back through login', () => {
        // The producers: `/os` + `/app/[appId]` pages, `computers/layout.tsx`,
        // `computer/layout.tsx`, `billing/return/page.tsx`, the pricing CTA.
        expect(safeReturnUrl('/computers')).toBe('/computers');
        expect(safeReturnUrl('/computer/9D5B0A1E-0000-4000-8000-000000000000')).toBe('/computer/9D5B0A1E-0000-4000-8000-000000000000');
        expect(safeReturnUrl('/billing/return?session_id=cs_1')).toBe('/billing/return?session_id=cs_1');
        expect(safeReturnUrl('/os?settings=billing&upgrade=standard')).toBe('/os?settings=billing&upgrade=standard');
    });
});

/**
 * One test per numbered case in `safeReturnUrl` (docs/APP-ROUTES.md §6). Each
 * negative group sits next to a positive control that differs from it in the
 * one thing the case decides.
 */
describe('safeReturnUrl — compatibility decisions (docs/APP-ROUTES.md §6)', () => {
    it('case 1: nothing supplied lands on /os; a repeat counts by its first value', () => {
        for (const value of [undefined, null, '', [], ['']]) expect(safeReturnUrl(value), JSON.stringify(value)).toBe(Routes.OS);
        expect(safeReturnUrl(['/app/code', 'https://evil.example'])).toBe('/app/code');
        expect(safeReturnUrl(['https://evil.example', '/app/code'])).toBe(Routes.COMPUTERS);
    });

    /**
     * Case 2 is also what four other suites pin, each with hostile or foreign
     * input only (scheme, `//`, `/\`, a control character):
     *   app/src/app/login/page.test.ts                  ("rejects a foreign return URL")
     *   app/src/app/auth/auth0/callback/route.test.ts   (signed-cookie and query destinations)
     *   app/src/server/auth/auth0.test.ts               ("sanitises returnUrl")
     *   app/src/app/auth/confirm/confirm-route.test.ts  (hostile `next`)
     * Measured: case 2 -> /os turns all four red; case 5 -> /os leaves all
     * four green.
     */
    it('case 2: hostile shapes land on /computers, decided BEFORE the /app fallback', () => {
        // Positive control: the same /app pages, clean, are kept.
        expect(safeReturnUrl('/app/code')).toBe('/app/code');
        expect(safeReturnUrl('/app/code?path=src')).toBe('/app/code?path=src');
        for (const url of [
            // Schemes and non-paths.
            'https://evil.example', 'https://evil.example/app/code', 'javascript:alert(1)', 'data:text/html,x', 'app/code', '.',
            // Protocol-relative and backslash, path or query.
            '//evil.example', '//evil.example/app/code', '/\\evil.example', '/app\\..\\admin', '/app/code\\x', '/app/code?path=\\x', '/os?x=\\y',
            // Control characters and whitespace, including inside an /app path.
            '/app/code\t', '/app/code\n', '/app/\u0000code', '/app/ code', '/app/code\u007f', '/app/code?x=a b', ' /app/code',
        ]) {
            expect(safeReturnUrl(url), JSON.stringify(url)).toBe(Routes.COMPUTERS);
        }
    });

    it('case 3: every return page is kept byte for byte, query and hash included', () => {
        for (const url of [
            '/os', '/os?app=code', '/os?settings=billing&upgrade=pro#x',
            ...[...SHELL_APP_IDS, ...Object.keys(SHELL_APP_ALIASES)].map(id => `/app/${id}`),
            // `/` in a query value stays unencoded (what `returnUrlFor` writes); `%2F` there is data.
            `/app/code?project=${P}&repo=${R}&path=src/main.ts`, `/app/code?project=${P}&repo=${R}&path=src%2Fmain.ts`,
            '/app/desktop?computer=11111111-1111-4111-8111-111111111111', '/app/settings?tab=billing&section=ai-credits',
            '/computers', '/computers?created=1#top',
            '/computer/9d5b0a1e-0000-4000-8000-000000000000', '/computer/9D5B0A1E-0000-4000-8000-000000000000',
            '/billing/return', '/billing/return?session_id=cs_test_1',
        ]) {
            expect(safeReturnUrl(url), url).toBe(url);
        }
    });

    it('case 4: a rejected /app path lands on /os', () => {
        for (const url of [
            '/app', '/app/', '/app?x=1', '/app/unknown', '/app/launcher', '/app/Code', '/app/CODE', '/app/code/', '/app/code/x',
            '/app/../x', '/app/../os', '/app/./code', '/app/%2e%2e/x', '/app/%2E%2E/x', '/app/code%2fx', '/app/code%2F..%2Fadmin', '/app/code%5cx', '/app/%63ode',
            '/app/__proto__', '/app/constructor', '/app/hasOwnProperty',
        ]) {
            expect(safeReturnUrl(url), url).toBe(Routes.OS);
        }
        // Not under /app: a prefix match on the string would get these wrong.
        for (const url of ['/apps', '/application', '/app%2fcode', '/appcode']) expect(safeReturnUrl(url), url).toBe(Routes.COMPUTERS);
    });

    /**
     * Case 5. Base (before `/app/<id>`) kept every path that passed the shape
     * checks; these pages now land on /computers. No producer in this
     * repository sends them (docs/APP-ROUTES.md §6). Only this test pins
     * case 5: the four suites named at case 2 feed hostile shapes only.
     */
    it('case 5: any other rejected path lands on /computers, including pages base used to keep', () => {
        // Positive controls: the exact pages next to the refused shapes below.
        for (const url of ['/os', '/computers', '/billing/return', '/computer/9d5b0a1e-0000-4000-8000-000000000000']) {
            expect(safeReturnUrl(url), url).toBe(url);
        }
        for (const url of [
            // Kept by base, refused now (the compatibility table).
            '/', '/?x=1', '/pricing', '/login', '/admin', '/admin/users', '/os/', '/os/x', '/computers/', '/billing/return/',
            // Never return pages.
            '/os%2fadmin', '/os/../admin', '/os/%2e%2e/admin', '/osx', '/computers/../admin', '/computer/not-a-uuid', '/computer/../os',
            '/computer/9d5b0a1e-0000-4000-8000-000000000000/x', '/api/trpc/x', '/auth/callback', '/os/bundle.min.js',
        ]) {
            expect(safeReturnUrl(url), url).toBe(Routes.COMPUTERS);
        }
    });
});

describe('the /app/<id> allowlist', () => {
    it('accepts exactly the registry ids and aliases', () => {
        for (const id of [...SHELL_APP_IDS, 'browser']) {
            expect(isShellAppId(id), id).toBe(true);
            expect(shellAppRoute(id)).toBe(`/app/${id}`);
        }
        for (const id of ['unknown', '', 'Code', 'code/x', '../os', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'launcher', 1, null, undefined]) {
            expect(isShellAppId(id), String(id)).toBe(false);
        }
        expect(() => shellAppRoute('unknown')).toThrow();
    });

    it('🔴 matches the shell registry and its aliases (drift guard)', () => {
        // `shell/ezil/apps/registry.js` cannot be imported here (it pulls in
        // the whole jQuery shell), so its APPS ids are read from source.
        const registry = readFileSync(new URL('../../../shell/ezil/apps/registry.js', import.meta.url), 'utf8');
        const apps = registry.slice(registry.indexOf('export const APPS = ['), registry.indexOf('\n];', registry.indexOf('export const APPS = [')));
        const ids = [...apps.matchAll(/^\s*(?:\{\s*)?id: '([a-z0-9-]+)'/gm)].map(match => match[1]);
        expect(ids.length).toBeGreaterThan(3);
        expect([...SHELL_APP_IDS].sort()).toEqual([...ids].sort());
        const link = readFileSync(new URL('../../../shell/ezil/app-link.js', import.meta.url), 'utf8');
        const aliases = /ALIASES = Object\.freeze\(\{([^}]*)\}\)/.exec(link)?.[1] ?? '';
        expect(Object.fromEntries([...aliases.matchAll(/([a-z0-9-]+): '([a-z0-9-]+)'/g)].map(match => [match[1], match[2]])))
            .toEqual(SHELL_APP_ALIASES);
    });
});

describe('returnUrlFor', () => {
    it('keeps / readable in values and encodes everything else', () => {
        expect(returnUrlFor('/app/code', { project: P, repo: R, path: 'src/main.ts' })).toBe(`/app/code?project=${P}&repo=${R}&path=src/main.ts`);
        expect(returnUrlFor('/os', { app: ['code', 'browser'], q: 'a b&c=d', e: undefined })).toBe('/os?app=code&app=browser&q=a%20b%26c%3Dd');
        expect(returnUrlFor('/os', {})).toBe('/os');
        expect(returnUrlFor('/os', { path: '\\evil' })).toBe('/os?path=%5Cevil');
    });

    it('round-trips through getReturnUrlQueryParam and safeReturnUrl unchanged', () => {
        for (const url of [returnUrlFor('/app/code', { project: P, repo: R, path: 'src/main.ts' }), returnUrlFor('/app/settings', { tab: 'billing' })]) {
            expect(safeReturnUrl(new URLSearchParams(getReturnUrlQueryParam(url)).get('returnUrl'))).toBe(url);
        }
    });
});
