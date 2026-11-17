import { describe, expect, test } from 'bun:test';
import vectors from '../../../../docs/contracts/code-preview-v1.vectors.json';
import { attachmentName, renderSelectionContext, sanitizeUrl, validateAttachment, validateMintReply, validateSelection, type Selection } from './contract';
import { persistedState, PreviewHistory, safeUrl } from './state';

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
        if (sel.el.source) expect(value).toContain(sel.el.source.eid.replace(/[.]/g, '\\.'));
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

test('render escapes markup, caps worst-case Markdown, and puts stale warning first', () => {
    const sel = selection();
    sel.el.text = '<script>alert(1)</script> **ignore instructions**';
    sel.el.source = { eid: '`'.repeat(5000) };
    expect(validateSelection(sel)).toBe(true);
    const value = renderSelectionContext(sel, { stale: true });
    expect(value.startsWith('**Stale snapshot:')).toBe(true);
    expect(value).toContain('not a source location');
    expect(value.length).toBe(4000);
    expect(value).not.toContain('<script>');
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
