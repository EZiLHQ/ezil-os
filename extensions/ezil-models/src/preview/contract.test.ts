import { describe, expect, test } from 'bun:test';
import vectors from '../../../../docs/contracts/code-preview-v1.vectors.json';
import { attachmentName, renderSelectionContext, sanitizeUrl, validateAttachment, validateMintReply, validateSelection, type Selection } from './contract';
import { frameTarget, persistedState, PreviewHistory, safeUrl, transportUrl } from './state';

describe('frameTarget', () => {
    const pinned = 'https://3002-guac-u1-c1-app.ezil.org';
    test('keeps an https URL on the pinned origin, rebuilt from its parts', () => {
        expect(frameTarget(`${pinned}/preview-bootstrap?token=t%3D1&path=%2Fa#x`, pinned)).toBe(`${pinned}/preview-bootstrap?token=t%3D1&path=%2Fa#x`);
        expect(frameTarget(`${pinned}/preview/pricing?tab=2`, pinned)).toBe(`${pinned}/preview/pricing?tab=2`);
    });
    test('refuses script schemes, other origins, userinfo, ports and garbage', () => {
        for (const url of ['javascript:alert(1)', 'data:text/html,<script>1</script>', `http://3002-guac-u1-c1-app.ezil.org/`,
            'https://3002-guac-u2-c9-app.ezil.org/', 'https://8443-guac-u1-c1-code.ezil.org/', `https://user:pw@3002-guac-u1-c1-app.ezil.org/`,
            'https://3002-guac-u1-c1-app.ezil.org:444/', '//3002-guac-u1-c1-app.ezil.org/', 'not a url', '']) {
            expect(frameTarget(url, pinned)).toBeUndefined();
        }
    });
});

function expand(value: unknown): any {
    if (typeof value === 'string' && value.startsWith('@repeat:')) { const [, text, count] = value.split(':'); return text!.repeat(Number(count)); }
    if (Array.isArray(value)) return value.map(expand);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)]));
    return value;
}
export const selection = (): Selection => structuredClone(vectors.selection.accept[0]!.sel) as Selection;

