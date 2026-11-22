import { describe, expect, test } from 'bun:test';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { browserVerbs, hasBrowserCapability, serveBrowserMcp, type BrowserRequest } from '../src/browser-mcp-stdio';

const cap = 'a'.repeat(43);
// Mixed characters, so that no base64 run or ordinary text can contain it by accident.
const secret = 'Tq9-Zk_3xLm0Wv7Hc2PdR8sYb4NfJg6AeUo1Xi5CtVw';
const toolNames = [
    'browser_open_url', 'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_fill_form',
    'browser_select', 'browser_scroll', 'browser_press', 'browser_get_text', 'browser_screenshot', 'browser_console',
    'browser_network', 'browser_wait_for',
];

function session(request: BrowserRequest, token = cap) {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines = createInterface({ input: output });
    const responses = lines[Symbol.asyncIterator]();
    const seen: string[] = [];
    serveBrowserMcp(input, output, token, request);
    const send = (message: object) => input.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
    return {
        send, seen,
        receive: async () => {
            const line = (await responses.next()).value as string;
            seen.push(line);
            return JSON.parse(line);
        },
        close: () => { input.end(); lines.close(); output.end(); },
    };
}

async function initialize(mcp: ReturnType<typeof session>) {
    mcp.send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    expect((await mcp.receive()).result).toMatchObject({
        protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'ezil-browser' },
    });
    mcp.send({ method: 'notifications/initialized' });
}

function open(mcp: ReturnType<typeof session>, args: object, id = 3) {
    mcp.send({ id, method: 'tools/call', params: { name: 'browser_open_url', arguments: args } });
}

