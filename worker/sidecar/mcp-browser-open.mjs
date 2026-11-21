import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { createBrowserOpenProxy } from './mcp-browser-open-proxy.mjs';

export const BROWSER_OPEN_PATH = '/internal/mcp-browser-open-url';
export const CODE_BROWSER_OPEN_PATH = '/internal/code/browser/open-url';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BINDING = /^[0-9a-f]{64}$/;
const RESERVED_PORTS = new Set(['3000', '3002', '4243', '8080', '8181', '8443', '9090', '9222', '9223']);
const MAX_RECORDS = 128;
const MAX_ACTIVE = 4;
const RECORD_MS = 120_000;
const RELEASE_MS = 2_000;
const DOCUMENT_POLICY = { name: 'Content-Security-Policy', value: 'sandbox allow-scripts allow-same-origin allow-forms' };

export function browserOpenFailure (runId, error, stage, retryable = false) {
    return { ok: false, runId, error, stage, retryable };
}

function destination (value) {
    if (typeof value !== 'string' || value.length > 2048 || !/^https?:\/\//i.test(value)
        || /[\s\u0000-\u0020\u007f\\]/u.test(value)) return null;
    try {
        const url = new URL(value);
        if (url.username || url.password || url.href.length > 2048) return null;
        if (url.protocol === 'https:' && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(url.hostname)
            && !isIP(url.hostname) && !url.hostname.endsWith('.localhost')) return url;
        if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port
            && Number(url.port) >= 1024 && !RESERVED_PORTS.has(url.port)
            && value.startsWith('http://127.0.0.1:' + url.port + '/')) return url;
    } catch { /* Invalid or unsupported URL. */ }
    return null;
}

export function browserOpenOrigins (origins = '') {
    const entries = origins.split(/[\s,]+/u).filter(Boolean);
    const result = new Set();
    if (entries.length > 20) return result;
    for (const entry of entries) {
        const url = destination(entry + '/');
        if (url?.origin !== entry) return new Set();
        result.add(entry);
    }
    return result;
}

function inputBody (input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 4
        || typeof input.binding !== 'string' || !BINDING.test(input.binding)
        || typeof input.requestId !== 'string' || !UUID.test(input.requestId)
        || !Number.isInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 30_000) return null;
    return destination(input.url);
}

function within (promise, ms) {
    let timeout;
    return Promise.race([
        promise,
        new Promise(resolve => { timeout = setTimeout(resolve, ms); }),
    ]).finally(() => clearTimeout(timeout));
}

