/**
 * Every handler returns EXACTLY the members this side declares, and the error
 * codes are the ones the contract names.
 *
 * ── What this test is, and what it is deliberately not ──────────────────────
 * This is a WIRE-SHAPE test. The browser is faked, on purpose: the question it
 * answers is "does `/type` still return `redacted`", not "does typing work" —
 * and a fake is the right instrument for the first question and worthless for
 * the second. Whether any of this actually drives Chrome is settled by
 * `worker/src/browser-sidecar.container.test.ts`, which boots the real image.
 *
 * The repo's own rule is that a test which mocks the thing it tests proves
 * nothing. That rule is about behaviour. The thing under test HERE is the set
 * of keys leaving the process, and the fake never supplies one of them — every
 * key asserted below is produced by `verbs.mjs` itself.
 */

import { describe, expect, it } from 'bun:test';
import { ERROR_CODES, SIDECAR_WIRE } from './contract.mjs';
import { VERBS, pngDimensions } from './verbs.mjs';

/** A 1x1 PNG. Real bytes, so `pngDimensions` and the sha are exercised for real. */
const PNG_1X1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
);

function fakeLocator (overrides = {}) {
    return {
        first: () => fakeLocator(overrides),
        count: async () => 1,
        click: async () => {},
        fill: async () => {},
        press: async () => {},
        screenshot: async () => PNG_1X1,
        ...overrides,
    };
}

function fakePage (overrides = {}) {
    return {
        url: () => 'https://example.com/page',
        title: async () => 'Example',
        goto: async () => {},
        waitForLoadState: async () => {},
        screenshot: async () => PNG_1X1,
        locator: () => fakeLocator(),
        frames: () => [],
        evaluate: async (fn) => {
            const src = String(fn);
            if (src.includes('data-ezil-ref')) {
                return { text: '- button "OK" [ref=e1]', refs: [{ ref: 'e1', role: 'button', name: 'OK', isPassword: false }], truncated: false };
            }
            if (src.includes('MAX_CHARS')) return '# Example\n\nbody';
            return true;
        },
        ...overrides,
    };
}

function fakeSurface (overrides = {}) {
    const page = overrides.page ?? fakePage();
    return {
        cdpUrl: 'http://127.0.0.1:9222',
        consoleBuffer: [{ level: 'error', text: 'boom', location: null, at: 'now' }],
        networkBuffer: [{ method: 'GET', url: 'https://example.com/a.js', status: 200, resourceType: 'script', failure: null, at: 'now' }],
        isConnected: () => true,
        activePage: async () => page,
        registerRefs: () => 1,
        rememberSecret: () => {},
        resolveRef: async (_page, ref) => ({ locator: fakeLocator(), meta: { role: 'textbox', name: 'Password', isPassword: ref === 'epw' } }),
        ...overrides,
    };
}

const BODY_FOR = {
    'GET /health': {},
    'POST /navigate': { url: 'https://example.com/' },
    'POST /snapshot': {},
    'POST /click': { ref: 'e1' },
    'POST /type': { ref: 'e1', text: 'hello' },
    'POST /get_text': {},
    'POST /screenshot': {},
    'POST /console': {},
    'POST /network': {},
    'POST /wait_for': { text: 'anything', time: 0.3 },
};

describe('every handler returns exactly the declared members', () => {
    it('covers every declared route (guards against a vacuous pass)', () => {
        expect(Object.keys(BODY_FOR).sort()).toEqual(Object.keys(SIDECAR_WIRE).sort());
        expect(Object.keys(VERBS).sort()).toEqual(Object.keys(SIDECAR_WIRE).sort());
    });

    for (const [route, spec] of Object.entries(SIDECAR_WIRE)) {
        it(`${route} -> {${spec.response.join(', ')}}`, async () => {
            const payload = await VERBS[route](fakeSurface(), BODY_FOR[route]);
            expect(Object.keys(payload).sort()).toEqual([...spec.response].sort());
            expect(payload.ok).toBe(true);
        });
    }
});

