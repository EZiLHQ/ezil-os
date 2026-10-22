import { z } from 'zod';

export const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const COUNTER = z.number().int().min(1).max(2147483647);
export const DIGEST = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const HASH = z.string().regex(/^[0-9a-f]{64}$/);
export const VOL = z.string().regex(/^vol-[0-9a-f]{17}$/);
export const SNAP = z.string().regex(/^snap-[0-9a-f]{8,17}$/);
export const INSTANCE = z.string().regex(/^i-[0-9a-f]{17}$/);
export const TIME = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine(value => {
    const ms = Date.parse(value);
    return Number.isFinite(ms) && new Date(ms).toISOString() === value;
});

/** Bounded JSON with duplicate-key rejection (including escaped aliases).
 * JSON.parse alone silently overwrites the first occurrence. Never include
 * source text in errors: these documents can contain enrollment nonces. */
export function strictJson(raw: string, maximum: number): unknown {
    const bad = (): never => { throw new Error('invalid_json'); };
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > maximum) return bad();
    let at = 0;
    const space = () => { while (/[\x20\t\n\r]/.test(raw[at] ?? '') && at < raw.length) at++; };
    const string = (): string => {
        const start = at++;
        while (at < raw.length) {
            const c = raw[at++];
            if (c === '"') return JSON.parse(raw.slice(start, at)) as string;
            if (c === '\\') at++;
        }
        return bad();
    };
    const value = (depth: number): unknown => {
        if (depth > 32) return bad();
        space();
        const c = raw[at];
        if (c === '"') return string();
        if (c === '{' || c === '[') {
            at++; space();
            const object = c === '{', end = object ? '}' : ']';
            const result: Record<string, unknown> = Object.create(null), list: unknown[] = [];
            const keys = new Set<string>();
            if (raw[at] === end) { at++; return object ? result : list; }
            for (;;) {
                space();
                if (object) {
                    if (raw[at] !== '"') return bad();
                    const key = string(); space();
                    if (keys.has(key) || raw[at++] !== ':') return bad();
                    keys.add(key); result[key] = value(depth + 1);
                } else list.push(value(depth + 1));
                space();
                if (raw[at] === end) { at++; return object ? result : list; }
                if (raw[at++] !== ',') return bad();
            }
        }
        const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(raw.slice(at))?.[0];
        if (!token) return bad();
        at += token.length;
        const parsed: unknown = JSON.parse(token);
        if (typeof parsed === 'number' && !Number.isFinite(parsed)) return bad();
        return parsed;
    };
    const result = value(0); space();
    if (at !== raw.length) return bad();
    return result;
}

export function decodeLeaseJson(encoded: string): unknown {
    if (typeof encoded !== 'string' || encoded.length > 4096 || !encoded.length) throw new Error('invalid_lease');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length > 3072 || bytes.toString('base64') !== encoded) throw new Error('invalid_lease');
    const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return strictJson(raw, 3072);
}
