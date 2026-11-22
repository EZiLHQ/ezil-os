import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export type BrowserRequest = (url: string, options: RequestInit) => Promise<Response>;

const url = 'http://127.0.0.1:9223/internal/code/browser/open-url';
const supportedVersions = ['2024-11-05', '2025-03-26', '2025-06-18'];

export const browserOpenTool = {
    name: 'browser_open_url',
    description: 'Open an approved test or project preview URL in the browser on this EZiL computer. Returns the final location, title and document status.',
    inputSchema: {
        type: 'object', additionalProperties: false, required: ['url'],
        properties: {
            url: { type: 'string', maxLength: 2048, description: 'The HTTP or HTTPS test URL.' },
            timeoutMs: { type: 'integer', minimum: 1000, maximum: 30000, default: 15000 },
        },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
};

function object(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : undefined;
}

export function hasBrowserCapability(env: NodeJS.ProcessEnv): boolean {
    return env.EZIL_CODE_BROWSER_MCP === 'on' && /^[A-Za-z0-9_-]{43}$/.test(env.EZIL_CODE_BROWSER_MCP_TOKEN ?? '');
}

function input(value: unknown): { url: string; timeoutMs: number } | undefined {
    const args = object(value);
    if (!args || Object.keys(args).some(key => key !== 'url' && key !== 'timeoutMs')
        || typeof args.url !== 'string' || args.url.length > 2048 || !/^https?:\/\//i.test(args.url)
        || /[\s\\\u0000-\u001f\u007f]/u.test(args.url)) return;
    const timeoutMs = args.timeoutMs === undefined ? 15000 : args.timeoutMs;
    if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) return;
    try {
        const parsed = new URL(args.url);
        if (parsed.username || parsed.password) return;
    } catch { return; }
    return { url: args.url, timeoutMs };
}

const failures = new Set([
    'invalid_request', 'invalid_url', 'destination_denied', 'browser_unauthorized',
    'computer_unavailable', 'browser_session_stale', 'browser_unavailable', 'cdp_attach_failed',
    'navigation_timeout', 'cancelled', 'connection_lost', 'target_closed',
    'request_conflict', 'request_pending', 'browser_busy',
]);
const stages = new Set(['request', 'authorization', 'placement', 'destination', 'runtime', 'attach', 'navigation', 'cleanup']);

function receipt(value: unknown, runId: string, requestedUrl: string) {
    const reply = object(value);
    if (reply?.runId !== runId) return;
    if (reply.ok === true && typeof reply.finalUrl === 'string' && reply.finalUrl.length <= 2048
        && typeof reply.title === 'string' && reply.title.length <= 512
        && (reply.httpStatus === null || (Number.isInteger(reply.httpStatus)
            && Number(reply.httpStatus) >= 100 && Number(reply.httpStatus) <= 599))
        && typeof reply.elapsedMs === 'number' && Number.isInteger(reply.elapsedMs) && reply.elapsedMs >= 0 && reply.elapsedMs <= 40000) {
        try {
            const finalUrl = new URL(reply.finalUrl);
            if (!['http:', 'https:'].includes(finalUrl.protocol) || finalUrl.username || finalUrl.password
                || finalUrl.search || finalUrl.hash || finalUrl.origin !== new URL(requestedUrl).origin) return;
        } catch { return; }
        return { ok: true, runId, finalUrl: reply.finalUrl, title: reply.title, httpStatus: reply.httpStatus, elapsedMs: reply.elapsedMs };
    }
    if (reply.ok === false && typeof reply.error === 'string' && failures.has(reply.error)
        && typeof reply.stage === 'string' && stages.has(reply.stage) && typeof reply.retryable === 'boolean') {
        return { ok: false, runId, error: reply.error, stage: reply.stage, retryable: reply.retryable };
    }
}

async function openBrowser(args: { url: string; timeoutMs: number }, token: string, signal: AbortSignal, request: BrowserRequest) {
    const runId = randomUUID();
    const unavailable = { ok: false, runId, error: 'browser_unavailable', stage: 'runtime', retryable: false };
    try {
        const response = await request(url, {
            method: 'POST', redirect: 'error',
            headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
            body: JSON.stringify({ requestId: runId, ...args }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(args.timeoutMs + 5000)]),
        });
        if (!response.ok) return unavailable;
        return receipt(await response.json(), runId, args.url) ?? unavailable;
    } catch { return unavailable; }
}

