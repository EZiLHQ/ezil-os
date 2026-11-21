import { isIP } from 'node:net';
import { z } from 'zod';

export const BROWSER_OPEN_SCOPE = 'ezil:browser:navigate';
export const BROWSER_OPEN_PROCEDURE = 'browserSession.openUrl';
export const BROWSER_OPEN_PATH = /^\/api\/mcp\/browser-sessions\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/open-url$/;

export const browserOpenRequest = z.object({
    requestId: z.string().uuid(),
    url: z.string().min(1).max(2048),
    timeoutMs: z.number().int().min(1000).max(30_000).default(15_000),
}).strict();
export type BrowserOpenRequest = z.infer<typeof browserOpenRequest>;

const browserOpenError = z.enum([
    'invalid_request', 'invalid_url', 'destination_denied', 'browser_unauthorized',
    'computer_unavailable', 'browser_session_stale', 'browser_unavailable',
    'cdp_attach_failed', 'navigation_timeout', 'cancelled', 'connection_lost',
    'target_closed', 'request_conflict', 'request_pending', 'browser_busy',
]);
const browserOpenStage = z.enum([
    'request', 'authorization', 'placement', 'destination', 'runtime',
    'attach', 'navigation', 'cleanup',
]);
export type BrowserOpenError = z.infer<typeof browserOpenError>;
export type BrowserOpenStage = z.infer<typeof browserOpenStage>;

export const browserOpenFailure = z.object({
    ok: z.literal(false),
    runId: z.string().uuid(),
    error: browserOpenError,
    stage: browserOpenStage,
    retryable: z.boolean(),
}).strict();

export const browserOpenSuccess = z.object({
    ok: z.literal(true),
    runId: z.string().uuid(),
    finalUrl: z.string().min(1).max(2048),
    title: z.string().max(512),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    elapsedMs: z.number().int().min(0).max(40_000),
}).strict();

const RESERVED_LOCAL_PORTS = new Set([3000, 3002, 4243, 8080, 8181, 8443, 9090, 9222, 9223]);

export function parseBrowserTestUrl(value: string): URL | undefined {
    if (value.length > 2048 || /[\s\\\x00-\x1f\x7f]/u.test(value) || !/^https?:\/\//i.test(value)) {
        return undefined;
    }
    try {
        const target = new URL(value);
        if (target.username || target.password || target.href.length > 2048) return undefined;
        if (target.protocol === 'https:' && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/iu.test(target.hostname)
            && !isIP(target.hostname) && !target.hostname.endsWith('.localhost')) return target;

        // HTTP is for an explicitly configured development fixture on this computer.
        // Reserve the desktop, editor, proxy, and CDP control ports.
        const port = Number(target.port);
        if (target.protocol === 'http:' && target.hostname === '127.0.0.1'
            && port >= 1024 && !RESERVED_LOCAL_PORTS.has(port)) return target;
    } catch {
        return undefined;
    }
}

export function browserTestOrigins(value: string | undefined): ReadonlySet<string> {
    const configured = (value ?? '').split(/[\s,]+/u).filter(Boolean);
    if (configured.length > 20 || configured.some(entry => parseBrowserTestUrl(entry)?.origin !== entry)) {
        return new Set();
    }
    return new Set(configured);
}
