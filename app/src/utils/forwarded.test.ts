import { describe, expect, it } from 'vitest';

import { forwardedHost, forwardedProto, withoutDefaultPort } from './forwarded';

const h = (headers: Record<string, string>) => new Headers(headers);

describe('forwardedProto', () => {
    it('reads the first hop only, case-insensitively', () => {
        expect(forwardedProto(h({ 'x-forwarded-proto': 'https' }))).toBe('https');
        expect(forwardedProto(h({ 'x-forwarded-proto': 'HTTPS' }))).toBe('https');
        // The chain that used to build a redirect URL starting "https, http".
        expect(forwardedProto(h({ 'x-forwarded-proto': 'https, http' }))).toBe('https');
        expect(forwardedProto(h({ 'x-forwarded-proto': 'http' }))).toBe('http');
    });

    it('is null when nothing in front said, or said something else', () => {
        expect(forwardedProto(h({}))).toBeNull();
        expect(forwardedProto(h({ 'x-forwarded-proto': 'ws' }))).toBeNull();
    });
});

describe('forwardedHost', () => {
    it('prefers x-forwarded-host (the public host behind Vercel) over host', () => {
        expect(forwardedHost(h({ host: 'ezil-os.vercel.app', 'x-forwarded-host': 'os.ezil.org' }))).toBe('os.ezil.org');
        expect(forwardedHost(h({ host: 'os.ezil.org' }))).toBe('os.ezil.org');
    });

    it('drops the default port for the scheme, keeps any other', () => {
        expect(forwardedHost(h({ host: 'os.ezil.org:443', 'x-forwarded-proto': 'https' }))).toBe('os.ezil.org');
        expect(forwardedHost(h({ host: 'localhost:3000', 'x-forwarded-proto': 'http' }))).toBe('localhost:3000');
        expect(forwardedHost(h({ host: 'OS.EZIL.ORG' }))).toBe('os.ezil.org');
    });

    it('is null with no host at all', () => {
        expect(forwardedHost(h({}))).toBeNull();
    });
});

describe('withoutDefaultPort', () => {
    it('only strips the port that is the default for that scheme', () => {
        expect(withoutDefaultPort('os.ezil.org:443', 'https')).toBe('os.ezil.org');
        expect(withoutDefaultPort('os.ezil.org:443', 'http')).toBe('os.ezil.org:443');
        expect(withoutDefaultPort('os.ezil.org:80', 'http')).toBe('os.ezil.org');
        expect(withoutDefaultPort('os.ezil.org:80', 'https')).toBe('os.ezil.org:80');
    });
});
