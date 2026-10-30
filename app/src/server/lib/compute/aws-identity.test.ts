/**
 * Identity-document signature verification (C-6 step 3). Fixtures are
 * self-signed test certificates and OpenSSL `smime -sign` outputs in the IMDS
 * /pkcs7 form (base64, wrapped, no armour); no private key is stored.
 */

import { describe, expect, it } from 'vitest';

import { AWS_IDENTITY_CERTS_ENV, readIdentityCertificate, verifyIdentitySignature } from './aws-identity';
import fx from './aws-identity.fixtures.json';

// After the test certificates' notBefore (2026-10-14T09:16Z), before notAfter (2046).
const NOW = new Date('2026-10-20T00:00:00Z');

describe('verifyIdentitySignature', () => {
    it.each([
        ['RSA, detached, signed attributes, SHA-256 (the AWS rsa/pkcs7 shape)', fx.pkcs7_rsa_detached, fx.cert_rsa],
        ['DSA, detached, signed attributes (the AWS DSA /pkcs7 shape)', fx.pkcs7_dsa_detached, fx.cert_dsa],
        ['RSA with the content embedded (equal to the document)', fx.pkcs7_rsa_embedded, fx.cert_rsa],
        ['RSA without signed attributes', fx.pkcs7_rsa_noattr, fx.cert_rsa],
        ['RSA, SHA-1 digest', fx.pkcs7_rsa_sha1, fx.cert_rsa],
    ])('accepts %s', (_n, pkcs7, cert) => {
        expect(verifyIdentitySignature(fx.document, pkcs7, cert, NOW)).toEqual({ ok: true });
    });

    it('a document changed by one character is refused (signed attributes)', () => {
        const doc = fx.document.replace('i-22222222222222222', 'i-22222222222222223');
        expect(verifyIdentitySignature(doc, fx.pkcs7_rsa_detached, fx.cert_rsa, NOW)).toEqual({ ok: false, reason: 'identity_signature_mismatch' });
    });

    it('a document changed by one character is refused (no signed attributes)', () => {
        const doc = fx.document.replace('"t3a.medium"', '"m6i.large"');
        expect(verifyIdentitySignature(doc, fx.pkcs7_rsa_noattr, fx.cert_rsa, NOW)).toEqual({ ok: false, reason: 'identity_signature_mismatch' });
    });

    it('embedded content that differs from the presented document is refused', () => {
        expect(verifyIdentitySignature(fx.document + ' ', fx.pkcs7_rsa_embedded, fx.cert_rsa, NOW)).toEqual({ ok: false, reason: 'identity_signature_mismatch' });
    });

    it('the certificate embedded in the message is never trusted: another key in the config refuses', () => {
        expect(verifyIdentitySignature(fx.document, fx.pkcs7_rsa_detached, fx.cert_other, NOW)).toEqual({ ok: false, reason: 'identity_signature_mismatch' });
    });

    it('a DSA signature checked against an RSA certificate is refused (key type)', () => {
        expect(verifyIdentitySignature(fx.document, fx.pkcs7_dsa_detached, fx.cert_rsa, NOW)).toEqual({ ok: false, reason: 'identity_signature_algorithm' });
    });

    it.each([
        ['empty', ''],
        ['not base64', '!!!!'],
        ['truncated', fx.pkcs7_rsa_detached.replace(/\s+/g, '').slice(0, 200)],
        ['random DER', Buffer.from([0x30, 0x03, 0x02, 0x01, 0x01]).toString('base64')],
        ['trailing garbage', Buffer.concat([Buffer.from(fx.pkcs7_rsa_detached.replace(/\s+/g, ''), 'base64'), Buffer.from([0])]).toString('base64')],
    ])('%s → malformed, never ok', (_n, sig) => {
        const r = verifyIdentitySignature(fx.document, sig, fx.cert_rsa, NOW);
        expect(r.ok).toBe(false);
        expect(r).toMatchObject({ reason: 'identity_signature_malformed' });
    });

    it('a flipped signature byte is refused', () => {
        const der = Buffer.from(fx.pkcs7_rsa_detached.replace(/\s+/g, ''), 'base64');
        der[der.length - 5] ^= 0x01;
        expect(verifyIdentitySignature(fx.document, der.toString('base64'), fx.cert_rsa, NOW).ok).toBe(false);
    });

    it('an expired certificate (or one not yet valid) is refused', () => {
        expect(verifyIdentitySignature(fx.document, fx.pkcs7_rsa_detached, fx.cert_rsa, new Date('2099-01-01T00:00:00Z'))).toEqual({ ok: false, reason: 'identity_certificate_expired' });
        expect(verifyIdentitySignature(fx.document, fx.pkcs7_rsa_detached, fx.cert_rsa, new Date('2001-01-01T00:00:00Z'))).toEqual({ ok: false, reason: 'identity_certificate_expired' });
    });

    it('an unparseable certificate is refused', () => {
        expect(verifyIdentitySignature(fx.document, fx.pkcs7_rsa_detached, 'not a pem', NOW)).toEqual({ ok: false, reason: 'identity_certificate_invalid' });
    });
});