describe('Code Browser MCP', () => {
    test('requires the trusted launch gate and capability', () => {
        expect(hasBrowserCapability({})).toBe(false);
        expect(hasBrowserCapability({ EZIL_CODE_BROWSER_MCP_TOKEN: cap })).toBe(false);
        expect(hasBrowserCapability({ EZIL_CODE_BROWSER_MCP: 'on', EZIL_CODE_BROWSER_MCP_TOKEN: cap + '\n' })).toBe(false);
        expect(hasBrowserCapability({ EZIL_CODE_BROWSER_MCP: 'on', EZIL_CODE_BROWSER_MCP_TOKEN: cap })).toBe(true);
    });

    test('lists a URL-only tool and calls the fixed localhost operation with the boot token', async () => {
        let requestId: string | undefined;
        const mcp = session((async (url, init) => {
            expect(url).toBe('http://127.0.0.1:9223/internal/code/browser/open-url');
            expect(init?.redirect).toBe('error');
            expect(init?.method).toBe('POST');
            expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + cap);
            expect(new Headers(init?.headers).has('origin')).toBe(false);
            const body = JSON.parse(String(init?.body));
            requestId = body.requestId;
            expect(Object.keys(body).sort()).toEqual(['requestId', 'timeoutMs', 'url']);
            expect(body.url).toBe('http://127.0.0.1:3032/fixture');
            expect(body.timeoutMs).toBe(15000);
            return Response.json({
                ok: true, runId: requestId, finalUrl: body.url, title: 'Project Fixture', httpStatus: 404, elapsedMs: 4,
                debug: cap,
            });
        }));
        try {
            await initialize(mcp);
            mcp.send({ id: 2, method: 'tools/list' });
            const list = await mcp.receive();
            expect(list.result.tools.map((tool: { name: string }) => tool.name)).toEqual(toolNames);
            expect(Object.keys(list.result.tools[0].inputSchema.properties).sort()).toEqual(['timeoutMs', 'url']);
            expect(list.result.tools[0].inputSchema.required).toEqual(['url']);
            open(mcp, { url: 'http://127.0.0.1:3032/fixture' });
            const { result } = await mcp.receive();
            expect(requestId).toMatch(/^[a-f0-9-]{36}$/);
            expect(result.isError).toBe(false);
            expect(result.structuredContent).toEqual({
                ok: true, runId: requestId, finalUrl: 'http://127.0.0.1:3032/fixture',
                title: 'Project Fixture', httpStatus: 404, elapsedMs: 4,
            });
            expect(JSON.stringify(result)).not.toContain(cap);
        } finally { mcp.close(); }
    });

    test('refuses a computer selector, an invalid scheme and out-of-range timeout before dispatch', async () => {
        let calls = 0;
        const mcp = session((async () => { calls++; return Response.error(); }));
        try {
            await initialize(mcp);
            for (const args of [
                { url: 'https://example.test/', computerId: 'other-computer' },
                { url: 'file:///etc/hosts' },
                { url: 'https://user:pass@example.test' },
                { url: 'https://example.test/', timeoutMs: 30001 },
            ]) {
                open(mcp, args);
                expect((await mcp.receive()).error.code).toBe(-32602);
            }
            expect(calls).toBe(0);
        } finally { mcp.close(); }
    });

    test('preserves a scoped failure receipt and withholds unexpected data on transport failure', async () => {
        let calls = 0;
        const mcp = session((async (_url, init) => {
            if (++calls === 2) return Response.json({ message: cap }, { status: 401 });
            return Response.json({
                ok: false, runId: JSON.parse(String(init?.body)).requestId,
                error: 'destination_denied', stage: 'destination', retryable: false,
            });
        }));
        try {
            await initialize(mcp);
            open(mcp, { url: 'https://example.test/' });
            const failure = (await mcp.receive()).result;
            expect(failure.isError).toBe(true);
            expect(failure.structuredContent).toMatchObject({ error: 'destination_denied', stage: 'destination' });
            open(mcp, { url: 'https://example.test/' }, 4);
            const transport = (await mcp.receive()).result;
            expect(transport.structuredContent).toMatchObject({ error: 'browser_unavailable', retryable: false });
            expect(JSON.stringify(transport)).not.toContain(cap);
        } finally { mcp.close(); }
    });

    test('withholds a cross-origin receipt and preserves a canonical busy failure', async () => {
        let calls = 0;
        const mcp = session(async (_url, init) => {
            const runId = JSON.parse(String(init.body)).requestId;
            if (++calls === 1) return Response.json({
                ok: true, runId, finalUrl: 'https://other.test/fixture', title: 'Other',
                httpStatus: 200, elapsedMs: 12,
            });
            return Response.json({ ok: false, runId, error: 'browser_busy', stage: 'runtime', retryable: true });
        });
        try {
            await initialize(mcp);
            open(mcp, { url: 'https://example.test/' });
            const denied = (await mcp.receive()).result;
            expect(denied.structuredContent.error).toBe('browser_unavailable');
            expect(JSON.stringify(denied)).not.toContain('other.test');
            open(mcp, { url: 'https://example.test/' }, 4);
            expect((await mcp.receive()).result.structuredContent)
                .toMatchObject({ error: 'browser_busy', stage: 'runtime', retryable: true });
        } finally { mcp.close(); }
    });

    test('cancels the local request when the MCP client cancels and keeps the connection usable', async () => {
        const aborted = Promise.withResolvers<void>();
        const mcp = session((async (_url, init) => new Promise<Response>((resolve) => {
            init?.signal?.addEventListener('abort', () => { aborted.resolve(); resolve(Response.error()); }, { once: true });
        })));
        try {
            await initialize(mcp);
            open(mcp, { url: 'https://example.test/' });
            mcp.send({ method: 'notifications/cancelled', params: { requestId: 3 } });
            await aborted.promise;
            mcp.send({ id: 4, method: 'ping' });
            expect(await mcp.receive()).toEqual({ jsonrpc: '2.0', id: 4, result: {} });
        } finally { mcp.close(); }
    });
});

// ── v2 verbs ────────────────────────────────────────────────────────────────────────────────────

// The data half of the contract. A variable specifier keeps tsc from wanting types for a .mjs file.
const contract = await import(new URL('../../../worker/sidecar/contract.mjs', import.meta.url).href);

