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
        if (line.length > 16384) return error(null, -32600, 'Invalid request');
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
        if (method === 'tools/list') return result(id, { tools: [browserOpenTool] });
        if (method !== 'tools/call') return error(id, -32601, 'Method not found');
        const args = params?.name === browserOpenTool.name ? input(params.arguments) : undefined;
        if (!args) return error(id, -32602, 'Invalid browser tool arguments');
        if (pending.has(id) || pending.size >= 16) return error(id, -32600, 'Request unavailable');
        const controller = new AbortController();
        pending.set(id, controller);
        void openBrowser(args, token, controller.signal, request).then(value => {
            if (controller.signal.aborted) return;
            result(id, {
                content: [{ type: 'text', text: JSON.stringify(value) }],
                structuredContent: value,
                isError: !value.ok,
            });
        }).finally(() => pending.delete(id));
    });
}
