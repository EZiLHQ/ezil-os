import { z } from 'zod';

export const RebaseUuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const RebaseDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const RebaseHash = z.string().regex(/^[0-9a-f]{64}$/);
export const RebaseCounter = z.number().int().min(1).max(2147483647);
export const RebaseVolume = z.string().regex(/^vol-[0-9a-f]{17}$/);
export const RebaseSnapshot = z.string().regex(/^snap-[0-9a-f]{8,17}$/);
export const RebaseTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    .refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v);

/** Bounded JSON with duplicate member detection, including escaped member names. */
export function parseRebaseJson(text: string, maxBytes = 16384): unknown {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('invalid_json');
    let at = 0;
    const fail = (): never => { throw new Error('invalid_json'); };
    const space = () => { while (/[\t\n\r ]/.test(text[at] ?? '\0')) at++; };
    const string = (): string => {
        const start = at++;
        while (at < text.length) {
            const c = text[at++];
            if (c === '\\') at++;
            else if (c === '"') return JSON.parse(text.slice(start, at)) as string;
        }
        return fail();
    };
    const value = (depth: number): unknown => {
        if (depth > 64) return fail();
        space();
        if (text[at] === '"') return string();
        if (text[at] === '{') {
            at++; space();
            const out: Record<string, unknown> = Object.create(null);
            if (text[at] === '}') { at++; return out; }
            for (;;) {
                space();
                if (text[at] !== '"') return fail();
                const key = string(); space();
                if (Object.hasOwn(out, key) || text[at++] !== ':') return fail();
                out[key] = value(depth + 1); space();
                const c = text[at++];
                if (c === '}') return out;
                if (c !== ',') return fail();
            }
        }
        if (text[at] === '[') {
            at++; space();
            const out: unknown[] = [];
            if (text[at] === ']') { at++; return out; }
            for (;;) {
                out.push(value(depth + 1)); space();
                const c = text[at++];
                if (c === ']') return out;
                if (c !== ',') return fail();
            }
        }
        const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(at));
        if (!token) return fail();
        at += token[0].length;
        const result: unknown = JSON.parse(token[0]);
        if (typeof result === 'number' && !Number.isFinite(result)) return fail();
        return result;
    };
    const result = value(0); space();
    if (at !== text.length) return fail();
    return result;
}
