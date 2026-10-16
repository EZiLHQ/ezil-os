import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeScreenshot, FeedbackImageError } from './image';
import { FEEDBACK_LIMITS, type FeedbackSubmit } from './types';

type ContentType = NonNullable<FeedbackSubmit['screenshot']>['contentType'];
function decode(bytes: Buffer, contentType: ContentType = 'image/png') {
    return decodeScreenshot({ contentType, dataBase64: bytes.toString('base64') });
}
function png(w = 640, h = 480) {
    const bytes = Buffer.alloc(33);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
    bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12); bytes.writeUInt32BE(w, 16); bytes.writeUInt32BE(h, 20);
    return bytes;
}
function jpeg(w = 640, h = 480, marker = 0xc0) {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, marker, 0, 11, 8, 0, 0, 0, 0, 1, 1, 0x11, 0]);
    bytes.writeUInt16BE(h, 13); bytes.writeUInt16BE(w, 15);
    return bytes;
}
function webp(kind: string, w = 640, h = 480) {
    const payload = Buffer.alloc(kind === 'VP8L' ? 5 : 10);
    if (kind === 'VP8L') { payload[0] = 0x2f; payload.writeUInt32LE(((w - 1) | ((h - 1) << 14)) >>> 0, 1); }
    else if (kind === 'VP8X') { payload.writeUIntLE(w - 1, 4, 3); payload.writeUIntLE(h - 1, 7, 3); }
    else { Buffer.from('9d012a', 'hex').copy(payload, 3); payload.writeUInt16LE(w, 6); payload.writeUInt16LE(h, 8); }
    const bytes = Buffer.alloc(20 + payload.length + payload.length % 2);
    bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WEBP', 8);
    bytes.write(kind, 12); bytes.writeUInt32LE(payload.length, 16); payload.copy(bytes, 20);
    return bytes;
}

