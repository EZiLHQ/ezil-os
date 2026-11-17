import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { privatePacketFor } from './private-packet';

const URL = 'https://github.ezil.work/default/os-code-url-20261110-a.git';
const person = { issuer: 'https://id.ezil.work/', subject: 'auth0|fixture' };
const packet = () => ({ version: 2, repository: { id: 'fg1wtcrexaf7acl0', canonicalURL: URL, ref: 'refs/heads/main' },
    identity: person, git: { username: 'ezil', token: 'opaque-gateway-credential', expiresAt: '2026-11-10T17:04:00.000Z', scope: 'read' } });
const NOW = Date.parse('2026-11-10T17:00:00.000Z');
const NATIVE_TOKEN = `art_v1_${'a'.repeat(40)}?expires=${Math.floor((NOW + 240_000) / 1000)}`;

describe('standalone CLI v2 packet', () => {
    it('accepts the actual provider repository ID independently of the OS checkout UUID', () => {
        expect(privatePacketFor(packet(), URL, person, NOW)).toEqual(packet());
    });
    it('accepts a native Artifacts credential with ?expires as opaque packet data', () => {
        const native = { ...packet(), git: { ...packet().git, token: NATIVE_TOKEN } };
        expect(privatePacketFor(native, URL, person, NOW)).toEqual(native);
        expect(privatePacketFor({ ...native, git: { ...native.git, token: `${NATIVE_TOKEN}:unsafe` } }, URL, person, NOW)).toBeNull();
        expect(privatePacketFor({ ...native, git: { ...native.git, token: `${NATIVE_TOKEN}\nunsafe` } }, URL, person, NOW)).toBeNull();
    });
    it.each([
        ['foreign URL', () => ({ ...packet(), repository: { ...packet().repository, canonicalURL: 'https://github.ezil.work/default/other.git' } })],
        ['foreign provider ID', () => ({ ...packet(), repository: { ...packet().repository, id: '../wrong' } })],
        ['foreign subject', () => ({ ...packet(), identity: { ...person, subject: 'auth0|other' } })],
        ['foreign issuer', () => ({ ...packet(), identity: { ...person, issuer: 'https://other.invalid/' } })],
        ['unsafe ref', () => ({ ...packet(), repository: { ...packet().repository, ref: 'refs/heads/../main' } })],
        ['expired grant', () => ({ ...packet(), git: { ...packet().git, expiresAt: '2026-11-10T16:59:59.000Z' } })],
        ['overlong grant', () => ({ ...packet(), git: { ...packet().git, expiresAt: '2026-11-10T17:05:01.000Z' } })],
        ['non-HTTP-safe token', () => ({ ...packet(), git: { ...packet().git, token: 'opaque:gateway:credential' } })],
        ['short token', () => ({ ...packet(), git: { ...packet().git, token: 'short' } })],
        ['unknown scope', () => ({ ...packet(), git: { ...packet().git, scope: 'admin' } })],
        ['extra field', () => ({ ...packet(), projectId: 'not-standalone' })],
    ])('rejects %s', (_name, changed) => {
        expect(privatePacketFor(changed(), URL, person, NOW)).toBeNull();
    });
    it('requires a canonical production EZiL URL and the shared issuer', () => {
        expect(privatePacketFor(packet(), 'https://git-qa.ezil.work/default/os-code-url-20261110-a.git', person, NOW)).toBeNull();
        expect(privatePacketFor(packet(), URL, { ...person, issuer: 'https://other.invalid/' }, NOW)).toBeNull();
    });
});