export function createMcpBrowserOpen (surface, { allowHttpOrigin, allowedOrigins = '', now = Date.now } = {}) {
    const origins = browserOpenOrigins(allowedOrigins + (allowHttpOrigin ? ' ' + allowHttpOrigin : ''));
    const runs = new Map();
    let active = 0;

    async function open (input, target, signal) {
        const start = now();
        const abort = new AbortController();
        let stage = 'attach';
        let browser;
        let context;
        let page;
        let proxy;
        let closeContext;
        const stop = error => abort.abort(error);
        const onDisconnect = () => stop('connection_lost');
        const onClose = () => stop('target_closed');
        const onCancel = () => stop('cancelled');
        const onUnexpectedPage = () => stop('target_closed');

        function releaseContext () {
            if (context && !closeContext) {
                context.off('page', onUnexpectedPage);
                page?.off('close', onClose);
                page?.off('crash', onClose);
                closeContext = context.close().catch(() => undefined);
            }
            return closeContext;
        }

        let onAbort;
        const stopped = new Promise(resolve => {
            onAbort = () => resolve(browserOpenFailure(input.requestId, abort.signal.reason, stage,
                stage === 'attach' && ['navigation_timeout', 'connection_lost'].includes(abort.signal.reason)));
            abort.signal.addEventListener('abort', onAbort, { once: true });
        });

        async function execute () {
            try {
                browser = await surface.connect();
                abort.signal.throwIfAborted();
                browser.on('disconnected', onDisconnect);
                proxy = await createBrowserOpenProxy(target);
                abort.signal.throwIfAborted();
                context = await browser.newContext({
                    acceptDownloads: false,
                    serviceWorkers: 'block',
                    proxy: { server: proxy.url, bypass: '<-loopback>' },
                });
                abort.signal.throwIfAborted();
                page = await context.newPage();
                abort.signal.throwIfAborted();
                page.on('close', onClose);
                page.on('crash', onClose);
                context.on('page', onUnexpectedPage);
                const cdp = await context.newCDPSession(page);
                const { frameTree } = await cdp.send('Page.getFrameTree');
                const frameId = frameTree.frame.id;

                cdp.on('Fetch.requestPaused', event => {
                    const url = destination(event.request.url);
                    if (url?.origin === target.origin && !abort.signal.aborted) {
                        // A document can run its normal app scripts yet cannot
                        // create an unmanaged window, including a same-origin one.
                        const continued = event.responseStatusCode === undefined
                            ? cdp.send('Fetch.continueRequest', {
                                requestId: event.requestId, interceptResponse: event.resourceType === 'Document',
                            })
                            : cdp.send('Fetch.continueResponse', {
                                requestId: event.requestId, responseCode: event.responseStatusCode,
                                responsePhrase: event.responseStatusText ?? '',
                                responseHeaders: [...(event.responseHeaders ?? []), DOCUMENT_POLICY],
                            });
                        void continued.catch(() => stop('connection_lost'));
                    } else {
                        // Fetch pauses each HTTP hop, including a redirect,
                        // before that destination receives the browser request.
                        if (event.resourceType === 'Document' && event.frameId === frameId) stop('destination_denied');
                        void cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' })
                            .catch(() => { if (!abort.signal.aborted) stop('connection_lost'); });
                    }
                });
                await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
                abort.signal.throwIfAborted();

                stage = 'navigation';
                const response = await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 0 });
                const finalUrl = destination(page.url());
                if (finalUrl?.origin !== target.origin) {
                    return browserOpenFailure(input.requestId, 'destination_denied', stage);
                }
                const title = await page.evaluate(() => document.title.slice(0, 256));
                if (page.url() !== finalUrl.href) return browserOpenFailure(input.requestId, 'destination_denied', stage);
                abort.signal.throwIfAborted();
                return {
                    ok: true,
                    runId: input.requestId,
                    finalUrl: finalUrl.origin + finalUrl.pathname,
                    title: title.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ''),
                    httpStatus: response?.status() ?? null,
                    elapsedMs: Math.max(0, now() - start),
                };
            } catch {
                if (abort.signal.aborted) return stopped;
                if (!browser) return browserOpenFailure(input.requestId, 'browser_unavailable', stage, true);
                if (!browser.isConnected()) return browserOpenFailure(input.requestId, 'connection_lost', stage, stage === 'attach');
                if (page?.isClosed()) return browserOpenFailure(input.requestId, 'target_closed', stage);
                const error = stage === 'attach' ? 'cdp_attach_failed' : 'connection_lost';
                return browserOpenFailure(input.requestId, error, stage, stage === 'attach');
            } finally {
                browser?.off('disconnected', onDisconnect);
                proxy?.close();
                await within(releaseContext(), RELEASE_MS);
            }
        }

        signal?.addEventListener('abort', onCancel, { once: true });
        if (signal?.aborted) onCancel();
        const timeout = setTimeout(() => stop('navigation_timeout'), input.timeoutMs);
        try {
            if (abort.signal.aborted) return await stopped;
            const task = execute();
            const result = await Promise.race([task, stopped]);
            if (abort.signal.aborted) {
                proxy?.close();
                await within(releaseContext(), RELEASE_MS);
                // execute also owns cleanup for a context or proxy that
                // finishes being created after cancellation.
            }
            return result;
        } finally {
            abort.signal.removeEventListener('abort', onAbort);
            signal?.removeEventListener('abort', onCancel);
            clearTimeout(timeout);
        }
    }

    return async function browserOpen (input, signal) {
        const runId = typeof input?.requestId === 'string' && UUID.test(input.requestId) ? input.requestId : null;
        const target = inputBody(input);
        if (!target || !origins.has(target.origin)) return browserOpenFailure(runId, 'destination_denied', 'destination');

        for (const [id, run] of runs) {
            if (run.expires <= now()) runs.delete(id);
        }
        const fingerprint = createHash('sha256').update(JSON.stringify([input.binding, input.url, input.timeoutMs])).digest('hex');
        const previous = runs.get(runId);
        if (previous) {
            if (previous.fingerprint !== fingerprint) return browserOpenFailure(runId, 'request_conflict', 'request');
            return previous.result ?? browserOpenFailure(runId, 'request_pending', 'request', true);
        }
        if (active >= MAX_ACTIVE || runs.size >= MAX_RECORDS) {
            return browserOpenFailure(runId, 'browser_unavailable', 'runtime', true);
        }
        const run = { fingerprint, expires: Infinity, result: null };
        runs.set(runId, run);
        active += 1;
        try {
            run.result = await open(input, target, signal);
            return run.result;
        } finally {
            active -= 1;
            run.expires = now() + RECORD_MS;
        }
    };
}