// ── v2 verbs (contract: browser-verbs-v2.md §7; data: worker/sidecar/contract.mjs) ──────────────
// Mirrored by hand, not imported: the VSIX bundles this file alone. The test loads contract.mjs
// and fails when any of these drift from it.

const verbBase = 'http://127.0.0.1:9223/internal/code/browser/';
const verbTimeoutMs = 45000;
const maxBodyBytes = 256 * 1024; // the sidecar's own request-body limit
const maxReplyChars = 16 * 1024 * 1024;
const maxLine = 1024 * 1024; // 20 fields of 4000 units is about 480 KB when a client escapes every unit

const pressKeys = [
    'Enter', 'Tab', 'Shift+Tab', 'Escape', 'Backspace', 'Delete', 'Space', 'ArrowUp', 'ArrowDown',
    'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown',
];
const consoleLevels = ['log', 'debug', 'info', 'warning', 'error'];
const fieldValueMaxChars = 4000;
const fillFormMaxFields = 20;
const selectMaxValues = 20;
const scrollMaxDy = 5000;
const waitForMaxSeconds = 30;

interface Schema {
    type?: 'object' | 'string' | 'integer' | 'number' | 'boolean' | 'array';
    description?: string;
    enum?: readonly string[];
    pattern?: string;
    minLength?: number; maxLength?: number;
    minimum?: number; maximum?: number; exclusiveMinimum?: number;
    minItems?: number; maxItems?: number;
    items?: Schema;
    properties?: Record<string, Schema>;
    required?: readonly string[];
    additionalProperties?: false;
}

/** The first way `value` breaks `schema`, naming the constraint and never the value (it may be a password). */
function violation(schema: Schema, value: unknown, path: string): string | undefined {
    const name = path || 'arguments';
    switch (schema.type) {
        case 'object': {
            const args = object(value);
            if (!args) return `${name} must be an object`;
            const known = schema.properties ?? {};
            for (const key of Object.keys(args)) {
                if (!Object.hasOwn(known, key)) return `${name} has an unknown property ${JSON.stringify(key.slice(0, 40))}`;
            }
            for (const key of schema.required ?? []) {
                if (args[key] === undefined) return `${path ? path + '.' : ''}${key} is required`;
            }
            for (const [key, child] of Object.entries(known)) {
                if (args[key] === undefined) continue;
                const found = violation(child, args[key], `${path ? path + '.' : ''}${key}`);
                if (found) return found;
            }
            return;
        }
        case 'array': {
            if (!Array.isArray(value)) return `${name} must be an array`;
            if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) {
                return `${name} must have ${schema.minItems} to ${schema.maxItems} items`;
            }
            for (let index = 0; index < value.length; index++) {
                const found = schema.items && violation(schema.items, value[index], `${path}[${index}]`);
                if (found) return found;
            }
            return;
        }
        case 'string': {
            if (typeof value !== 'string') return `${name} must be a string`;
            if (value.length < (schema.minLength ?? 0)) return `${name} must be at least ${schema.minLength} characters`;
            if (value.length > (schema.maxLength ?? Infinity)) return `${name} must be at most ${schema.maxLength} UTF-16 code units`;
            if (schema.pattern && !new RegExp(schema.pattern).test(value)) return `${name} must match ${schema.pattern}`;
            if (schema.enum && !schema.enum.includes(value)) return `${name} must be one of: ${schema.enum.join(', ')}`;
            return;
        }
        case 'boolean': return typeof value === 'boolean' ? undefined : `${name} must be a boolean`;
        case 'integer':
        case 'number': {
            if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) {
                return `${name} must be ${schema.type === 'integer' ? 'an integer' : 'a number'}`;
            }
            if (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)
                || value <= (schema.exclusiveMinimum ?? -Infinity)) {
                return `${name} is out of range (${schema.minimum ?? schema.exclusiveMinimum ?? '-inf'} to ${schema.maximum ?? 'inf'})`;
            }
            return;
        }
    }
}

