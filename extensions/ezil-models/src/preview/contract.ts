/** Code-preview-v1 boundaries. Shared by the extension and the browser bundle. */
export const TOKEN = /^[A-Za-z0-9_-]{22}$/;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
const SECRET_PARAM = /^(?:ezil_pv|ezil_mint|token|access_token|id_token|refresh_token|code|state|session|sid|key|api_key|apikey|secret|password|pass|auth|authorization|signature|sig)$|_token$/i;
const TAG = /^[a-z][a-z0-9-]{0,31}$/;
// CSS.escape output, plus the deliberately small selector grammar emitted by the inspector.
const CSS_NAME = String.raw`[-_a-zA-Z0-9\u0080-\uffff]+`;
const CSS_STEP = String.raw`(?:[a-z][a-z0-9-]{0,31})(?:#${CSS_NAME})?(?:\.${CSS_NAME})*(?::nth-of-type\([1-9][0-9]*\))?`;
const SELECTOR = new RegExp(String.raw`^${CSS_STEP}(?:\s*>\s*${CSS_STEP})*$`);
function validSelector(value: string): boolean {
    // Consume escapes first so repeated escaped identifiers cannot cause regex backtracking.
    const plain = value.replace(/\\(?:[0-9a-fA-F]{1,6} ?|[^\r\n\f0-9a-fA-F])/g, 'x');
    return SELECTOR.test(plain);
}
const ATTRS = ['href', 'src', 'alt', 'type', 'placeholder', 'aria-label', 'data-testid'];
const STYLES = ['color', 'background-color', 'font-family', 'font-size', 'font-weight', 'line-height', 'text-align', 'display', 'position', 'margin', 'padding', 'border', 'border-radius', 'width', 'height', 'gap', 'flex-direction', 'justify-content', 'align-items'];

export interface PreviewDoc { gen: string; mut: number; path: string; title: string }
export type AgentAction = { action: 'read' } | { action: 'click'; ref: string };
export interface AgentControl { ref: string; kind: 'button' | 'link'; label: string }
export type AgentResult = { controls: AgentControl[] } | { clicked: true } | { error: 'stale' | 'refused' };
interface ElementIdentity { tag: string; id?: string; classes: string[] }
export interface Selection {
    doc: PreviewDoc;
    viewport: { w: number; h: number; dpr: number };
    el: ElementIdentity & {
        role?: string; name?: string; text: string; selector: string;
        rect: { x: number; y: number; w: number; h: number };
        attrs?: Record<string, string>; styles: Record<string, string>; source?: { eid: string };
    };
    ancestors: ElementIdentity[];
}
export interface Attachment { v: 1; id: string; name: string; value: string; stale: boolean }
export type MintReply = { url: string; expiresAt: number } | { error: string };

