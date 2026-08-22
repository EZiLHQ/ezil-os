/**
 * The redaction guard, and the proof that it is the thing doing the work.
 *
 * 🔴 MUTATION PROCEDURE — run it, do not take this file's word for it:
 *
 *     cd worker/sidecar
 *     bun test redaction.test.mjs                      # green
 *     sed -i 's|^export function redactSecrets (text, secrets) {|export function redactSecrets (text, secrets) { return text;|' redact.mjs
 *     bun test redaction.test.mjs                      # MUST be red
 *     git checkout redact.mjs
 *
 * Recorded result of that mutation (2026-08-21, this tree): 10 of the 15 tests
 * below fail, including every one that asserts a typed password is absent from
 * a response. See `README.md`.
 *
 * The payloads below are the SHAPES the verb handlers really return — a
 * `/snapshot` tree with the value inline, a `/get_text` markdown blob, a
 * `/console` entry array, a `/network` record with the value in a POST body
 * string, and the `{ok:false,error,detail}` error shape. That matters: a guard
 * proven only against `{a: "secret"}` is a guard proven against nothing that
 * ships.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MIN_SECRET_LENGTH, REDACTED, normaliseSecrets, redactDeep, redactSecrets } from './redact.mjs';

const SECRET = 'hunter2-correct-horse';

describe('redactSecrets: the primitive', () => {
    it('removes the value and leaves a marker the caller can recognise', () => {
        const out = redactSecrets(`typed ${SECRET} into the box`, [SECRET]);
        expect(out).not.toContain(SECRET);
        expect(out).toBe(`typed ${REDACTED} into the box`);
    });

    it('removes EVERY occurrence, not just the first', () => {
        const out = redactSecrets(`${SECRET} and ${SECRET} again`, [SECRET]);
        expect(out).not.toContain(SECRET);
        expect(out.split(REDACTED)).toHaveLength(3);
    });

    it('replaces the longest secret whole rather than shredding it', () => {
        // `abc` is a secret AND a substring of the longer one. Shortest-first
        // would leave `[redacted]def` — a partial disclosure that also tells
        // an attacker the tail.
        const out = redactSecrets('xabcdefx', ['abc', 'abcdef']);
        expect(out).toBe(`x${REDACTED}x`);
    });

    it('leaves a string alone when no secret is known', () => {
        expect(redactSecrets('nothing to hide', [])).toBe('nothing to hide');
    });

    it('declines to act on values too short to redact without destroying the response', () => {
        expect(MIN_SECRET_LENGTH).toBeGreaterThan(2);
        const short = 'a'.repeat(MIN_SECRET_LENGTH - 1);
        expect(redactSecrets(`a banana ${short}`, [short])).toBe(`a banana ${short}`);
        const ok = 'a'.repeat(MIN_SECRET_LENGTH);
        expect(redactSecrets(`x${ok}x`, [ok])).toBe(`x${REDACTED}x`);
    });

    it('orders longest-first and de-duplicates', () => {
        expect(normaliseSecrets(['abc', 'abcdef', 'abc', 'x'])).toEqual(['abcdef', 'abc']);
    });
});

describe('redactDeep: the shapes that actually leave this process', () => {
    it('scrubs a /snapshot tree that has the value inline', () => {
        // This is verbatim what `page-scripts.mjs` emits: it prints the value
        // of every textbox INCLUDING a password field, on purpose, so that
        // this guard is the only thing between it and the socket.
        const payload = {
            ok: true,
            snapshot: [
                '- form [ref=e1]',
                '  - textbox "Email" [ref=e2]: nobody@example.com',
                `  - textbox "Password" [ref=e3] [type=password]: ${SECRET}`,
                '  - button "Sign in" [ref=e4]',
            ].join('\n'),
            url: 'https://example.com/login',
            title: 'Sign in',
        };
        const out = redactDeep(payload, [SECRET]);
        expect(JSON.stringify(out)).not.toContain(SECRET);
        expect(out.snapshot).toContain(REDACTED);
        // Everything that is not a secret survives untouched.
        expect(out.snapshot).toContain('nobody@example.com');
        expect(out.url).toBe('https://example.com/login');
    });

    it('scrubs /get_text markdown', () => {
        const payload = { ok: true, markdown: `# Login\n\nvalue was ${SECRET}`, url: 'https://example.com/' };
        expect(JSON.stringify(redactDeep(payload, [SECRET]))).not.toContain(SECRET);
    });

    it('scrubs /console entries (a page that logs what the user typed)', () => {
        const payload = {
            ok: true,
            entries: [
                { level: 'log', text: `submitting password=${SECRET}`, location: 'https://example.com/app.js:12' },
                { level: 'error', text: 'unrelated', location: null },
            ],
        };
        const out = redactDeep(payload, [SECRET]);
        expect(JSON.stringify(out)).not.toContain(SECRET);
        expect(out.entries[1].text).toBe('unrelated');
    });

    it('scrubs a /network record that carries the value in the URL', () => {
        const payload = {
            ok: true,
            requests: [{ method: 'GET', url: `https://example.com/login?pw=${SECRET}`, status: 200 }],
        };
        expect(JSON.stringify(redactDeep(payload, [SECRET]))).not.toContain(SECRET);
    });

    it('scrubs the ERROR shape too — a Playwright message can quote the value', () => {
        const payload = {
            ok: false,
            error: 'stale_ref',
            detail: `locator.fill: value "${SECRET}" — element is not attached to the DOM`,
        };
        const out = redactDeep(payload, [SECRET]);
        expect(JSON.stringify(out)).not.toContain(SECRET);
        expect(out.error).toBe('stale_ref');
    });

    it('scrubs object KEYS, not only values', () => {
        // A captured form post can land a credential in a key position.
        const payload = { ok: true, requests: [{ postData: { [SECRET]: '1' } }] };
        expect(JSON.stringify(redactDeep(payload, [SECRET]))).not.toContain(SECRET);
    });

    it('leaves non-string members intact', () => {
        const payload = { ok: true, byteSize: 4096, width: 1920, height: 1080, matched: false };
        expect(redactDeep(payload, [SECRET])).toEqual(payload);
    });
});

describe('the choke point is a choke point', () => {
    const serverSource = readFileSync(fileURLToPath(new URL('./server.mjs', import.meta.url)), 'utf8');
    const verbsSource = readFileSync(fileURLToPath(new URL('./verbs.mjs', import.meta.url)), 'utf8');

    it('respond() is the only thing that writes a body, and it redacts', () => {
        // If a second writer appears, the single-guard argument collapses and
        // the mutation proof above stops meaning what it says.
        const writers = serverSource.match(/res\.end\(/g) ?? [];
        expect(writers).toHaveLength(1);
        const respond = serverSource.slice(
            serverSource.indexOf('async function respond ('),
            serverSource.indexOf('function errorPayload ('),
        );
        expect(respond).toContain('redactDeep(payload, secrets)');
        expect(respond.indexOf('redactDeep')).toBeLessThan(respond.indexOf('res.end('));
    });

    it('the verb handlers do NOT redact — that is what makes the one guard load-bearing', () => {
        expect(verbsSource).not.toContain('redactDeep');
        expect(verbsSource).not.toContain('redactSecrets');
    });
});
