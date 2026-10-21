/**
 * Verify an EC2 instance identity document against its PKCS7 signature
 * (docs/AWS-COMPUTERS.md C-6 step 3, first check).
 *
 * The host (`infra/host-agent/lib/ezil_host/lease.py`) reads IMDSv2
 * `/latest/dynamic/instance-identity/document` and `…/pkcs7`: base64 DER of a
 * CMS SignedData over the document, without PEM armour. AWS verifies it with
 * `openssl smime -verify -content document -certfile <region certificate>`.
 *
 * 🔴 The ONLY trust anchor is the configured AWS public certificate for the
 * placement's region (`EZIL_AWS_IDENTITY_CERTS`, public, non-secret). Any
 * certificate embedded in the message is ignored. Exactly one signer; the
 * content must be the document, byte for byte; any structure this module does
 * not understand fails closed. No dependency: a minimal strict reader of DER plus
 * the two BER forms real IMDS output uses (measured live, ap-south-1 2026-10-21:
 * the message begins `30 80`): indefinite lengths on constructed values, and the
 * embedded document as a constructed OCTET STRING of primitive chunks. Signed
 * attributes must still be definite (the signature covers their DER).
 */

import { createHash, verify as cryptoVerify, X509Certificate } from 'node:crypto';

import type { Env } from './aws-config';

/** JSON object: AWS region → that region's PEM certificate for identity-document signatures. */
export const AWS_IDENTITY_CERTS_ENV = 'EZIL_AWS_IDENTITY_CERTS';

// ── DER ──────────────────────────────────────────────────────────────────

interface Tlv {
    tag: number;
    /** Offset of the tag byte. */
    start: number;
    /** Offset of the first value byte. */
    value: number;
    /** Offset after the whole element (for an indefinite length, after its end-of-contents). */
    end: number;
    /** Offset after the last content byte (before an end-of-contents marker). */
    contentEnd: number;
    indefinite: boolean;
}

/** Nesting bound for indefinite-length scanning (the real message nests 6 deep). */
const MAX_DEPTH = 24;

class DerError extends Error {}

function readTlv(buf: Buffer, at: number, limit = buf.length, depth = 0): Tlv {
    if (depth > MAX_DEPTH) throw new DerError('too deep');
    if (at + 2 > limit) throw new DerError('truncated');
    const tag = buf[at]!;
    if ((tag & 0x1f) === 0x1f) throw new DerError('high tag number');
    let len = buf[at + 1]!;
    let value = at + 2;
    if (len === 0x80) {
        // BER indefinite length: constructed only; content runs to an end-of-contents (00 00).
        if (!(tag & 0x20)) throw new DerError('indefinite primitive');
        for (let p = value; ; ) {
            if (p + 2 > limit) throw new DerError('missing end-of-contents');
            if (buf[p] === 0 && buf[p + 1] === 0) return { tag, start: at, value, contentEnd: p, end: p + 2, indefinite: true };
            p = readTlv(buf, p, limit, depth + 1).end;
        }
    }
    if (len & 0x80) {
        const n = len & 0x7f;
        // DER: no indefinite length, at most 4 length octets, minimal encoding.
        if (n === 0 || n > 4 || value + n > limit) throw new DerError('bad length');
        len = 0;
        for (let i = 0; i < n; i++) len = len * 256 + buf[value + i]!;
        if (len < 0x80 || buf[value] === 0) throw new DerError('non-minimal length');
        value += n;
    }
    const end = value + len;
    if (end > limit) throw new DerError('truncated value');
    return { tag, start: at, value, end, contentEnd: end, indefinite: false };
}

function children(buf: Buffer, node: Tlv): Tlv[] {
    if (!(node.tag & 0x20)) throw new DerError('not constructed');
    const out: Tlv[] = [];
    for (let at = node.value; at < node.contentEnd; ) {
        const c = readTlv(buf, at, node.contentEnd);
        out.push(c);
        at = c.end;
    }
    return out;
}

function expectTag(node: Tlv | undefined, tag: number): Tlv {
    if (!node || node.tag !== tag) throw new DerError(`expected tag 0x${tag.toString(16)}`);
    return node;
}