const page = 'http://127.0.0.1:3032/';
const png = 'iVBORw0KGgo=';
const verbs: string[] = contract.CODE_BROWSER_VERBS;

/** A valid call for every verb, and the sidecar's answer for it. */
const good: Record<string, object> = {
    navigate: { url: page }, snapshot: {}, click: { ref: 'e12' }, type: { ref: 'e3', text: 'hello', submit: true },
    fill_form: { fields: [{ ref: 'e1', value: 'a' }, { ref: 'e2', value: '' }] }, select: { ref: 'e4', values: ['b', 'c'] },
    scroll: { dy: -300 }, press: { key: 'Shift+Tab', ref: 'e5' }, get_text: { ref: 'e6' }, screenshot: { fullPage: true },
    console: { level: 'warning' }, network: { filter: '/api' }, wait_for: { text: 'Done', time: 5 },
};
const replies: Record<string, object> = {
    navigate: { ok: true, url: page, title: 'Fixture' },
    snapshot: { ok: true, snapshot: '- button "Go" [ref=e1]', url: page, title: 'Fixture' },
    click: { ok: true, url: page }, type: { ok: true, url: page, redacted: false },
    fill_form: { ok: true, url: page, filled: 2, redacted: 1 }, select: { ok: true, url: page, selected: ['b', 'c'] },
    scroll: { ok: true, url: page, scrollY: 120 }, press: { ok: true, url: page },
    get_text: { ok: true, markdown: '# Hi', url: page },
    screenshot: { ok: true, pngBase64: png, sha256: '0'.repeat(64), byteSize: 8, width: 2, height: 2 },
    console: { ok: true, entries: [{ level: 'error', text: 'boom' }] },
    network: { ok: true, requests: [{ url: page + 'a', status: 200 }] }, wait_for: { ok: true, matched: true },
};

function recorder(reply: (verb: string, init: RequestInit) => Response | Promise<Response>) {
    const calls: { url: string; init: RequestInit }[] = [];
    const request: BrowserRequest = async (url, init) => { calls.push({ url, init }); return reply(url.split('/').pop()!, init); };
    return { calls, request };
}

let nextId = 10;
async function call(mcp: ReturnType<typeof session>, name: string, args?: object) {
    mcp.send({ id: ++nextId, method: 'tools/call', params: { name, ...(args === undefined ? {} : { arguments: args }) } });
    return (await mcp.receive()).result;
}