describe('the members that carry meaning, not just shape', () => {
    it('/type reports redacted:true for a password field and false otherwise', async () => {
        const pw = await VERBS['POST /type'](fakeSurface(), { ref: 'epw', text: 'hunter2-secret' });
        expect(pw.redacted).toBe(true);
        // …and the text is NOT echoed anywhere in the response, guard or no guard.
        expect(JSON.stringify(pw)).not.toContain('hunter2-secret');

        const plain = await VERBS['POST /type'](fakeSurface(), { ref: 'e1', text: 'hello' });
        expect(plain.redacted).toBe(false);
    });

    it('/type remembers a password value so the response guard can act on it', async () => {
        const remembered = [];
        const surface = fakeSurface({ rememberSecret: (v) => remembered.push(v) });
        await VERBS['POST /type'](surface, { ref: 'epw', text: 'hunter2-secret' });
        expect(remembered).toEqual(['hunter2-secret']);
    });

    it('/screenshot computes the sha256 HERE, over the bytes it produced', async () => {
        const shot = await VERBS['POST /screenshot'](fakeSurface(), {});
        // The digest of the known 1x1 PNG. If the sidecar ever started echoing
        // a caller-supplied digest, this is what would catch it.
        const expected = new Bun.CryptoHasher('sha256').update(PNG_1X1).digest('hex');
        expect(shot.sha256).toBe(expected);
        expect(shot.byteSize).toBe(PNG_1X1.length);
        expect(Buffer.from(shot.pngBase64, 'base64')).toEqual(PNG_1X1);
        expect({ width: shot.width, height: shot.height }).toEqual({ width: 1, height: 1 });
    });

    it('/screenshot asks Playwright to MASK every password field', async () => {
        let seen = null;
        const page = fakePage({ screenshot: async (opts) => { seen = opts; return PNG_1X1; } });
        await VERBS['POST /screenshot'](fakeSurface({ page }), {});
        // A password is not text in a PNG, so the text guard cannot reach it —
        // this option is the only thing that can. Removing it makes the
        // container suite's byte-identity check red.
        expect(Array.isArray(seen.mask)).toBe(true);
        expect(seen.mask).toHaveLength(1);
    });

    it('pngDimensions reads IHDR and refuses to guess at non-PNG bytes', () => {
        expect(pngDimensions(PNG_1X1)).toEqual({ width: 1, height: 1 });
        expect(pngDimensions(Buffer.from('not a png at all, honestly'))).toEqual({ width: 0, height: 0 });
    });

    it('/console rejects a level the contract does not define', async () => {
        await expect(VERBS['POST /console'](fakeSurface(), { level: 'catastrophe' }))
            .rejects.toMatchObject({ code: 'bad_request' });
    });

    it('/wait_for with neither text nor time is a bad_request, not a silent success', async () => {
        await expect(VERBS['POST /wait_for'](fakeSurface(), {}))
            .rejects.toMatchObject({ code: 'bad_request' });
    });

    it('/wait_for reports matched:false rather than throwing when the text never appears', async () => {
        const page = fakePage({ evaluate: async () => false });
        const out = await VERBS['POST /wait_for'](fakeSurface({ page }), { text: 'never', time: 0.5 });
        expect(out).toEqual({ ok: true, matched: false });
    });

    it('/navigate refuses javascript: and data: — the passthrough verb in disguise', async () => {
        for (const url of ['javascript:alert(1)', 'data:text/html,<script>fetch("/x")</script>', 'file:///etc/passwd', 'chrome://settings']) {
            await expect(VERBS['POST /navigate'](fakeSurface(), { url }))
                .rejects.toMatchObject({ code: 'bad_request' });
        }
    });

    it('/navigate reports navigation_failed, distinct from bad_request', async () => {
        const page = fakePage({ goto: async () => { throw new Error('net::ERR_NAME_NOT_RESOLVED'); } });
        await expect(VERBS['POST /navigate'](fakeSurface({ page }), { url: 'https://nope.invalid/' }))
            .rejects.toMatchObject({ code: 'navigation_failed' });
    });

    it('every code a handler can raise is one the contract names', async () => {
        const raised = new Set();
        const collect = async (fn) => { try { await fn(); } catch (e) { if (e.code) raised.add(e.code); } };
        await collect(() => VERBS['POST /navigate'](fakeSurface(), { url: 'javascript:1' }));
        await collect(() => VERBS['POST /navigate'](fakeSurface({ page: fakePage({ goto: async () => { throw new Error('x'); } }) }), { url: 'https://a.test/' }));
        await collect(() => VERBS['POST /type'](fakeSurface(), { ref: 'e1' }));
        await collect(() => VERBS['POST /console'](fakeSurface(), { level: 'nope' }));
        await collect(() => VERBS['POST /click'](fakeSurface({
            resolveRef: async () => { const e = new Error('gone'); e.code = 'stale_ref'; throw e; },
        }), { ref: 'e9' }));
        expect(raised.size).toBeGreaterThan(0);
        for (const code of raised) expect(ERROR_CODES).toContain(code);
    });
});

describe('there is no passthrough verb', () => {
    it('no route accepts arbitrary CDP, JS, or a command name', () => {
        for (const route of Object.keys(VERBS)) {
            const path = route.split(' ')[1];
            expect(['/evaluate', '/raw', '/send', '/cdp', '/exec', '/eval', '/execute']).not.toContain(path);
        }
    });

    it('no handler builds a function or evaluates a string from the request body', () => {
        // `page.evaluate` is only ever called with a function imported from
        // `page-scripts.mjs`, never with request-supplied source.
        const src = require('node:fs').readFileSync(new URL('./verbs.mjs', import.meta.url), 'utf8');
        expect(src).not.toMatch(/new Function\s*\(/);
        expect(src).not.toMatch(/\beval\s*\(/);
        expect(src).not.toMatch(/evaluate\(\s*body\./);
        expect(src).not.toMatch(/evaluate\(\s*`/);
    });
});