describe('verifyIdentitySignature: the BER form real IMDS emits', () => {
    // Live in ap-south-1 (2026-10-21) /pkcs7 began `30 80` (indefinite length) with the document in a
    // constructed OCTET STRING; a DER-only reader refused every real host (identity_signature_malformed).
    // This fixture has that shape (`openssl cms -sign -nodetach -stream`). Its certificate is newer.
    const BER_NOW = new Date('2026-12-01T00:00:00Z');
    const ber = Buffer.from(fx.pkcs7_dsa_ber_embedded, 'base64');

    it('is BER: indefinite outer length and a constructed OCTET STRING', () => {
        expect(ber.subarray(0, 2)).toEqual(Buffer.from([0x30, 0x80]));
        expect(ber.includes(Buffer.from([0x24, 0x80]))).toBe(true);
    });
    it('accepts it against its certificate', () => {
        expect(verifyIdentitySignature(fx.document, fx.pkcs7_dsa_ber_embedded, fx.cert_dsa_ber, BER_NOW)).toEqual({ ok: true });
    });
    it('refuses it when the document differs by one character (embedded content compared)', () => {
        const doc = fx.document.replace('i-22222222222222222', 'i-22222222222222223');
        expect(verifyIdentitySignature(doc, fx.pkcs7_dsa_ber_embedded, fx.cert_dsa_ber, BER_NOW)).toEqual({ ok: false, reason: 'identity_signature_mismatch' });
    });
    it('refuses it against another key', () => {
        expect(verifyIdentitySignature(fx.document, fx.pkcs7_dsa_ber_embedded, fx.cert_dsa, BER_NOW).ok).toBe(false);
    });
    it('a missing end-of-contents is malformed, not accepted', () => {
        const cut = ber.subarray(0, ber.length - 2).toString('base64');
        expect(verifyIdentitySignature(fx.document, cut, fx.cert_dsa_ber, BER_NOW)).toEqual({ ok: false, reason: 'identity_signature_malformed' });
    });
    it('an indefinite length on a primitive value is malformed', () => {
        // OCTET STRING (primitive) with 0x80: replace the first chunk tag inside the constructed string.
        const at = ber.indexOf(Buffer.from([0x24, 0x80])) + 2;
        const bad = Buffer.from(ber); bad[at] = 0x04; bad[at + 1] = 0x80;
        expect(verifyIdentitySignature(fx.document, bad.toString('base64'), fx.cert_dsa_ber, BER_NOW)).toEqual({ ok: false, reason: 'identity_signature_malformed' });
    });
});

describe('readIdentityCertificate', () => {
    const env = (v: unknown) => ({ [AWS_IDENTITY_CERTS_ENV]: typeof v === 'string' ? v : JSON.stringify(v) });
    it('returns the region certificate', () => {
        expect(readIdentityCertificate(env({ 'ap-south-1': fx.cert_rsa }), 'ap-south-1')).toBe(fx.cert_rsa);
    });
    it.each([
        ['unset', {}],
        ['not JSON', env('{')],
        ['another region only', env({ 'us-east-1': fx.cert_rsa })],
        ['not a certificate', env({ 'ap-south-1': 'hello' })],
        ['inherited key', env({})],
    ])('%s → null', (_n, e) => {
        expect(readIdentityCertificate(e as Record<string, string>, _n === 'inherited key' ? 'toString' : 'ap-south-1')).toBeNull();
    });
});
