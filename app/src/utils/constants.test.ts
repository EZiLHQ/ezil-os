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

    it('falls back for anything absent or empty, rather than throwing', () => {
        expect(safeReturnUrl(undefined)).toBe(Routes.COMPUTERS);
        expect(safeReturnUrl(null)).toBe(Routes.COMPUTERS);
        expect(safeReturnUrl('')).toBe(Routes.COMPUTERS);
        expect(safeReturnUrl('relative/path')).toBe(Routes.COMPUTERS);
    });

    it('takes the first value when a query string repeats the parameter', () => {
        // `?returnUrl=/os&returnUrl=https://evil.example` must not widen.
        expect(safeReturnUrl(['/os', 'https://evil.example'])).toBe('/os');
        expect(safeReturnUrl(['https://evil.example', '/os'])).toBe(Routes.COMPUTERS);
        expect(safeReturnUrl([])).toBe(Routes.COMPUTERS);
    });

    it('round-trips with the builder that produces these links', () => {
        const qs = getReturnUrlQueryParam(Routes.OS);
        const value = new URLSearchParams(qs).get('returnUrl');
        expect(safeReturnUrl(value)).toBe(Routes.OS);
    });
});