describe('bounded screenshot headers', () => {
    it.each<[string, ContentType, () => Buffer]>([
        ['PNG', 'image/png', () => png()], ['JPEG baseline', 'image/jpeg', () => jpeg()],
        ['JPEG progressive', 'image/jpeg', () => jpeg(640, 480, 0xc2)],
        ...['VP8 ', 'VP8L', 'VP8X'].map((kind): [string, ContentType, () => Buffer] => [kind, 'image/webp', () => webp(kind)]),
    ])('reads %s dimensions, bytes and sha256', (_name, type, build) => {
        const bytes = build(); const image = decode(bytes, type);
        expect(image).toEqual({ contentType: type, width: 640, height: 480, byteLength: bytes.length, bytes, sha256: createHash('sha256').update(bytes).digest('hex') });
    });

    it.each<[ContentType, Buffer]>([
        ['image/jpeg', png()], ['image/webp', png()], ['image/png', jpeg()],
        ['image/png', Buffer.from('89504e47', 'hex')], ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff])],
        ['image/webp', Buffer.from('RIFF0000WEBP')],
    ])('rejects wrong or incomplete %s magic/header', (type, bytes) => {
        expect(() => decode(bytes, type)).toThrow(FeedbackImageError);
    });

    it.each(['', '%%%%', 'a===', 'AAA', 'AB==', 'data:image/png;base64,AAAA', 'AAAA\n'])('rejects malformed base64 %j', (dataBase64) => {
        expect(() => decodeScreenshot({ contentType: 'image/png', dataBase64 })).toThrow(FeedbackImageError);
    });

    it('rejects images over the decoded byte budget before parsing headers', () => {
        expect(() => decode(Buffer.alloc(FEEDBACK_LIMITS.imageBytesMax + 1))).toThrow(expect.objectContaining({ status: 413 }));
    });

    it.each<[ContentType, (w: number, h: number) => Buffer]>([
        ['image/png', png], ['image/jpeg', jpeg],
        ['image/webp', (w, h) => webp('VP8 ', w, h)], ['image/webp', (w, h) => webp('VP8L', w, h)],
        ['image/webp', (w, h) => webp('VP8X', w, h)],
    ])('rejects either oversized %s side and accepts the exact limit', (type, build) => {
        expect(() => decode(build(4097, 100), type)).toThrow(FeedbackImageError);
        expect(() => decode(build(100, 4097), type)).toThrow(FeedbackImageError);
        expect(decode(build(4096, 4096), type).width).toBe(4096);
    });

    it('rejects zero dimensions', () => {
        expect(() => decode(png(0, 1))).toThrow(FeedbackImageError);
        expect(() => decode(jpeg(1, 0), 'image/jpeg')).toThrow(FeedbackImageError);
        expect(() => decode(webp('VP8 ', 0, 1), 'image/webp')).toThrow(FeedbackImageError);
    });

    it('requires PNG IHDR and its declared length', () => {
        const wrongChunk = png(); wrongChunk.write('IDAT', 12);
        expect(() => decode(wrongChunk)).toThrow(FeedbackImageError);
        const wrongLength = png(); wrongLength.writeUInt32BE(12, 8);
        expect(() => decode(wrongLength)).toThrow(FeedbackImageError);
    });

    it.each([
        Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]),
        Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 100]),
        Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2]),
        Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        Buffer.from([0xff, 0xd8, 0xff, 0, 0, 2]),
    ])('rejects malformed JPEG segments without looping or reading out of bounds', (bytes) => {
        expect(() => decode(bytes, 'image/jpeg')).toThrow(FeedbackImageError);
    });

    it('rejects a truncated SOF component list', () => {
        const bytes = jpeg(); bytes[17] = 3;
        expect(() => decode(bytes, 'image/jpeg')).toThrow(FeedbackImageError);
    });

    it('rejects corrupt WebP lengths, signatures and VP8L versions', () => {
        const badRiff = webp('VP8X'); badRiff.writeUInt32LE(0, 4);
        const badChunk = webp('VP8X'); badChunk.writeUInt32LE(100, 16);
        const badVp8 = webp('VP8 '); badVp8[23] = 0;
        const badVp8L = webp('VP8L'); badVp8L[20] = 0;
        const version = webp('VP8L'); version[24] = 0xe0;
        const interframe = webp('VP8 '); interframe[20] = 1;
        for (const bytes of [badRiff, badChunk, badVp8, badVp8L, version, interframe]) {
            expect(() => decode(bytes, 'image/webp')).toThrow(FeedbackImageError);
        }
    });

    it('checks bitstream dimensions even when the WebP extended canvas is small', () => {
        const bytes = Buffer.concat([webp('VP8X', 100, 100), webp('VP8 ', 4097, 100).subarray(12)]);
        bytes.writeUInt32LE(bytes.length - 8, 4);
        expect(() => decode(bytes, 'image/webp')).toThrow(FeedbackImageError);
    });

    it('rejects missing WebP dimension chunks, duplicate canvases and trailing partial chunks', () => {
        const unknown = webp('VP8X'); unknown.write('JUNK', 12);
        const duplicate = Buffer.concat([webp('VP8X'), webp('VP8X').subarray(12)]);
        duplicate.writeUInt32LE(duplicate.length - 8, 4);
        const trailing = Buffer.concat([webp('VP8X'), Buffer.from([0])]);
        trailing.writeUInt32LE(trailing.length - 8, 4);
        for (const bytes of [unknown, duplicate, trailing]) expect(() => decode(bytes, 'image/webp')).toThrow(FeedbackImageError);
    });

    it('rejects truncated WebP chunk payloads and a wrong extended header size', () => {
        for (const kind of ['VP8 ', 'VP8L', 'VP8X']) {
            const bytes = webp(kind).subarray(0, 24);
            bytes.writeUInt32LE(bytes.length - 8, 4); bytes.writeUInt32LE(4, 16);
            expect(() => decode(bytes, 'image/webp')).toThrow(FeedbackImageError);
        }
    });

    it('rejects JPEG marker gaps, exhausted headers and empty SOF component lists', () => {
        const gap = jpeg(); gap[8] = 0;
        const empty = jpeg(); empty[17] = 0; empty.writeUInt16BE(8, 10);
        for (const bytes of [gap, empty, jpeg().subarray(0, 8), Buffer.from([0xff, 0xd8, 0xff, 0xff])]) {
            expect(() => decode(bytes, 'image/jpeg')).toThrow(FeedbackImageError);
        }
    });
});
