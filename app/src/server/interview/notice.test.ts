import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { INTERVIEW_NOTICE, NOTICE_SHA256, NOTICE_TEXT, NOTICE_VERSION } from './notice';

/** The frozen vectors, as committed to this repo at the contract freeze (310f9f83). */
const vectors = JSON.parse(
    readFileSync(new URL('../../../../docs/contracts/interview-evidence-v1.vectors.json', import.meta.url), 'utf8'),
) as { notice: { version: number; bytes: number; sha256: string; text: string } };

const sha256 = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

describe('interview notice v1', () => {
    it('hashes to the pinned sha256, is 1972 bytes, and is version 1', () => {
        // SHIPPED behaviour: the embedded bytes are exactly the pinned notice.
        expect(Buffer.byteLength(NOTICE_TEXT, 'utf8')).toBe(1972);
        expect(sha256(NOTICE_TEXT)).toBe('a73e2521409a299375aeac8dfb21d95a7daab7e788405d6dda4e4a064f0e7336');
        expect(NOTICE_SHA256).toBe(sha256(NOTICE_TEXT));
        expect(NOTICE_VERSION).toBe(1);
    });

    it('equals the frozen vectors notice byte-for-byte', () => {
        expect(NOTICE_TEXT).toBe(vectors.notice.text);
        expect(NOTICE_SHA256).toBe(vectors.notice.sha256);
        expect(NOTICE_VERSION).toBe(vectors.notice.version);
        expect(Buffer.byteLength(NOTICE_TEXT, 'utf8')).toBe(vectors.notice.bytes);
    });

    it('positive control: any edit to the bytes changes the sha away from the pinned value', () => {
        // MUTANT behaviour: a single changed byte must not still hash to the pin.
        expect(sha256(NOTICE_TEXT + ' ')).not.toBe(NOTICE_SHA256);
        expect(sha256(NOTICE_TEXT.replace('version 1', 'version 2'))).not.toBe(NOTICE_SHA256);
    });

    it('exposes the status-action notice object the candidate receives', () => {
        expect(INTERVIEW_NOTICE).toEqual({ version: 1, sha256: NOTICE_SHA256, text: NOTICE_TEXT });
    });
});
