import { describe, expect, it } from 'vitest';

import { Routes, getReturnUrlQueryParam, safeReturnUrl } from './constants';

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
