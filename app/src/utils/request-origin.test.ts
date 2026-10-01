import { describe, expect, it } from 'vitest';

import { isCrossOriginWrite } from './request-origin';

const req = (method: string, headers: Record<string, string>) => ({
    method,
    headers: new Headers(headers),
});

describe('isCrossOriginWrite', () => {
    it('never refuses a safe method, whatever the headers say', () => {
        for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
            expect(isCrossOriginWrite(req(method, { 'sec-fetch-site': 'cross-site' }))).toBe(false);
        }
    });

    it('lets a same-origin browser POST through', () => {
        expect(isCrossOriginWrite(req('POST', { 'sec-fetch-site': 'same-origin' }))).toBe(false);
    });

    it('lets a user-initiated navigation through (Sec-Fetch-Site: none)', () => {
        expect(isCrossOriginWrite(req('POST', { 'sec-fetch-site': 'none' }))).toBe(false);
    });

    it('🔴 refuses a POST from a sibling *.ezil.org host (same-site is not same-origin)', () => {
        // The case SameSite=Lax does not cover: a page on somebody's desktop
        // host is same-SITE as os.ezil.org, so the cookie would ride along.
        expect(
            isCrossOriginWrite(
                req('POST', { 'sec-fetch-site': 'same-site', origin: 'https://8181-x-app.ezil.org', host: 'os.ezil.org' }),
            ),
        ).toBe(true);
    });

    it('refuses a cross-site POST', () => {
        expect(isCrossOriginWrite(req('PUT', { 'sec-fetch-site': 'cross-site' }))).toBe(true);
        expect(isCrossOriginWrite(req('DELETE', { 'sec-fetch-site': 'cross-site' }))).toBe(true);
    });

    describe('without Sec-Fetch-Site, falls back to Origin vs Host', () => {
        it('passes a matching Origin', () => {
            expect(isCrossOriginWrite(req('POST', { origin: 'https://os.ezil.org', host: 'os.ezil.org' }))).toBe(false);
        });

        it('prefers x-forwarded-host, which is the public host behind Vercel', () => {
            expect(
                isCrossOriginWrite(
                    req('POST', {
                        origin: 'https://os.ezil.org',
                        host: 'ezil-os.vercel.app',
                        'x-forwarded-host': 'os.ezil.org',
                    }),
                ),
            ).toBe(false);
        });

        it('refuses a different host, including a sibling under ezil.org', () => {
            expect(
                isCrossOriginWrite(req('POST', { origin: 'https://evil-app.ezil.org', host: 'os.ezil.org' })),
            ).toBe(true);
        });

        it('refuses the opaque `null` origin', () => {
            expect(isCrossOriginWrite(req('POST', { origin: 'null', host: 'os.ezil.org' }))).toBe(true);
        });

        it('refuses when there is an Origin but no host to compare it with', () => {
            expect(isCrossOriginWrite(req('POST', { origin: 'https://os.ezil.org' }))).toBe(true);
        });
    });

    it('lets a non-browser caller (no Origin, no Sec-Fetch-Site) through', () => {
        // The SDK, the MCP connector, crons and webhooks authenticate with a
        // bearer or a secret of their own, which a hostile page cannot attach.
        expect(isCrossOriginWrite(req('POST', { authorization: 'Bearer token', host: 'os.ezil.org' }))).toBe(false);
    });
});
