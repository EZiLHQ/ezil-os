/**
 * `scripts/pull-neko-log.mjs` — the operator's way into `POST /sandbox/:name/logs`.
 *
 * The point of this file is the ONE thing a script like this always gets wrong
 * eventually: the signed payload. The script mints tokens with its own copy of
 * the string (it is a plain `.mjs` run by `node`, with no import path into
 * `src/`), so the token is verified here by the WORKER'S OWN
 * `verifyPreviewToken` rather than by a re-implementation of it. If the two
 * copies drift, this fails instead of a 401 doing so in production at the worst
 * possible moment.
 *
 * The CLI half is exercised by running the real script against a real local
 * HTTP server that answers exactly what `handleNekoLogs` answers.
 */
import { describe, expect, it, afterAll } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { verifyPreviewToken, PREVIEW_TOKEN_PAYLOAD, TOKEN_MAX_AGE_MS } from '../src/hmac';
// @ts-expect-error — plain .mjs helper, deliberately importable for this test.
import { mintPreviewToken, previewTokenPayload, parseArgs } from './pull-neko-log.mjs';

const SECRET = 'operator-secret-value';
const SCRIPT = join(import.meta.dir, 'pull-neko-log.mjs');

describe('the token the script mints', () => {
    it('🔴 uses the Worker`s own canonical payload, character for character', () => {
        expect(previewTokenPayload(1_700_000_000_000)).toBe(PREVIEW_TOKEN_PAYLOAD(1_700_000_000_000));
    });

    it('verifies against the shipped verifier, with the shipped secret resolution', async () => {
        const token = mintPreviewToken(SECRET);
        expect(await verifyPreviewToken(token, SECRET)).toEqual({ ok: true });
    });

    it('is rejected by the verifier when signed with the wrong secret', async () => {
        const res = await verifyPreviewToken(mintPreviewToken('not-the-secret'), SECRET);
        expect(res.ok).toBe(false);
    });

    it('is rejected once it is older than the freshness window', async () => {
        const stale = mintPreviewToken(SECRET, Date.now() - TOKEN_MAX_AGE_MS - 1_000);
        const res = await verifyPreviewToken(stale, SECRET);
        expect(res).toEqual({ ok: false, error: 'hmac_token_expired' });
    });
});

describe('argument parsing', () => {
    it('defaults to the logs route and lets the server pick the line cap', () => {
        expect(parseArgs(['guac-a-b'])).toEqual({ name: 'guac-a-b', lines: undefined, route: 'logs', json: false });
    });

    it('accepts both flag spellings', () => {
        expect(parseArgs(['guac-a-b', '--lines=50', '--route=cpu-diag', '--json'])).toEqual({
            name: 'guac-a-b',
            lines: 50,
            route: 'cpu-diag',
            json: true,
        });
        expect(parseArgs(['--lines', '10', 'guac-a-b']).lines).toBe(10);
    });

    it('refuses a missing name, an unknown route, an unknown flag and a nonsense line count', () => {
        expect(() => parseArgs([])).toThrow(/missing/);
        expect(() => parseArgs(['x', '--route', 'shell'])).toThrow(/unknown --route/);
        expect(() => parseArgs(['x', '--wat'])).toThrow(/unknown flag/);
        expect(() => parseArgs(['x', '--lines', '0'])).toThrow(/positive/);
    });
});

// ── The script, run for real against a server that verifies like the Worker ──

let server: Server | undefined;
afterAll(() => server?.close());

async function withWorker(
    respond: (body: { token?: string; maxLines?: number }, url: string) => { status: number; json: unknown },
): Promise<{ base: string; seen: { url: string; body: Record<string, unknown> }[] }> {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    server = createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', async () => {
            const body = JSON.parse(raw || '{}');
            seen.push({ url: req.url ?? '', body });
            // The real gate, not a stand-in for it.
            const auth = await verifyPreviewToken(body.token, SECRET);
            if (!auth.ok) {
                res.writeHead(401, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: auth.error }));
                return;
            }
            const out = respond(body, req.url ?? '');
            res.writeHead(out.status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(out.json));
        });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server!.address() as { port: number }).port;
    return { base: `http://127.0.0.1:${port}`, seen };
}

