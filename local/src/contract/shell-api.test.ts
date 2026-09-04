/**
 * The drift guard between local mode's shell contract and the app's.
 *
 * Two properties, and they fail for different reasons:
 *
 *   1. THE ROUTE TABLE. A key in `desktopState.endpoints` is a feature switch
 *      the shell reads — publish one the host does not serve and the user gets
 *      a control that 404s; omit one it does serve and the feature silently
 *      never appears. So both directions are checked: a key present here and
 *      missing there is a failure, and so is the reverse.
 *
 *   2. THE ESCAPER. `serializeBootPayload`'s output is inlined into a
 *      `<script>` element, and the payload carries user-controlled strings (the
 *      computer name, the email address). A drifted escaper is an XSS. So the
 *      two implementations are compared BYTE for byte, over the literal
 *      `</script>` / `<!--` / U+2028 / U+2029 the brief names, and then over
 *      every code unit from U+0000 to U+FFFF — which proves equality of
 *      BEHAVIOUR rather than equality of the handful of inputs someone thought
 *      to try.
 *
 * 🔴 IMPORTING THE APP MODULE HERE IS SAFE, AND THAT WAS MEASURED, NOT ASSUMED.
 * `app/src/server/shell/boot-payload.ts`'s only import is
 * `import type { Computer } from '@/server/db/schema'`, which Bun erases
 * entirely — no Next.js runtime, no `@/env` validation, no database client is
 * loaded. `bun -e "import('.../boot-payload.ts')"` resolves and reports 9
 * route keys. `tsc --listFiles` shows the compile pulling in exactly four app
 * files (boot-payload plus the three `db/schema` modules), and all four
 * typecheck clean under this package's `noUncheckedIndexedAccess`. Because the
 * import works, the weaker source-text-diff fallback is NOT used.
 */

import { describe, expect, it } from 'bun:test';

import {
    SHELL_API_ROUTES as LOCAL_ROUTES,
    SHELL_API_ROUTE_KEYS,
    bootPayloadScript as localBootPayloadScript,
    serializeBootPayload as localSerialize,
} from './shell-api.ts';
import {
    SHELL_API_ROUTES as APP_ROUTES,
    bootPayloadScript as appBootPayloadScript,
    serializeBootPayload as appSerialize,
    type ShellBootPayload,
} from '../../../app/src/server/shell/boot-payload.ts';

const encoder = new TextEncoder();

/** Equality of BYTES, not of JS strings — the property the doc comments claim. */
function bytesOf(s: string): Uint8Array {
    return encoder.encode(s);
}

describe('the route table has not drifted from the app', () => {
    it('the app module really loaded (positive control for every comparison below)', () => {
        // Without this, a module that somehow resolved to `{}` would make every
        // "same keys" assertion below vacuously true.
        expect(typeof APP_ROUTES).toBe('object');
        expect(Object.keys(APP_ROUTES).length).toBe(9);
        expect(typeof appSerialize).toBe('function');
    });

    it('local declares exactly the app\'s nine keys, in the same order', () => {
        expect(Object.keys(LOCAL_ROUTES)).toEqual(Object.keys(APP_ROUTES));
        expect(SHELL_API_ROUTE_KEYS.length).toBe(9);
    });

    it('no key the app has is missing here', () => {
        const missingLocally = Object.keys(APP_ROUTES).filter((k) => !(k in LOCAL_ROUTES));
        expect(missingLocally).toEqual([]);
    });

    it('no key here is absent from the app', () => {
        const missingUpstream = Object.keys(LOCAL_ROUTES).filter((k) => !(k in APP_ROUTES));
        expect(missingUpstream).toEqual([]);
    });

    it('every path string is identical', () => {
        expect({ ...LOCAL_ROUTES }).toEqual({ ...APP_ROUTES });
    });

    it('every path is same-origin and relative — never an absolute URL', () => {
        for (const [key, path] of Object.entries(LOCAL_ROUTES)) {
            expect(path.startsWith('/api/shell/')).toBe(true);
            expect(path).not.toContain('://');
            expect(key.length).toBeGreaterThan(0);
        }
    });

    it('the five feature-detected controls are all present', () => {
        // These are the keys the shell reads to decide whether to draw a control
        // at all (`focus`, `telemetry`, `restart`, `activity`, `screen`).
        for (const key of ['focus', 'telemetry', 'restart', 'activity', 'screen'] as const) {
            expect(LOCAL_ROUTES[key]).toBe(APP_ROUTES[key]);
        }
    });
});