describe('Code Browser MCP v2 tools', () => {
    test('lists exactly the fourteen tools, in order, and each schema mirrors its sidecar request', async () => {
        const mcp = session(recorder(() => Response.error()).request);
        try {
            await initialize(mcp);
            mcp.send({ id: 2, method: 'tools/list' });
            const tools = (await mcp.receive()).result.tools;
            expect(tools.map((tool: { name: string }) => tool.name)).toEqual(toolNames);
            expect(toolNames.slice(1)).toEqual(verbs.map(verb => 'browser_' + verb));
            expect(browserVerbs.map(spec => spec.verb)).toEqual(verbs);
            for (const verb of verbs) {
                const tool = tools.find((candidate: { name: string }) => candidate.name === 'browser_' + verb);
                const wire = contract.SIDECAR_WIRE['POST /' + verb];
                const schema = tool.inputSchema;
                expect(schema.type).toBe('object');
                expect(schema.additionalProperties).toBe(false);
                expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(wire.request).sort());
                expect([...(schema.required ?? [])].sort())
                    .toEqual(Object.keys(wire.request).filter(key => wire.request[key]).sort());
                for (const combinator of ['oneOf', 'anyOf', 'allOf', 'not']) expect(schema[combinator]).toBeUndefined();
                const spec = browserVerbs.find(candidate => candidate.verb === verb)!;
                const answered = wire.response.filter((key: string) => key !== 'ok' && key !== 'pngBase64');
                expect([...spec.response].sort()).toEqual([...answered].sort());
            }
            const by = (verb: string) => tools.find((tool: { name: string }) => tool.name === 'browser_' + verb).inputSchema;
            expect(by('fill_form').properties.fields).toMatchObject({ minItems: 1, maxItems: contract.FILL_FORM_MAX_FIELDS });
            expect(by('fill_form').properties.fields.items).toMatchObject({ additionalProperties: false, required: ['ref', 'value'] });
            expect(by('fill_form').properties.fields.items.properties.value.maxLength).toBe(contract.FIELD_VALUE_MAX_CHARS);
            expect(by('select').properties.values).toMatchObject({ minItems: 1, maxItems: contract.SELECT_MAX_VALUES });
            expect(by('scroll').properties.dy).toMatchObject({
                type: 'integer', minimum: -contract.SCROLL_MAX_DY, maximum: contract.SCROLL_MAX_DY,
            });
            expect(by('press').properties.key.enum).toEqual(contract.PRESS_KEYS);
            for (const verb of ['click', 'type', 'select', 'press', 'scroll', 'get_text', 'screenshot']) {
                expect(by(verb).properties.ref.pattern).toBe('^e\\d+$');
            }
        } finally { mcp.close(); }
    });

    test('describes the tools as the user\'s Browser with a refusal policy, never as preview-confined', async () => {
        const mcp = session(recorder(() => Response.error()).request);
        try {
            await initialize(mcp);
            mcp.send({ id: 2, method: 'tools/list' });
            const tools = (await mcp.receive()).result.tools.slice(1);
            expect(tools).toHaveLength(13);
            for (const tool of tools) {
                expect(tool.description).toContain('the user\'s Browser in this EZiL computer');
                expect(tool.description).toContain('signed-in apps');
                expect(tool.description).toContain('EZiL ID sign-in page');
                expect(tool.description).not.toMatch(/preview|confine|approved|only .*origin/i);
            }
        } finally { mcp.close(); }
    });

    test('calls each verb route with the bearer, no Origin and exactly the validated body', async () => {
        const { calls, request } = recorder(verb => Response.json(replies[verb]));
        const mcp = session(request);
        try {
            await initialize(mcp);
            for (const verb of verbs) {
                const before = calls.length;
                const result = await call(mcp, 'browser_' + verb, good[verb]);
                expect(result.isError).toBe(false);
                expect(calls).toHaveLength(before + 1);
                const { url, init } = calls.at(-1)!;
                expect(url).toBe('http://127.0.0.1:9223/internal/code/browser/' + verb);
                expect(init.method).toBe('POST');
                expect(init.redirect).toBe('error');
                const headers = new Headers(init.headers);
                expect(headers.get('authorization')).toBe('Bearer ' + cap);
                expect(headers.get('content-type')).toBe('application/json');
                expect(headers.has('origin')).toBe(false);
                expect(init.body).toBe(JSON.stringify(good[verb]));
                if (verb !== 'screenshot') expect(result.structuredContent).toEqual(replies[verb]);
                expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
            }
            expect(calls).toHaveLength(13);
        } finally { mcp.close(); }
    });

    test('a snapshot with no arguments member sends an empty body', async () => {
        const { calls, request } = recorder(verb => Response.json(replies[verb]));
        const mcp = session(request);
        try {
            await initialize(mcp);
            expect((await call(mcp, 'browser_snapshot')).isError).toBe(false);
            expect(calls[0]!.init.body).toBe('{}');
        } finally { mcp.close(); }
    });

    const refused: [string, object, string][] = [
        ['navigate', {}, 'url is required'],
        ['navigate', { url: 'javascript:alert(1)' }, 'url must be an http or https URL, or about:blank'],
        ['navigate', { url: 'not a url' }, 'url must be an http or https URL'],
        ['snapshot', { full: true }, 'unknown property "full"'],
        ['click', { ref: 'e1x' }, 'ref must match ^e\\d+$'],
        ['click', { ref: 'E1' }, 'ref must match ^e\\d+$'],
        ['click', { ref: 'e1\n' }, 'ref must match ^e\\d+$'],
        ['type', { ref: 'e1' }, 'text is required'],
        ['type', { ref: 'e1', text: 'x'.repeat(4001) }, 'text must be at most 4000'],
        ['fill_form', { fields: [] }, 'fields must have 1 to 20 items'],
        ['fill_form', { fields: Array.from({ length: 21 }, () => ({ ref: 'e1', value: 'x' })) }, 'fields must have 1 to 20 items'],
        ['fill_form', { fields: [{ ref: 'e1', value: 'x'.repeat(4001) }] }, 'fields[0].value must be at most 4000'],
        ['fill_form', { fields: [{ ref: 'e1', value: 'x' }, { ref: 'e2' }] }, 'fields[1].value is required'],
        ['fill_form', { fields: [{ ref: 'e1', value: 'x', extra: 1 }] }, 'unknown property "extra"'],
        ['select', { ref: 'e1', values: [] }, 'values must have 1 to 20 items'],
        ['select', { ref: 'e1', values: Array.from({ length: 21 }, () => 'v') }, 'values must have 1 to 20 items'],
        ['select', { ref: 'e1', values: [1] }, 'values[0] must be a string'],
        ['scroll', {}, 'scroll takes exactly one of ref or dy'],
        ['scroll', { ref: 'e1', dy: 3 }, 'scroll takes exactly one of ref or dy'],
        ['scroll', { dy: 5001 }, 'dy is out of range'],
        ['scroll', { dy: -5001 }, 'dy is out of range'],
        ['scroll', { dy: 1.5 }, 'dy must be an integer'],
        ['press', {}, 'key is required'],
        ['press', { key: 'a' }, 'key must be one of: Enter, Tab'],
        ['press', { key: 'enter' }, 'key must be one of: Enter, Tab'],
        ['get_text', { ref: 'x' }, 'ref must match ^e\\d+$'],
        ['screenshot', { fullPage: 'yes' }, 'fullPage must be a boolean'],
        ['console', { level: 'trace' }, 'level must be one of: log, debug, info, warning, error'],
        ['network', { filter: '' }, 'filter must be at least 1 characters'],
        ['wait_for', {}, 'wait_for requires text or time'],
        ['wait_for', { time: 0 }, 'time is out of range'],
        ['wait_for', { time: 31 }, 'time is out of range'],
    ];

    test('refuses every invalid input before any request, as a tool error that names the constraint', async () => {
        const { calls, request } = recorder(verb => Response.json(replies[verb]));
        const mcp = session(request);
        try {
            await initialize(mcp);
            for (const [verb, args, needle] of refused) {
                const result = await call(mcp, 'browser_' + verb, args);
                expect(result.isError).toBe(true);
                expect(result.structuredContent).toMatchObject({ ok: false, error: 'invalid_arguments' });
                expect(result.content[0].text).toContain(needle);
            }
            expect(calls).toHaveLength(0);
            // Positive control: the same tools take valid input and do send.
            for (const verb of verbs) expect((await call(mcp, 'browser_' + verb, good[verb])).isError).toBe(false);
            expect(calls).toHaveLength(13);
            expect(new Set(refused.map(([verb]) => verb))).toEqual(new Set(verbs));
        } finally { mcp.close(); }
    });

    test('accepts the contract bounds exactly, including a maximum fill_form past the old line limit', async () => {
        const { calls, request } = recorder(verb => Response.json(replies[verb]));
        const mcp = session(request);
        try {
            await initialize(mcp);
            const full = { fields: Array.from({ length: 20 }, (_, index) => ({ ref: 'e' + index, value: 'v'.repeat(4000) })) };
            expect(JSON.stringify(full).length).toBeGreaterThan(80000);
            expect((await call(mcp, 'browser_fill_form', full)).isError).toBe(false);
            expect(calls.at(-1)!.init.body).toBe(JSON.stringify(full));
            for (const args of [
                { verb: 'scroll', args: { dy: 5000 } }, { verb: 'scroll', args: { dy: -5000 } },
                { verb: 'select', args: { ref: 'e1', values: Array.from({ length: 20 }, () => 'v') } },
                { verb: 'wait_for', args: { time: 30 } }, { verb: 'type', args: { ref: 'e1', text: 'x'.repeat(4000) } },
            ]) expect((await call(mcp, 'browser_' + args.verb, args.args)).isError).toBe(false);
            expect(calls).toHaveLength(6);
            mcp.send({ id: 99, method: 'ping', params: { pad: 'x'.repeat(1024 * 1024) } });
            expect((await mcp.receive()).error.code).toBe(-32600);
        } finally { mcp.close(); }
    });

    test('never echoes a refused field value, which may be a password', async () => {
        const mcp = session(recorder(() => Response.error()).request);
        try {
            await initialize(mcp);
            const result = await call(mcp, 'browser_fill_form', { fields: [{ ref: 'e1', value: 'PASSWORD'.repeat(600) }] });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('fields[0].value must be at most 4000');
            expect(mcp.seen.join('\n')).not.toContain('PASSWORD');
        } finally { mcp.close(); }
    });

    test('rejects an unknown tool as a protocol error', async () => {
        const mcp = session(recorder(() => Response.error()).request);
        try {
            await initialize(mcp);
            mcp.send({ id: 5, method: 'tools/call', params: { name: 'browser_evaluate', arguments: {} } });
            expect((await mcp.receive()).error.code).toBe(-32602);
        } finally { mcp.close(); }
    });

    test('returns a screenshot as an image block and keeps the base64 out of the text and structured content', async () => {
        const { request } = recorder(verb => Response.json(replies[verb]));
        const mcp = session(request);
        try {
            await initialize(mcp);
            const result = await call(mcp, 'browser_screenshot', {});
            expect(result.isError).toBe(false);
            expect(result.content).toHaveLength(2);
            expect(result.content[1]).toEqual({ type: 'image', data: png, mimeType: 'image/png' });
            expect(result.content[0].type).toBe('text');
            expect(result.content[0].text).not.toContain(png);
            expect(result.structuredContent).toEqual({ ok: true, sha256: '0'.repeat(64), byteSize: 8, width: 2, height: 2 });
            expect(JSON.stringify(result.structuredContent)).not.toContain(png);
        } finally { mcp.close(); }
    });

    test('withholds a screenshot whose bytes are not base64', async () => {
        const mcp = session(recorder(() => Response.json({ ...replies.screenshot, pngBase64: 'not base64!' })).request);
        try {
            await initialize(mcp);
            const result = await call(mcp, 'browser_screenshot', {});
            expect(result.isError).toBe(true);
            expect(result.structuredContent.error).toBe('browser_unavailable');
            expect(mcp.seen.join('\n')).not.toContain('not base64');
        } finally { mcp.close(); }
    });

    test('maps origin_read_only, stale_ref and a 401 to tool errors, and never retries', async () => {
        const answers: Response[] = [
            Response.json({ ok: false, error: 'origin_read_only', detail: 'Request failed.' }),
            Response.json({ ok: false, error: 'stale_ref', detail: 'Request failed.' }),
            // The Code loopback refuses with the fixed bad_request body; the status is what says "not available".
            Response.json({ ok: false, error: 'bad_request', detail: 'Request failed.' }, { status: 401 }),
            new Response('<html>', { status: 502 }),
            Response.json({ ok: false, error: 'something_new', detail: 'x' }),
            Response.json({ ok: true, url: page }),
        ];
        const { calls, request } = recorder(() => answers.shift()!);
        const mcp = session(request);
        try {
            await initialize(mcp);
            const args = { ref: 'e1' };
            const readOnly = await call(mcp, 'browser_click', args);
            expect(readOnly.isError).toBe(true);
            expect(readOnly.structuredContent.error).toBe('origin_read_only');
            expect(readOnly.content[0].text).toContain('origin_read_only');
            expect(readOnly.content[0].text).toContain('signed-in app or the sign-in provider');
            expect(readOnly.content[0].text).toContain('Code chats cannot act on it');
            const stale = await call(mcp, 'browser_click', args);
            expect(stale.isError).toBe(true);
            expect(stale.structuredContent.error).toBe('stale_ref');
            expect(stale.content[0].text).toContain('browser_snapshot');
            const unauthorized = await call(mcp, 'browser_click', args);
            expect(unauthorized.isError).toBe(true);
            expect(unauthorized.structuredContent.error).toBe('browser_unavailable');
            expect(unauthorized.content[0].text).toContain('The Browser tool is not available in this computer.');
            expect(unauthorized.content[0].text).not.toContain('bad_request');
            expect((await call(mcp, 'browser_click', args)).structuredContent.error).toBe('browser_unavailable');
            expect((await call(mcp, 'browser_click', args)).structuredContent.error).toBe('browser_unavailable');
            expect(calls).toHaveLength(5);
            // Positive control: the same call succeeds when the sidecar says ok.
            expect((await call(mcp, 'browser_click', args)).isError).toBe(false);
            expect(calls).toHaveLength(6);
        } finally { mcp.close(); }
    });

    test('reports a transport failure as unavailable, after one attempt', async () => {
        const { calls, request } = recorder(() => { throw new Error('connect ECONNREFUSED ' + secret); });
        const mcp = session(request, secret);
        try {
            await initialize(mcp);
            const result = await call(mcp, 'browser_get_text', {});
            expect(result.isError).toBe(true);
            expect(result.structuredContent.error).toBe('browser_unavailable');
            expect(calls).toHaveLength(1);
            expect(mcp.seen.join('\n')).not.toContain(secret);
        } finally { mcp.close(); }
    });

    test('keeps the token out of every response, wherever the sidecar or a page puts it', async () => {
        expect(secret).toHaveLength(43);
        const answers: Response[] = [
            Response.json({ ...replies.snapshot, snapshot: `token is ${secret}`, title: secret, debug: secret }),
            Response.json({ ok: false, error: 'timeout', detail: `waited with ${secret}` }),
            Response.json({ ok: false, error: 'bad_request', detail: 'Request failed.', echo: secret }, { status: 401 }),
            Response.json({ ok: true, entries: [{ level: 'log', text: secret }], leaked: secret }),
            Response.json({ ...replies.screenshot, debug: secret }),
        ];
        const mcp = session(recorder(() => answers.shift()!).request, secret);
        try {
            await initialize(mcp);
            const snapshot = await call(mcp, 'browser_snapshot', {});
            expect(snapshot.isError).toBe(false);
            expect(snapshot.structuredContent.snapshot).toBe('token is [redacted]');
            expect(snapshot.structuredContent.debug).toBeUndefined();
            expect((await call(mcp, 'browser_wait_for', { time: 1 })).content[0].text).toContain('waited with [redacted]');
            expect((await call(mcp, 'browser_click', { ref: 'e1' })).isError).toBe(true);
            expect((await call(mcp, 'browser_console', {})).structuredContent.entries[0].text).toBe('[redacted]');
            expect((await call(mcp, 'browser_screenshot', {})).isError).toBe(false);
            expect(mcp.seen.length).toBeGreaterThanOrEqual(6);
            expect(mcp.seen.join('\n')).not.toContain(secret);
        } finally { mcp.close(); }
    });

    test('cancels a verb request when the client cancels and keeps the connection usable', async () => {
        const aborted = Promise.withResolvers<void>();
        const mcp = session(recorder((_verb, init) => new Promise<Response>(resolve => {
            init.signal?.addEventListener('abort', () => { aborted.resolve(); resolve(Response.error()); }, { once: true });
        })).request);
        try {
            await initialize(mcp);
            mcp.send({ id: 3, method: 'tools/call', params: { name: 'browser_wait_for', arguments: { time: 5 } } });
            mcp.send({ method: 'notifications/cancelled', params: { requestId: 3 } });
            await aborted.promise;
            mcp.send({ id: 4, method: 'ping' });
            expect(await mcp.receive()).toEqual({ jsonrpc: '2.0', id: 4, result: {} });
        } finally { mcp.close(); }
    });
});