const scope = 'Acts on the user\'s Browser in this EZiL computer. Refuses the user\'s signed-in apps and the EZiL ID sign-in page.';
const ref: Schema = { type: 'string', pattern: '^e\\d+$', description: 'Element ref (e1, e2, ...) from the latest browser_snapshot.' };

export interface BrowserVerb {
    tool: { name: string; description: string; inputSchema: Schema; annotations: object };
    verb: string;
    /** The `SIDECAR_WIRE` response members this tool returns, besides `ok`. */
    response: string[];
    /** A constraint a flat JSON schema cannot state (a top-level oneOf is rejected by Claude's tool schemas). */
    rule?: (args: Record<string, unknown>) => string | undefined;
}

function verbTool(
    verb: string, description: string, response: string[], properties: Record<string, Schema>, required: string[],
    options: { readOnly?: boolean; rule?: BrowserVerb['rule'] } = {},
): BrowserVerb {
    return {
        verb, response, rule: options.rule,
        tool: {
            name: 'browser_' + verb, description: `${description} ${scope}`,
            inputSchema: {
                type: 'object', additionalProperties: false, ...(required.length ? { required } : {}), properties,
            },
            annotations: options.readOnly
                ? { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
                : { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        },
    };
}

export const browserVerbs: BrowserVerb[] = [
    verbTool('navigate', 'Navigate to an http or https URL, or about:blank. Returns the final URL and title.', ['url', 'title'],
        { url: { type: 'string', minLength: 1, maxLength: 2048, description: 'An http or https URL, or about:blank.' } }, ['url'], {
            rule: args => {
                const target = String(args.url);
                try {
                    if (target === 'about:blank' || /^https?:$/.test(new URL(target).protocol)) return;
                } catch { /* reported below */ }
                return 'url must be an http or https URL, or about:blank';
            },
        }),
    verbTool('snapshot', 'Read the page as a text snapshot. Interactive elements carry a ref (e1, e2, ...) for the other browser tools; refs go stale when the page changes.',
        ['snapshot', 'url', 'title'], {}, [], { readOnly: true }),
    verbTool('click', 'Click the element with this ref.', ['url'], { ref }, ['ref']),
    verbTool('type', 'Type text into the element with this ref, replacing its value. submit presses Enter afterwards. Password values are never returned.',
        ['url', 'redacted'], {
            ref, text: { type: 'string', maxLength: fieldValueMaxChars }, submit: { type: 'boolean', description: 'Press Enter afterwards.' },
        }, ['ref', 'text']),
    verbTool('fill_form', 'Fill 1 to 20 form fields at once. Every ref is resolved before any field is filled, so one stale ref fills nothing.',
        ['url', 'filled', 'redacted'], {
            fields: {
                type: 'array', minItems: 1, maxItems: fillFormMaxFields, items: {
                    type: 'object', additionalProperties: false, required: ['ref', 'value'],
                    properties: { ref, value: { type: 'string', maxLength: fieldValueMaxChars } },
                },
            },
        }, ['fields']),
    verbTool('select', 'Select 1 to 20 options, by label or value, in the dropdown or list box with this ref.', ['url', 'selected'], {
        ref, values: { type: 'array', minItems: 1, maxItems: selectMaxValues, items: { type: 'string', maxLength: fieldValueMaxChars } },
    }, ['ref', 'values']),
    verbTool('scroll', `Scroll the element with this ref into view, or the window by dy CSS pixels (an integer, at most ${scrollMaxDy} either way). Give exactly one of ref or dy.`,
        ['url', 'scrollY'], { ref, dy: { type: 'integer', minimum: -scrollMaxDy, maximum: scrollMaxDy } }, [], {
            rule: args => (args.ref === undefined) === (args.dy === undefined) ? 'scroll takes exactly one of ref or dy' : undefined,
        }),
    verbTool('press', 'Press one key, on the element with this ref or on the focused element.', ['url'],
        { ref, key: { type: 'string', enum: pressKeys } }, ['key']),
    verbTool('get_text', 'Read the text of the page, or of the element with this ref, as markdown.', ['markdown', 'url'], { ref }, [], { readOnly: true }),
    verbTool('screenshot', 'Take a PNG screenshot of the page or of the element with this ref. Password fields are masked.',
        ['sha256', 'byteSize', 'width', 'height'], {
            ref, fullPage: { type: 'boolean', description: 'Capture the whole page rather than the viewport.' },
        }, [], { readOnly: true }),
    verbTool('console', 'Read the console messages the current page has logged.', ['entries'],
        { level: { type: 'string', enum: consoleLevels } }, [], { readOnly: true }),
    verbTool('network', 'Read the network requests the current page has made.', ['requests'],
        { filter: { type: 'string', minLength: 1, maxLength: 2048, description: 'Keep only requests whose URL contains this text.' } }, [], { readOnly: true }),
    verbTool('wait_for', `Wait until text appears on the page, or for time seconds (more than 0, at most ${waitForMaxSeconds}). Give text, time or both.`,
        ['matched'], {
            text: { type: 'string', minLength: 1, maxLength: 2048 },
            time: { type: 'number', exclusiveMinimum: 0, maximum: waitForMaxSeconds },
        }, [], {
            readOnly: true,
            rule: args => args.text === undefined && args.time === undefined ? 'wait_for requires text or time' : undefined,
        }),
];

const verbsByName = new Map(browserVerbs.map(spec => [spec.tool.name, spec]));
export const browserTools = [browserOpenTool, ...browserVerbs.map(spec => spec.tool)];

/** The validated body for a verb, or the reason it was refused. Nothing is sent for a refusal. */
function verbBody(spec: BrowserVerb, value: unknown): { body: string } | { refusal: string } {
    const args = value === undefined ? {} : value;
    const refusal = violation(spec.tool.inputSchema, args, '') ?? spec.rule?.(args as Record<string, unknown>);
    if (refusal) return { refusal };
    const body = JSON.stringify(args);
    return Buffer.byteLength(body) > maxBodyBytes ? { refusal: `the request is over ${maxBodyBytes} bytes` } : { body };
}

interface ToolResult { content: object[]; structuredContent: Record<string, unknown>; isError: boolean }

/** The token must never leave in a result, whatever the sidecar or a page put there. */
function scrub<T>(value: T, token: string): T {
    const text = JSON.stringify(value);
    return text.includes(token) ? JSON.parse(text.split(token).join('[redacted]')) as T : value;
}

function toolFailure(verb: string, error: string, message: string, token: string): ToolResult {
    const structuredContent = scrub({ ok: false, error, message }, token);
    return {
        content: [{ type: 'text', text: `browser_${verb} failed (${structuredContent.error}): ${structuredContent.message}` }],
        structuredContent, isError: true,
    };
}

const sidecarFailures: Record<string, string> = {
    origin_read_only: 'This page belongs to the user\'s signed-in app or the sign-in provider, and Code chats cannot act on it.',
    stale_ref: 'That ref is stale: the page changed, or the ref came from another page. Call browser_snapshot again and use a fresh ref.',
    bad_ref: 'No element on this page has that ref, or it is the wrong kind of element for this tool. Call browser_snapshot again.',
    chrome_unreachable: 'The Browser is not reachable right now.',
    navigation_failed: 'The page did not load.',
    timeout: 'The Browser did not finish in time.',
    bad_request: 'The Browser refused the request.',
};
const detailed = new Set(['chrome_unreachable', 'navigation_failed', 'timeout', 'bad_request']);

async function callVerb(
    spec: BrowserVerb, body: string, token: string, signal: AbortSignal, request: BrowserRequest,
): Promise<ToolResult> {
    const unavailable = (message: string) => toolFailure(spec.verb, 'browser_unavailable', message, token);
    try {
        const response = await request(verbBase + spec.verb, {
            method: 'POST', redirect: 'error',
            headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
            body,
            signal: AbortSignal.any([signal, AbortSignal.timeout(verbTimeoutMs)]),
        });
        if (response.status === 401) return unavailable('The Browser tool is not available in this computer.');
        const text = await response.text();
        let reply: Record<string, unknown> | undefined;
        try { reply = text.length <= maxReplyChars ? object(JSON.parse(text)) : undefined; } catch { /* unreadable */ }
        if (reply?.ok === false && typeof reply.error === 'string' && Object.hasOwn(sidecarFailures, reply.error)) {
            const detail = typeof reply.detail === 'string'
                ? reply.detail.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 300) : '';
            return toolFailure(spec.verb, reply.error,
                detailed.has(reply.error) && detail ? detail : sidecarFailures[reply.error]!, token);
        }
        if (!response.ok) return unavailable(`The Browser tool is unavailable (HTTP ${response.status}).`);
        if (reply?.ok !== true) return unavailable('The Browser tool sent a reply this server cannot read.');
        const members: Record<string, unknown> = { ok: true };
        for (const key of spec.response) if (reply[key] !== undefined) members[key] = reply[key];
        const content: object[] = [];
        if (spec.verb === 'screenshot') {
            const png = reply.pngBase64;
            if (typeof png !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(png)) {
                return unavailable('The Browser tool sent a screenshot this server cannot read.');
            }
            content.push({ type: 'image', data: png, mimeType: 'image/png' });
        }
        const structuredContent = scrub(members, token);
        return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }, ...content], structuredContent, isError: false };
    } catch { return unavailable('The Browser tool did not answer.'); }
}