describe('the boot-payload serializer is byte-identical to the app\'s', () => {
    /** Everything the brief names, inside real user-controlled payload fields. */
    const ADVERSARIAL = {
        user: { id: 'u1', email: 'a</script><script>alert(1)</script>@example.com' },
        computer: {
            id: 'c1',
            name: '</script> <!-- \u2028 \u2029 <img src=x onerror=alert(1)>',
            slot: 0,
            createdAt: '2026-09-04T00:00:00.000Z',
            lastOpenedAt: null,
            isNew: true,
        },
        apps: [{ id: 'desktop', name: 'Browser', icon: 'desktop', kind: 'desktop' }],
        desktopState: {
            provider: 'cloudflare-guacamole',
            configured: true,
            hasHmacSecret: true,
            status: 'idle',
            endpoints: LOCAL_ROUTES,
        },
    } as unknown as ShellBootPayload;

    it('agrees on the adversarial payload, byte for byte', () => {
        const a = appSerialize(ADVERSARIAL);
        const l = localSerialize(ADVERSARIAL);
        // Positive control: the output is real, non-trivial, and actually
        // contains the escapes at issue — otherwise `'' === ''` would pass.
        expect(a.length).toBeGreaterThan(200);
        expect(a).toContain('\\u003c');
        expect(a).toContain('\\u2028');
        expect(a).toContain('\\u2029');
        expect(l).toBe(a);
        expect(bytesOf(l)).toEqual(bytesOf(a));
    });

    it('leaves no raw `<` anywhere in the output', () => {
        const out = localSerialize(ADVERSARIAL);
        expect(out.includes('<')).toBe(false);
        // Positive control: the INPUT did contain `<`, so the absence above is
        // a property of the escaper and not of the fixture.
        expect(JSON.stringify(ADVERSARIAL).includes('<')).toBe(true);
    });

    it('round-trips to the original text — escaping `<` changes no value', () => {
        const parsed = JSON.parse(localSerialize(ADVERSARIAL)) as ShellBootPayload;
        expect(parsed.computer.name).toBe(ADVERSARIAL.computer.name);
        expect(parsed.user.email).toBe(ADVERSARIAL.user.email);
    });

    it('agrees on every code unit from U+0000 to U+FFFF', () => {
        // The strongest form of "byte-identical": not four inputs someone chose,
        // but the whole BMP including lone surrogates and every control
        // character, in 32 chunks of 2048.
        let compared = 0;
        for (let base = 0; base < 0x10000; base += 2048) {
            let chunk = '';
            for (let i = base; i < base + 2048; i += 1) chunk += String.fromCharCode(i);
            const payload = { user: { id: 'u1', email: null }, name: chunk } as unknown as ShellBootPayload;
            const a = appSerialize(payload);
            const l = localSerialize(payload);
            expect(bytesOf(l)).toEqual(bytesOf(a));
            compared += 1;
        }
        expect(compared).toBe(32);
    });

    it('agrees on the degenerate shapes too', () => {
        for (const value of [null, 0, '', 'plain', [], {}, { a: [1, '<', null] }] as unknown[]) {
            expect(localSerialize(value as ShellBootPayload)).toBe(appSerialize(value as ShellBootPayload));
        }
    });

    it('throws for a value JSON cannot represent, exactly as upstream does', () => {
        // Not "it throws": both must fail the SAME way, because a local host
        // that silently emitted `undefined` into a <script> would be worse than
        // one that crashed.
        expect(() => appSerialize(undefined as unknown as ShellBootPayload)).toThrow(TypeError);
        expect(() => localSerialize(undefined)).toThrow(TypeError);
    });

    it('emits the same inline script body', () => {
        const a = appBootPayloadScript(ADVERSARIAL);
        const l = localBootPayloadScript(ADVERSARIAL);
        expect(a.startsWith('window.__EZIL_BOOT__=')).toBe(true);
        expect(a.endsWith(';')).toBe(true);
        expect(bytesOf(l)).toEqual(bytesOf(a));
    });

    it('the script body cannot close the element it is inlined in', () => {
        const body = localBootPayloadScript(ADVERSARIAL);
        expect(body.toLowerCase().includes('</script')).toBe(false);
        expect(body.includes('<!--')).toBe(false);
        // Positive control: the payload that produced it did contain both.
        expect(ADVERSARIAL.computer.name.includes('</script>')).toBe(true);
        expect(ADVERSARIAL.computer.name.includes('<!--')).toBe(true);
    });
});