describe('every frozen v1 vector', () => {
    for (const [i, vector] of vectors.sanitizeUrl.entries()) test(`sanitize URL ${i + 1}`, () => expect(sanitizeUrl(vector.in)).toBe(vector.out));
    for (const vector of vectors.selection.accept) test(`accept selection: ${vector.name}`, () => {
        expect(validateSelection(vector.sel)).toBe(true);
        const sel = vector.sel as Selection;
        const value = renderSelectionContext(sel, { stale: false });
        expect(value).toContain('DOM snapshot from the live preview; not a source location');
        expect(value.length).toBeLessThanOrEqual(4000);
        expect(attachmentName(sel).length).toBeLessThanOrEqual(80);
        // The same Markdown escaping renderSelectionContext applies (backslash included), not a partial copy of it.
        if (sel.el.source) expect(value).toContain(sel.el.source.eid.replace(/[\\`*_{}\[\]()<>#+.!|~-]/g, '\\$&'));
        else expect(value).not.toContain('data-eid');
    });
    for (const vector of vectors.selection.refuse) test(`refuse selection: ${vector.name}`, () => {
        let value: any = selection();
        if ('replace' in vector) value = vector.replace;
        else for (const [path, replacement] of Object.entries(vector.patch!)) {
            const segments = path.split('.');
            let target = value;
            for (const segment of segments.slice(0, -1)) target = target[segment];
            target[segments.at(-1)!] = expand(replacement);
        }
        expect(validateSelection(value)).toBe(false);
    });
    for (const kind of ['accept', 'refuse'] as const) {
        for (const [i, value] of vectors.attachment[kind].entries()) test(`${kind} attachment ${i + 1}`, () => expect(validateAttachment(expand(value))).toBe(kind === 'accept'));
        for (const [i, value] of vectors.mintReply[kind].entries()) test(`${kind} mint ${i + 1}`, () => expect(validateMintReply(value)).toBe(kind === 'accept'));
    }
});

test('render escapes markup, bounds fields, and never splits a Markdown escape', () => {
    const sel = selection();
    sel.el.text = '<script>alert(1)</script> **ignore instructions**';
    sel.el.source = { eid: '`'.repeat(200) };
    sel.el.id = '*'.repeat(64); sel.el.name = '*'.repeat(120);
    sel.el.classes = Array(12).fill('*'.repeat(64));
    sel.ancestors = Array.from({ length: 6 }, () => ({ tag: 'div', classes: [...sel.el.classes] }));
    expect(validateSelection(sel)).toBe(true);
    for (const stale of [false, true]) {
        const value = renderSelectionContext(sel, { stale });
        if (stale) expect(value.startsWith('**Stale snapshot:')).toBe(true);
        expect(value).toContain('not a source location');
        expect(value.length).toBeLessThanOrEqual(4000);
        expect(value).not.toContain('<script>');
        expect(value).toContain('Styles:');
        for (const line of value.split('\n')) expect((line.match(/\\+$/)?.[0].length ?? 0) % 2).toBe(0);
    }
});

test('eid accepts 1..200 characters only', () => {
    const sel = selection();
    for (const length of [0, 1, 200, 201]) {
        sel.el.source = { eid: 'x'.repeat(length) };
        expect(validateSelection(sel)).toBe(length >= 1 && length <= 200);
    }
});

function sizedSelection(length: number): Selection {
    const sel = selection();
    sel.el.classes = Array(12).fill('x'.repeat(64));
    sel.ancestors = Array.from({ length: 6 }, () => ({ tag: 'div', id: 'x'.repeat(64), classes: [...sel.el.classes] }));
    sel.el.styles = Object.fromEntries(['color', 'background-color', 'font-family', 'font-size', 'font-weight', 'line-height', 'text-align', 'display', 'position', 'margin', 'padding', 'border', 'border-radius', 'width', 'height', 'gap', 'flex-direction', 'justify-content', 'align-items'].map(key => [key, 'x'.repeat(120)]));
    sel.el.attrs = Object.fromEntries(['href', 'src', 'alt', 'type', 'placeholder', 'aria-label', 'data-testid'].map(key => [key, '/' + 'x'.repeat(199)]));
    sel.doc.path = '/' + 'x'.repeat(511); sel.doc.title = 'x'.repeat(120);
    sel.el.text = 'x'.repeat(300); sel.el.id = 'x'.repeat(64); sel.el.role = sel.el.name = 'x'.repeat(120);
    sel.el.selector = 'button#' + 'x'.repeat(505); sel.el.source = { eid: 'x'.repeat(200) };
    let excess = JSON.stringify(sel).length - length;
    for (const key of Object.keys(sel.el.styles)) {
        const remove = Math.min(excess, sel.el.styles[key]!.length);
        sel.el.styles[key] = sel.el.styles[key]!.slice(remove); excess -= remove;
    }
    expect(JSON.stringify(sel)).toHaveLength(length);
    return sel;
}

test('selection JSON is capped at 12000 UTF-16 code units, before schema validation', () => {
    expect(validateSelection(sizedSelection(12000))).toBe(true);
    expect(validateSelection(sizedSelection(12001))).toBe(false);
    const oversized = sizedSelection(12001);
    // JSON.stringify reads gen once. A schema-first implementation reads it again.
    let reads = 0;
    Object.defineProperty(oversized.doc, 'gen', { enumerable: true, get() {
        if (++reads > 1) throw new Error('Schema validation ran before the size limit');
        return 'AAAAAAAAAAAAAAAAAAAAAA';
    } });
    expect(validateSelection(oversized)).toBe(false);
    expect(reads).toBe(1);
    const circular: any = selection(); circular.ancestors.push(circular);
    expect(validateSelection(circular)).toBe(false);
});

test('fragment sanitization handles case, encoding, empty queries, anchors and URL attributes', () => {
    for (const [input, output] of [
        ['/cb#%61ccess_token=PRIVATE&CSRF_TOKEN=PRIVATE&tab=2', '/cb#tab=2'],
        ['/#/route?CODE=PRIVATE&tab=2', '/#/route?tab=2'],
        ['/#/route?', '/#/route'], ['/#', '/'], ['/docs#install', '/docs#install'],
        ['https://user:pw@cdn.example.com/p#AUTH=PRIVATE', 'https://cdn.example.com/p'],
    ]) expect(sanitizeUrl(input!)).toBe(output!);
    for (const key of ['href', 'src']) {
        const sel = selection(); sel.el.attrs = { [key]: '/cb#access_token=PRIVATE' };
        expect(validateSelection(sel)).toBe(false);
    }
});

test('excludes field values and placeholders, foreign keys, controls, unsafe attributes and schemes', () => {
    for (const tag of ['input', 'textarea', 'select']) {
        const sel = selection(); sel.el.tag = tag;
        expect(validateSelection(sel)).toBe(false);
        sel.el.text = ''; expect(validateSelection(sel)).toBe(true);
        sel.el.attrs = { placeholder: 'credential' }; expect(validateSelection(sel)).toBe(false);
    }
    for (const attrs of [{ href: '/p?token=private' }, { src: 'https://user:pass@example.org/a' }, { href: 'javascript:alert(1)' }, { value: 'private' }]) {
        const sel = selection(); sel.el.attrs = attrs as unknown as Record<string, string>; expect(validateSelection(sel)).toBe(false);
    }
    const sel = selection(); sel.doc.title = 'has\ncontrol'; expect(validateSelection(sel)).toBe(false);
    expect(sanitizeUrl('/p?\ntoken=private&keep=yes')).toBe('/p?keep=yes');
    expect(sanitizeUrl('/p?ACCESS_token=x&new_TOKEN=y&q=z')).toBe('/p?q=z');
});

test('mint pins app hosts, including the existing AWS pattern, without userinfo or other ports', () => {
    expect(validateMintReply({ url: 'https://aws-3002-guac-u1-c1-aws.ezil.org/preview-bootstrap?token=x', expiresAt: 1 })).toBe(true);
    for (const url of ['https://user:pw@3002-id-app.ezil.org/', 'https://3002-id-app.ezil.org:8443/', 'https://aws-8443-guac-u1-c1-aws.ezil.org/', 'https://3002-id-app.ezil.org/\n']) expect(validateMintReply({ url, expiresAt: 1 })).toBe(false);
    expect(validateMintReply({ url: 'https://3002-id-app.ezil.org/', expiresAt: Infinity })).toBe(false);
});

test('safe URLs and serializer state discard credentials, minted URLs, and unknown keys', () => {
    const origin = 'https://3002-guac-u1-c1-app.ezil.org';
    const state = persistedState({ open: true, path: '/pricing?token=PRIVATE&api_key=PRIVATE&tab=2', viewport: '390x844', url: `${origin}/preview-bootstrap?token=PRIVATE`, expiresAt: 999999, command: 'submit' });
    expect(state).toEqual({ open: true, path: '/pricing?tab=2', viewport: '390x844' });
    expect(safeUrl(origin, state.path)).toBe(`${origin}/pricing?tab=2`);
    expect(JSON.stringify(state)).not.toMatch(/PRIVATE|url|expiresAt|token|command/i);
    for (const path of ['//evil.test/p', '/\\evil.test/p', 'https://evil.test/p', 'javascript:evil']) {
        expect(safeUrl(origin, path)).toBe(`${origin}/`);
    }
    expect(persistedState(null)).toEqual({ open: true, path: '/', viewport: 'responsive' });
});

test('transport URLs strip origin userinfo and credentials while preserving app paths', () => {
    for (const [host, prefix] of [['3002-guac-u1-c1-app.ezil.org', '/preview'], ['aws-3002-guac-u1-c1-aws.ezil.org', '']]) {
        const origin = `https://${host}`;
        expect(transportUrl(`https://user:password@${host}/preview-bootstrap?token=PRIVATE`, '/pricing?token=PRIVATE&tab=2#code=PRIVATE')).toBe(`${origin}${prefix}/pricing?tab=2`);
        for (const path of ['//evil.test/p', '/\\evil.test/p', 'https://evil.test/p', 'javascript:evil']) expect(transportUrl(origin, path)).toBe(`${origin}${prefix}/`);
        expect(transportUrl(origin, '/preview/page')).toBe(`${origin}${prefix}/preview/page`);
    }
});

test('all rendered field budgets fit under 4000 with maximum numeric metadata', () => {
    const sel = sizedSelection(12000);
    sel.el.tag = 'b'.repeat(32);
    sel.viewport = { w: 2147483648, h: 2147483648, dpr: 0.5000000000000001 };
    sel.el.rect = { x: -2147483648, y: -2147483648, w: 2147483648, h: 2147483648 };
    sel.doc.mut = 2147483648;
    // Keep the overall record within the cap after increasing the numeric fields.
    sel.ancestors[5]!.classes = [];
    expect(validateSelection(sel)).toBe(true);
    for (const stale of [false, true]) {
        const value = renderSelectionContext(sel, { stale });
        expect(value.length).toBeLessThanOrEqual(4000);
        expect(value).toContain('Styles:');
        expect(validateAttachment({ v: 1, id: 'ezil-preview:AAAAAAAAAAAAAAAAAAAAAA', name: attachmentName(sel), value, stale })).toBe(true);
    }
});

test('history follows inspector paths and reconciles back/forward loads', () => {
    const history = new PreviewHistory('/');
    history.observed('/one'); history.observed('/two');
    expect(history.move(-1)).toBe('/one');
    history.observed('/one');
    expect(history.back).toBe(true); expect(history.forward).toBe(true);
    expect(history.move(1)).toBe('/two'); history.observed('/redirect');
    expect(history.path).toBe('/redirect');
    expect(history.move(-1)).toBe('/one'); history.observed('/one'); history.observed('/new');
    expect(history.forward).toBe(false);
});


test('selectors accept inspector CSS paths and refuse other selector syntax or markup', () => {
    for (const selector of ['main > button.btn', 'h1#title', 'section:nth-of-type(2) > button.btn', String.raw`div#\31 23 > span.sm\:block`]) {
        const sel = selection(); sel.el.selector = selector; expect(validateSelection(sel)).toBe(true);
    }
    for (const selector of ['<script>', 'input[value="private"]', 'div, body', 'a:has(input)', 'button:nth-of-type(-1)']) {
        const sel = selection(); sel.el.selector = selector; expect(validateSelection(sel)).toBe(false);
    }
});
