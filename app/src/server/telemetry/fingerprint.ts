/**
 * The fingerprint: the single most important structural decision in the
 * telemetry design (`scratchpad/telemetry-design.md` §2). Computed
 * SERVER-SIDE ONLY, here, so a shell `sandbox_start_failed` and a Worker
 * `sandbox_start_failed` at the same `site` are guaranteed byte-identical
 * fingerprints — clients never send one and are never trusted with one.
 *
 * `normalizeDetail` runs `sanitizeErrorMessage()` (redaction — see
 * `./sanitize.ts`) FIRST, then 13 ordered rewrites that erase everything that
 * varies per-user (ids, ports, durations, sizes, paths, quoted text) while
 * KEEPING short integers (exit codes, HTTP statuses, signal numbers) that
 * carry the actual diagnosis. Order is load-bearing: URLs must be eaten
 * before ports, durations before bare integers, or an earlier rule's leftover
 * digits get swallowed by a later, blunter one.
 */
import { createHash } from 'node:crypto';

import { sanitizeErrorMessage } from './sanitize';
import type { EventClass, Source } from './types';

export function normalizeDetail(input: unknown): string {
    let s = sanitizeErrorMessage(input);
    if (!s) return '';
    s = s
        // N1  data:/blob: URIs — unbounded, never useful.
        .replace(/\b(?:data|blob):[^\s'"]+/gi, '<uri>')
        // N2  Full URLs (eats their ports, query strings and path ids in one go).
        .replace(/\bhttps?:\/\/[^\s'"<>)\]]+/gi, '<url>')
        // N3  UUID v1-v5.
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
        // N4  Our own user hash (u_xxxxxxxx) and correlation ids (cid_...).
        .replace(/\bu_[0-9a-f]{8}\b/g, '<uhash>')
        .replace(/\bcid_[0-9a-z]+\b/gi, '<cid>')
        // N5  stack frame `file.js:LINE:COL` and `file.js:LINE` -> keep file, drop position.
        .replace(/([\w.-]+\.(?:js|mjs|ts|tsx|sh)):\d+(?::\d+)?/gi, '$1:<pos>')
        // N6  Durations. Must run BEFORE the port and bare-number rules.
        .replace(/\b\d+(?:\.\d+)?\s?(ms|s|m|h)\b/gi, '<dur>')
        // N7  Byte sizes.
        .replace(/\b\d+(?:\.\d+)?\s?(b|kb|mb|gb|kib|mib|gib)\b/gi, '<size>')
        // N8  Bare ports: `:8080` after a host-ish token, a `]`, or standalone at
        //     word start. 2-5 digits. Runs after URLs so it only sees the leftovers.
        .replace(/(^|[\s\]([{=,>a-z])(:\d{2,5})\b/gi, '$1:<port>')
        // N9  Absolute POSIX paths (workspace + container paths are user data).
        .replace(/(?:^|(?<=[\s'"(=]))\/(?:[\w.@+-]+\/)*[\w.@+-]*/g, '<path>')
        // N10 Long hex / base64ish opaque ids (sandbox ids, digests, R2 keys).
        .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
        .replace(/\b[A-Za-z0-9_-]{22,}\b/g, '<opaque>')
        // N11 Quoted free text -> <str>. App ids travel in `site`/`code`, not here.
        .replace(/"[^"]{0,120}"/g, '<str>')
        .replace(/'[^']{0,120}'/g, '<str>')
        // N12 Bare integers with 4+ digits. 1-3 digit integers are KEPT on purpose:
        //     exit codes (137), HTTP statuses (500, 412) and signal numbers are
        //     enum-like and are the whole diagnosis. Anything varying per-user with
        //     that few digits has already been caught by N5-N9.
        .replace(/\b\d{4,}\b/g, '<n>')
        // N13 Collapse and casefold.
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    return s.length > 120 ? s.slice(0, 120) : s;
}

export interface FingerprintInput {
    eventClass: EventClass;
    source: Source;
    site: string;
    code: string;
    detail?: string;
}

/**
 * `fp_` + first 16 hex chars of sha256(eventClass \x1f source \x1f site \x1f
 * code \x1f normalizeDetail(detail)). The ASCII Unit Separator (`\x1f`)
 * between fields (rather than plain concatenation) means a `site` ending in
 * a character that could also end a `code` can never produce the same
 * canonical string as a differently-split pair of fields.
 */
export function fingerprint(input: FingerprintInput): string {
    const canonical = [
        input.eventClass,
        input.source,
        input.site,
        input.code,
        normalizeDetail(input.detail ?? ''),
    ].join('\x1f');
    return 'fp_' + createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
}