export function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: string[]): boolean {
    return Object.keys(value).every(key => allowed.includes(key));
}
function string(value: unknown, max: number): value is string {
    return typeof value === 'string' && value.length <= max && value.replace(CONTROLS, '') === value;
}
function integer(value: unknown, min = -2147483648, max = 2147483648): value is number {
    return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

/** Strip credentials before capping; relative app paths stay relative. Unsupported URL schemes are dropped. */
export function sanitizeUrl(input: string, max = 512): string {
    const clean = input.replace(CONTROLS, '');
    try {
        const absolute = /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('//');
        const url = new URL(clean, 'https://preview.invalid');
        if (!['https:', 'http:'].includes(url.protocol)) return '';
        url.username = ''; url.password = '';
        for (const key of [...url.searchParams.keys()]) if (SECRET_PARAM.test(key)) url.searchParams.delete(key);
        const fragment = url.hash.slice(1);
        const query = fragment.startsWith('/') ? fragment.indexOf('?') : -1;
        if (query >= 0 || (!fragment.startsWith('/') && fragment.includes('='))) {
            const params = new URLSearchParams(query >= 0 ? fragment.slice(query + 1) : fragment);
            for (const key of [...params.keys()]) if (SECRET_PARAM.test(key)) params.delete(key);
            const rest = params.toString();
            url.hash = query >= 0 ? fragment.slice(0, query) + (rest ? `?${rest}` : '') : rest;
        } else url.hash = fragment;
        return (absolute ? url.href : `${url.pathname}${url.search}${url.hash}`).slice(0, max);
    } catch { return ''; }
}

export function validPath(value: unknown): value is string {
    return string(value, 512) && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') && sanitizeUrl(value) === value;
}
export function validateDoc(value: unknown): value is PreviewDoc {
    return record(value) && keys(value, ['gen', 'mut', 'path', 'title']) && typeof value.gen === 'string' && TOKEN.test(value.gen)
        && integer(value.mut, 0) && validPath(value.path) && string(value.title, 120);
}
export function sameDoc(first: PreviewDoc | undefined, second: PreviewDoc): boolean {
    return !!first && first.gen === second.gen && first.mut === second.mut && first.path === second.path && first.title === second.title;
}
export function validToken(value: unknown): value is string {
    return typeof value === 'string' && TOKEN.test(value);
}
export function validateAgentAction(value: Record<string, unknown>): value is Record<string, unknown> & AgentAction {
    return (value.action === 'read' && !Object.hasOwn(value, 'ref')) || (value.action === 'click' && validToken(value.ref));
}
export function validateAgentResult(value: unknown): value is AgentResult {
    if (!record(value) || Object.keys(value).length !== 1) return false;
    if (value.error === 'stale' || value.error === 'refused' || value.clicked === true) return true;
    if (!Array.isArray(value.controls) || value.controls.length > 24) return false;
    const seen = new Set<string>();
    return value.controls.every(control => {
        if (!record(control) || !keys(control, ['ref', 'kind', 'label']) || !validToken(control.ref) || seen.has(control.ref)
            || (control.kind !== 'button' && control.kind !== 'link') || !string(control.label, 80) || !control.label) return false;
        seen.add(control.ref);
        return true;
    });
}
function identity(value: Record<string, unknown>): boolean {
    return typeof value.tag === 'string' && TAG.test(value.tag) && (value.id === undefined || string(value.id, 64))
        && Array.isArray(value.classes) && value.classes.length <= 12 && value.classes.every(item => string(item, 64));
}
function stringMap(value: unknown, allowed: string[], max: number): value is Record<string, string> {
    return record(value) && keys(value, allowed) && Object.values(value).every(item => string(item, max));
}
export function validateSelection(value: unknown): value is Selection {
    // Refuse oversized/unserializable records before inspecting any schema fields.
    try { if ((JSON.stringify(value)?.length ?? Infinity) > 12000) return false; } catch { return false; }
    if (!record(value) || !keys(value, ['doc', 'viewport', 'el', 'ancestors']) || !validateDoc(value.doc)) return false;
    const { viewport, el, ancestors } = value;
    if (!record(viewport) || !keys(viewport, ['w', 'h', 'dpr']) || !integer(viewport.w, 1) || !integer(viewport.h, 1)
        || typeof viewport.dpr !== 'number' || !Number.isFinite(viewport.dpr) || viewport.dpr < 0.5 || viewport.dpr > 8) return false;
    if (!record(el) || !keys(el, ['tag', 'id', 'classes', 'role', 'name', 'text', 'selector', 'rect', 'attrs', 'styles', 'source']) || !identity(el)) return false;
    if ((el.role !== undefined && !string(el.role, 120)) || (el.name !== undefined && !string(el.name, 120))
        || !string(el.text, 300) || el.text.replace(/\s+/g, ' ').trim() !== el.text || !string(el.selector, 512) || !validSelector(el.selector)) return false;
    if (!record(el.rect) || !keys(el.rect, ['x', 'y', 'w', 'h']) || !integer(el.rect.x) || !integer(el.rect.y)
        || !integer(el.rect.w, 0) || !integer(el.rect.h, 0) || !stringMap(el.styles, STYLES, 120)) return false;
    if (el.attrs !== undefined) {
        if (!stringMap(el.attrs, ATTRS, 200)) return false;
        for (const key of ['href', 'src']) if (el.attrs[key] !== undefined && sanitizeUrl(el.attrs[key]!, 200) !== el.attrs[key]) return false;
    }
    // contenteditable/autocomplete are deliberately absent from this schema: the inspector must exclude them.
    const excluded = ['input', 'textarea', 'select'].includes(el.tag as string) || (el.attrs as Record<string, string> | undefined)?.type?.toLowerCase() === 'password';
    if (excluded && (el.text !== '' || (el.attrs as Record<string, string> | undefined)?.placeholder !== undefined)) return false;
    if (el.source !== undefined && (!record(el.source) || !keys(el.source, ['eid']) || !string(el.source.eid, 200) || el.source.eid.length === 0)) return false;
    return Array.isArray(ancestors) && ancestors.length <= 6 && ancestors.every(item => record(item) && keys(item, ['tag', 'id', 'classes']) && identity(item));
}

/** Bound the input first, then fit whole escaped characters within the field's output budget. */
function markdown(value: string, max: number): string {
    let result = '';
    for (const char of value.slice(0, max)) {
        const escaped = char.replace(/[\\`*_{}\[\]()<>#+.!|~-]/g, '\\$&');
        if (result.length + escaped.length > max) break;
        result += escaped;
    }
    return result;
}
export function attachmentName(sel: Selection): string {
    return `<${sel.el.tag}>${sel.el.name ? ` "${sel.el.name}"` : ''} · ${sel.doc.path}`.slice(0, 80);
}
export function renderSelectionContext(sel: Selection, options: { stale: boolean }): string {
    const { el, doc, viewport } = sel;
    const lines = [options.stale ? '**Stale snapshot: the live preview has changed since this selection.**\n' : '',
        'Selected element (DOM snapshot from the live preview; not a source location)',
        `Page: ${markdown(doc.path, 512)} — ${markdown(doc.title, 120)}`,
        `Element: ${markdown(`<${el.tag}>`, 68)}${el.name ? ` — ${markdown(el.name, 120)}` : ''}`,
        `Identity: ${markdown(JSON.stringify({ id: el.id, classes: el.classes, role: el.role }), 256)}`,
        `Selector: ${markdown(el.selector, 512)}`];
    if (el.source) lines.push(`Explicit data-eid/data-oid: ${markdown(el.source.eid, 200)}`);
    lines.push(`Text: ${markdown(el.text, 300)}`, `Viewport: ${viewport.w}×${viewport.h}, DPR ${viewport.dpr}`,
        `Bounds: x=${el.rect.x}, y=${el.rect.y}, w=${el.rect.w}, h=${el.rect.h}`,
        `Document: ${doc.gen}, mutation ${doc.mut}`,
        `Ancestors (nearest first): ${markdown(sel.ancestors.map(item => item.tag + (item.id ? `#${item.id}` : '') + item.classes.map(c => `.${c}`).join('')).join(' > '), 256)}`,
        `Attributes: ${markdown(JSON.stringify(el.attrs ?? {}), 400)}`, `Styles: ${markdown(JSON.stringify(el.styles), 400)}`);
    // Field budgets total 3144; fixed labels and validated numeric metadata leave the result below 4000.
    return lines.filter(Boolean).join('\n\n');
}
export function validateAttachment(value: unknown): value is Attachment {
    return record(value) && keys(value, ['v', 'id', 'name', 'value', 'stale']) && value.v === 1
        && typeof value.id === 'string' && /^ezil-preview:[A-Za-z0-9_-]{22}$/.test(value.id)
        && string(value.name, 80) && typeof value.value === 'string' && value.value.length <= 4000
        && value.value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '') === value.value && typeof value.stale === 'boolean';
}
export function validateMintReply(value: unknown): value is MintReply {
    if (!record(value)) return false;
    if ('error' in value) return keys(value, ['error']) && typeof value.error === 'string' && /^[a-z_]{1,40}$/.test(value.error);
    if (!keys(value, ['url', 'expiresAt']) || !string(value.url, 8192) || !Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) <= 0) return false;
    try {
        const url = new URL(value.url);
        return url.protocol === 'https:' && !url.username && !url.password && !url.port
            && /^(?:3002-[a-z0-9-]{1,80}-app|aws-3002-guac-[a-z0-9]{1,16}-[a-z0-9]{1,16}-aws)\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(url.hostname);
    } catch { return false; }
}