function oid(buf: Buffer, node: Tlv | undefined): string {
    const n = expectTag(node, 0x06);
    const bytes = buf.subarray(n.value, n.end);
    if (bytes.length === 0) throw new DerError('empty oid');
    const parts: number[] = [];
    let acc = 0;
    for (const b of bytes) {
        acc = acc * 128 + (b & 0x7f);
        if (!(b & 0x80)) {
            parts.push(acc);
            acc = 0;
        }
    }
    if (bytes[bytes.length - 1]! & 0x80) throw new DerError('bad oid');
    const first = parts.shift()!;
    const head = first < 80 ? [Math.floor(first / 40), first % 40] : [2, first - 80];
    return [...head, ...parts].join('.');
}

const SEQ = 0x30, SET = 0x31, OCTETS = 0x04, OCTETS_CONSTRUCTED = 0x24, INT = 0x02, CTX0 = 0xa0, CTX1 = 0xa1, PRIM_CTX0 = 0x80;

/** An OCTET STRING's bytes: primitive, or BER constructed from primitive chunks (one level). */
function octetString(buf: Buffer, node: Tlv | undefined): Buffer {
    if (node?.tag === OCTETS) return buf.subarray(node.value, node.end);
    const parts = children(buf, expectTag(node, OCTETS_CONSTRUCTED)).map((c) => buf.subarray(expectTag(c, OCTETS).value, c.end));
    return Buffer.concat(parts);
}

const OID = {
    signedData: '1.2.840.113549.1.7.2',
    data: '1.2.840.113549.1.7.1',
    contentType: '1.2.840.113549.1.9.3',
    messageDigest: '1.2.840.113549.1.9.4',
} as const;

const DIGESTS: Record<string, 'sha1' | 'sha256'> = {
    '1.3.14.3.2.26': 'sha1',
    '2.16.840.1.101.3.4.2.1': 'sha256',
};

/** Signature algorithm → [key type, digest or null (= the SignerInfo's digest)]. */
const SIGNATURES: Record<string, ['rsa' | 'dsa', 'sha1' | 'sha256' | null]> = {
    '1.2.840.113549.1.1.1': ['rsa', null],
    '1.2.840.113549.1.1.5': ['rsa', 'sha1'],
    '1.2.840.113549.1.1.11': ['rsa', 'sha256'],
    '1.2.840.10040.4.1': ['dsa', null],
    '1.2.840.10040.4.3': ['dsa', 'sha1'],
    '2.16.840.1.101.3.4.3.2': ['dsa', 'sha256'],
};

// ── Verification ─────────────────────────────────────────────────────────

export type IdentitySignatureResult = { ok: true } | { ok: false; reason: string };

/**
 * True only when `pkcs7` (IMDS form: base64, whitespace allowed) is a CMS
 * SignedData whose single signer signed exactly `document` with the key of
 * `certificatePem`, valid at `now`.
 */
