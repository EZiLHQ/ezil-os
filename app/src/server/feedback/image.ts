import { createHash } from 'node:crypto';
import { FEEDBACK_LIMITS, type FeedbackSubmit } from './types';

export class FeedbackImageError extends Error {
    constructor(public readonly status: 400 | 413 = 400) {
        super(status === 413 ? 'payload_too_large' : 'invalid_request');
    }
}

export interface FeedbackImage {
    contentType: NonNullable<FeedbackSubmit['screenshot']>['contentType'];
    bytes: Buffer;
    byteLength: number;
    sha256: string;
    width: number;
    height: number;
}

function invalid(): never { throw new FeedbackImageError(); }

function pngSize(bytes: Buffer): [number, number] {
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
        || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') invalid();
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

function jpegSize(bytes: Buffer): [number, number] {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) invalid();
    let offset = 2;
    while (offset < bytes.length) {
        if (bytes[offset++] !== 0xff) invalid();
        while (bytes[offset] === 0xff) offset++;
        const marker = bytes[offset++];
        if (marker === undefined || marker === 0xda || marker === 0xd9 || marker === 0) invalid();
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (offset + 2 > bytes.length) invalid();
        const length = bytes.readUInt16BE(offset);
        if (length < 2 || offset + length > bytes.length) invalid();
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
            if (length < 8 || bytes[offset + 7] === 0 || length !== 8 + 3 * bytes[offset + 7]!) invalid();
            return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
        }
        offset += length;
    }
    return invalid();
}

function webpSize(bytes: Buffer): [number, number] {
    if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'RIFF'
        || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length) invalid();
    let offset = 12;
    let canvas: [number, number] | undefined;
    let frame: [number, number] | undefined;
    while (offset + 8 <= bytes.length) {
        const kind = bytes.toString('ascii', offset, offset + 4);
        const length = bytes.readUInt32LE(offset + 4);
        const start = offset + 8;
        const end = start + length;
        if (end + (length % 2) > bytes.length) invalid();
        let size: [number, number] | undefined;
        if (kind === 'VP8X') {
            if (length !== 10 || canvas) invalid();
            size = [bytes.readUIntLE(start + 4, 3) + 1, bytes.readUIntLE(start + 7, 3) + 1];
            canvas = size;
        } else if (kind === 'VP8L') {
            if (length < 5 || bytes[start] !== 0x2f || (bytes[start + 4]! & 0xe0) !== 0) invalid();
            const bits = bytes.readUInt32LE(start + 1);
            size = [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
            frame = size;
        } else if (kind === 'VP8 ') {
            if (length < 10 || (bytes[start]! & 1) !== 0
                || !bytes.subarray(start + 3, start + 6).equals(Buffer.from('9d012a', 'hex'))) invalid();
            size = [bytes.readUInt16LE(start + 6) & 0x3fff, bytes.readUInt16LE(start + 8) & 0x3fff];
            frame = size;
        }
        // Inspect both the canvas and bitstream headers; a small VP8X canvas
        // must not hide an oversized VP8 frame (feedback/types.ts:17).
        if (size) checkSize(size);
        offset = end + (length % 2);
    }
    if (offset !== bytes.length) invalid();
    return canvas ?? frame ?? invalid();
}

function checkSize([width, height]: [number, number]): void {
    if (width < 1 || height < 1 || width > FEEDBACK_LIMITS.imageSideMax || height > FEEDBACK_LIMITS.imageSideMax) invalid();
}

/** Inspect bounded headers without decompressing untrusted pixels. The server
 * derives dimensions itself; the wire has none (feedback/types.ts:60). */
export function decodeScreenshot(input: NonNullable<FeedbackSubmit['screenshot']>): FeedbackImage {
    const encoded = input.dataBase64;
    if (encoded.length > Math.ceil(FEEDBACK_LIMITS.imageBytesMax / 3) * 4) throw new FeedbackImageError(413);
    // Buffer's decoder silently ignores garbage, so validate and round-trip the
    // encoding before trusting its decoded length (docs/FEEDBACK-CONTROLS-CONTRACT.md:125).
    if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) invalid();
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length > FEEDBACK_LIMITS.imageBytesMax) throw new FeedbackImageError(413);
    if (bytes.toString('base64') !== encoded) invalid();
    const size = input.contentType === 'image/png' ? pngSize(bytes)
        : input.contentType === 'image/jpeg' ? jpegSize(bytes) : webpSize(bytes);
    checkSize(size);
    return {
        contentType: input.contentType,
        bytes,
        byteLength: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        width: size[0],
        height: size[1],
    };
}