/**
 * ASYNC on purpose: the stub Worker above runs on this process's own event
 * loop, so a `spawnSync` here would block the loop that has to answer the
 * request the child is making, and deadlock.
 */
function run(
    base: string,
    args: string[],
    env: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        const child = spawn('node', [SCRIPT, ...args], {
            env: { ...process.env, EZIL_WORKER_URL: base, SANDBOX_HMAC_SECRET: SECRET, ...env },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c) => (stdout += c));
        child.stderr.on('data', (c) => (stderr += c));
        child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
}

describe('the script, end to end against a verifying server', () => {
    it('🔴 authenticates, hits /sandbox/:name/logs, and prints the redacted content on stdout', async () => {
        const { base, seen } = await withWorker(() => ({
            status: 200,
            json: {
                ok: true,
                path: '/tmp/neko.log',
                exists: true,
                bytes: 4096,
                totalLines: 900,
                returnedLines: 2,
                maxLineLen: 200,
                truncated: true,
                truncatedLines: 0,
                content: '[ezil-boot] phase=container_start event=start\n[ezil-boot] phase=ready event=end status=ok',
            },
        }));

        const res = await run(base, ['guac-abcd-efgh', '--lines', '2']);
        expect(res.status).toBe(0);
        expect(seen[0]!.url).toBe('/sandbox/guac-abcd-efgh/logs');
        expect(seen[0]!.body.maxLines).toBe(2);
        // Content on stdout so it can be piped; the summary on stderr so it cannot.
        expect(res.stdout).toContain('phase=ready event=end status=ok');
        expect(res.stdout).not.toContain('/tmp/neko.log —');
        expect(res.stderr).toContain('2/900 lines');
        expect(res.stderr).toContain('TRUNCATED');
        server?.close();
    });

    it('reports an absent log as a clean failure rather than pretending it was empty', async () => {
        const { base } = await withWorker(() => ({
            status: 200,
            json: { ok: true, path: '/tmp/neko.log', exists: false, note: 'neko_log_absent: never booted', content: '' },
        }));
        const res = await run(base, ['guac-abcd-efgh']);
        expect(res.status).toBe(1);
        expect(res.stderr).toContain('absent');
        server?.close();
    });

    it('surfaces the kill switch (404 neko_logs_disabled) instead of printing nothing and exiting 0', async () => {
        const { base } = await withWorker(() => ({ status: 404, json: { ok: false, error: 'neko_logs_disabled' } }));
        const res = await run(base, ['guac-abcd-efgh']);
        expect(res.status).toBe(1);
        expect(res.stderr).toContain('neko_logs_disabled');
        server?.close();
    });

    it('is rejected by the real verifier when the operator has the wrong secret', async () => {
        const { base } = await withWorker(() => ({ status: 200, json: { ok: true, exists: false } }));
        const res = await run(base, ['guac-abcd-efgh'], { SANDBOX_HMAC_SECRET: 'wrong-secret' });
        expect(res.status).toBe(1);
        expect(res.stderr).toContain('hmac_signature_mismatch');
        server?.close();
    });

    it('exits 2 without a secret, before making any request', async () => {
        const res = spawnSync('node', [SCRIPT, 'guac-a-b'], {
            encoding: 'utf8',
            env: {
                ...process.env,
                SANDBOX_HMAC_SECRET: '',
                CLOUDFLARE_GUACAMOLE_HMAC_SECRET: '',
                EZIL_WORKER_URL: 'http://127.0.0.1:1',
            },
        });
        expect(res.status).toBe(2);
        expect(res.stderr).toContain('missing SANDBOX_HMAC_SECRET');
    });

    it('routes --route cpu-diag to the cpu-diag endpoint, same envelope', async () => {
        const { base, seen } = await withWorker(() => ({
            status: 200,
            json: { ok: true, path: '/tmp/neko-cpu-diag.jsonl', exists: true, bytes: 1, totalLines: 1, returnedLines: 1, content: '{}' },
        }));
        const res = await run(base, ['guac-abcd-efgh', '--route', 'cpu-diag']);
        expect(res.status).toBe(0);
        expect(seen[0]!.url).toBe('/sandbox/guac-abcd-efgh/cpu-diag');
        server?.close();
    });
});