export function verifyIdentitySignature(document: string, pkcs7: string, certificatePem: string, now: Date): IdentitySignatureResult {
    let cert: X509Certificate;
    try {
        cert = new X509Certificate(certificatePem);
    } catch {
        return { ok: false, reason: 'identity_certificate_invalid' };
    }
    const t = now.getTime();
    if (!(new Date(cert.validFrom).getTime() <= t && t <= new Date(cert.validTo).getTime())) return { ok: false, reason: 'identity_certificate_expired' };
    const keyType = cert.publicKey.asymmetricKeyType;
    if (keyType !== 'rsa' && keyType !== 'dsa') return { ok: false, reason: 'identity_certificate_invalid' };

    const compact = pkcs7.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) return { ok: false, reason: 'identity_signature_malformed' };
    const der = Buffer.from(compact, 'base64');
    const content = Buffer.from(document, 'utf8');
    try {
        const root = expectTag(readTlv(der, 0), SEQ);
        if (root.end !== der.length) throw new DerError('trailing bytes');
        const [type, wrapped] = children(der, root);
        if (oid(der, type) !== OID.signedData) throw new DerError('not signedData');
        const sd = expectTag(children(der, expectTag(wrapped, CTX0))[0], SEQ);
        const parts = children(der, sd);
        expectTag(parts[0], INT);
        expectTag(parts[1], SET);
        const encap = children(der, expectTag(parts[2], SEQ));
        if (oid(der, encap[0]) !== OID.data) throw new DerError('content is not data');
        if (encap.length > 1) {
            // Embedded content must be the document itself (a primitive OCTET STRING).
            const inner = children(der, expectTag(encap[1], CTX0));
            if (inner.length !== 1 || !octetString(der, inner[0]).equals(content)) return { ok: false, reason: 'identity_signature_mismatch' };
        }
        let i = 3;
        while (parts[i] && (parts[i]!.tag === CTX0 || parts[i]!.tag === CTX1)) i++; // certificates / CRLs: never trusted
        const signerSet = expectTag(parts[i], SET);
        if (i !== parts.length - 1) throw new DerError('unexpected trailing field');
        const signers = children(der, signerSet);
        if (signers.length !== 1) return { ok: false, reason: 'identity_signature_signers' };
        const si = children(der, expectTag(signers[0], SEQ));
        expectTag(si[0], INT);
        if (!si[1] || (si[1].tag !== SEQ && si[1].tag !== PRIM_CTX0)) throw new DerError('bad sid');
        const digest = DIGESTS[oid(der, children(der, expectTag(si[2], SEQ))[0])];
        if (!digest) return { ok: false, reason: 'identity_signature_algorithm' };
        let k = 3;
        let signed: Buffer = content;
        if (si[k]?.tag === CTX0) {
            const attrs = si[k]!;
            // The signature covers the attributes' DER: an indefinite (BER) encoding cannot be re-tagged.
            if (attrs.indefinite) throw new DerError('indefinite signed attributes');
            let digestOk = false;
            let typeOk = false;
            for (const attr of children(der, attrs)) {
                const [aType, aValues] = children(der, expectTag(attr, SEQ));
                const values = children(der, expectTag(aValues, SET));
                const id = oid(der, aType);
                if (id === OID.messageDigest) {
                    if (values.length !== 1) throw new DerError('messageDigest values');
                    const v = expectTag(values[0], OCTETS);
                    digestOk = der.subarray(v.value, v.end).equals(createHash(digest).update(content).digest());
                } else if (id === OID.contentType) {
                    typeOk = values.length === 1 && oid(der, values[0]) === OID.data;
                }
            }
            if (!digestOk || !typeOk) return { ok: false, reason: 'identity_signature_mismatch' };
            // RFC 5652 §5.4: the signature covers the attributes' DER with an explicit SET tag.
            signed = Buffer.concat([Buffer.from([SET]), der.subarray(attrs.start + 1, attrs.end)]);
            k++;
        }
        const sigAlg = SIGNATURES[oid(der, children(der, expectTag(si[k], SEQ))[0])];
        if (!sigAlg || sigAlg[0] !== keyType || (sigAlg[1] !== null && sigAlg[1] !== digest)) return { ok: false, reason: 'identity_signature_algorithm' };
        const sig = expectTag(si[k + 1], OCTETS);
        if (si.length > k + 2 && (si.length !== k + 3 || si[k + 2]!.tag !== CTX1)) throw new DerError('unexpected signer field');
        const good = cryptoVerify(digest, signed, cert.publicKey, der.subarray(sig.value, sig.end));
        return good ? { ok: true } : { ok: false, reason: 'identity_signature_mismatch' };
    } catch (error) {
        if (error instanceof DerError) return { ok: false, reason: 'identity_signature_malformed' };
        // A key/signature the crypto layer cannot even process is not a valid signature.
        return { ok: false, reason: 'identity_signature_mismatch' };
    }
}

/** The configured certificate for `region`, or null. Never a default. */
export function readIdentityCertificate(env: Env, region: string): string | null {
    const raw = env[AWS_IDENTITY_CERTS_ENV];
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.prototype.hasOwnProperty.call(parsed, region)) return null;
        const pem = (parsed as Record<string, unknown>)[region];
        return typeof pem === 'string' && pem.includes('-----BEGIN CERTIFICATE-----') ? pem : null;
    } catch {
        return null;
    }
}