export function serveBrowserMcp(
    stdin: Readable, stdout: Writable, token: string, request: BrowserRequest = fetch,
): void {
    const pending = new Map<string | number, AbortController>();
    const lines = createInterface({ input: stdin, crlfDelay: Infinity });
    let initialized = false;
    function result(id: string | number, value: unknown): void {
        stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: value }) + '\n');
    }
    function error(id: string | number | null, code: number, message: string): void {
        stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
    }
    lines.on('close', () => {
        for (const controller of pending.values()) controller.abort();
    });
    lines.on('line', line => {
        if (line.length > maxLine) return error(null, -32600, 'Invalid request');
        let call: Record<string, unknown> | undefined;
        try { call = object(JSON.parse(line)); } catch { return error(null, -32700, 'Parse error'); }
        if (call?.jsonrpc !== '2.0' || typeof call.method !== 'string') return error(null, -32600, 'Invalid request');
        const { id, method } = call;
        const params = object(call.params);
        if (id === undefined) {
            if (method === 'notifications/cancelled' && params) {
                const requestId = params.requestId;
                if (typeof requestId === 'number' || typeof requestId === 'string') pending.get(requestId)?.abort();
            }
            return;
        }
        if (typeof id !== 'number' && typeof id !== 'string') return error(null, -32600, 'Invalid request ID');
        if (method === 'initialize') {
            if (initialized || typeof params?.protocolVersion !== 'string') return error(id, -32602, 'Invalid initialization');
            const protocolVersion = supportedVersions.includes(params.protocolVersion) ? params.protocolVersion : '2025-06-18';
            initialized = true;
            return result(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'ezil-browser', version: '1.0.0' } });
        }
        if (method === 'ping') return result(id, {});
        if (!initialized) return error(id, -32600, 'Initialize first');
        if (method === 'tools/list') return result(id, { tools: browserTools });
        if (method !== 'tools/call') return error(id, -32601, 'Method not found');
        const spec = typeof params?.name === 'string' ? verbsByName.get(params.name) : undefined;
        const args = params?.name === browserOpenTool.name ? input(params.arguments) : undefined;
        const verb = spec ? verbBody(spec, params?.arguments) : undefined;
        if (!spec && !args) return error(id, -32602, 'Invalid browser tool arguments');
        // A refused input is a tool error the model can read and correct; nothing is sent.
        if (spec && verb && 'refusal' in verb) {
            return result(id, toolFailure(spec.verb, 'invalid_arguments', verb.refusal, token));
        }
        if (pending.has(id) || pending.size >= 16) return error(id, -32600, 'Request unavailable');
        const controller = new AbortController();
        pending.set(id, controller);
        const work: Promise<unknown> = spec && verb && 'body' in verb
            ? callVerb(spec, verb.body, token, controller.signal, request)
            : openBrowser(args!, token, controller.signal, request).then(value => ({
                content: [{ type: 'text', text: JSON.stringify(value) }],
                structuredContent: value,
                isError: !value.ok,
            }));
        void work.then(value => {
            if (controller.signal.aborted) return;
            result(id, value);
        }).finally(() => pending.delete(id));
    });
}
