#!/usr/bin/env node
/**
 * Pull a live container's own boot log — the operator entry point for
 * `POST /sandbox/:name/logs` (`handleNekoLogs` + `src/neko-logs.ts`).
 *
 * ── Why a script ────────────────────────────────────────────────────────────
 * That route has existed and been deployed since 2026-08-19 and NOTHING called
 * it, because calling it requires an HMAC token and there was no way to mint
 * one outside the app's own server code. `/tmp/neko.log` is where every
 * human-readable boot line lands — Xvfb, openbox, neko, code-server and
 * Chromium all redirect into it — and until this script the only way to read
 * any of it was a live `wrangler tail` while the failure was happening.
 *
 * The token is the same 5-minute HMAC envelope every other signed Worker route
 * takes; the payload string is pinned against the Worker's own verifier by
 * `pull-neko-log.test.ts`, so a drift is a failing test rather than a 401 at
 * 2am. Same conventions as `twen-live-validate.mjs`: `node:crypto`, env for
 * the secret, never a flag (a secret on a command line lands in shell history
 * and in `ps`).
 *
 * USAGE
 *   SANDBOX_HMAC_SECRET=... node scripts/pull-neko-log.mjs <sandbox-name> [--lines 400] [--route logs|cpu-diag] [--json]
 *
 * ENV
 *   SANDBOX_HMAC_SECRET | CLOUDFLARE_GUACAMOLE_HMAC_SECRET  (required)
 *   EZIL_WORKER_URL     default https://api-desktop.ezil.org
 *
 * The sandbox name is `guac-<first 16 alnum of the user's id>-<first 16 alnum
 * of the computer's id>` (`deriveGuacamoleSandboxId`,
 * `app/src/server/lib/cloudflare-guacamole-provider.ts`). It is also the
 * `sandboxId` in any Worker log line for that computer.
 *
 * EXIT CODES  0 ok · 1 the route said no (or the sandbox has no log) · 2 bad usage/config
 */
import { createHmac } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Canonical signed payload — MUST match `PREVIEW_TOKEN_PAYLOAD` in `src/hmac.ts`. */
export const previewTokenPayload = (timestamp) => `${timestamp}.POST./sandbox/preview.`;

/** Mint a `t=<ms>,v1=<hex>` preview token. Valid for `TOKEN_MAX_AGE_MS` (5 min). */
export function mintPreviewToken(secret, now = Date.now()) {
    const ts = String(now);
    const sig = createHmac('sha256', secret).update(previewTokenPayload(ts)).digest('hex');
    return `t=${ts},v1=${sig}`;
}

/** Parse argv into `{ name, lines, route, json }`. Throws on unusable input. */
export function parseArgs(argv) {
    const out = { name: undefined, lines: undefined, route: 'logs', json: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--json') out.json = true;
        else if (a === '--lines') out.lines = Number(argv[++i]);
        else if (a.startsWith('--lines=')) out.lines = Number(a.slice('--lines='.length));
        else if (a === '--route') out.route = argv[++i];
        else if (a.startsWith('--route=')) out.route = a.slice('--route='.length);
        else if (a.startsWith('-')) throw new Error(`unknown flag: ${a}`);
        else if (out.name === undefined) out.name = a;
        else throw new Error(`unexpected argument: ${a}`);
    }
    if (!out.name) throw new Error('missing <sandbox-name>');
    if (out.route !== 'logs' && out.route !== 'cpu-diag') throw new Error(`unknown --route: ${out.route}`);
    if (out.lines !== undefined && (!Number.isFinite(out.lines) || out.lines <= 0)) {
        throw new Error('--lines must be a positive number');
    }
    return out;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
// Guarded so the exported helpers above can be imported by the test without
// the script trying to make a network call.
const isMain = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
if (isMain) {
    const SECRET = process.env.SANDBOX_HMAC_SECRET || process.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET;
    const BASE = (process.env.EZIL_WORKER_URL || 'https://api-desktop.ezil.org').replace(/\/$/, '');
    if (!SECRET) {
        console.error('missing SANDBOX_HMAC_SECRET (or CLOUDFLARE_GUACAMOLE_HMAC_SECRET)');
        process.exit(2);
    }

    let args;
    try {
        args = parseArgs(process.argv.slice(2));
    } catch (err) {
        console.error(`${err.message}`);
        console.error('usage: node scripts/pull-neko-log.mjs <sandbox-name> [--lines N] [--route logs|cpu-diag] [--json]');
        process.exit(2);
    }

    const body = { token: mintPreviewToken(SECRET) };
    if (args.lines !== undefined) body.maxLines = args.lines;

    const url = `${BASE}/sandbox/${encodeURIComponent(args.name)}/${args.route}`;
    let res;
    let payload;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            // The route execs inside a live container; a cold one can be slow.
            signal: AbortSignal.timeout(120_000),
        });
        payload = await res.json();
    } catch (err) {
        console.error(`request failed: ${err?.name || err}`);
        process.exit(1);
    }

    if (args.json) {
        console.log(JSON.stringify(payload, null, 2));
        process.exit(res.ok && payload.ok ? 0 : 1);
    }

    if (!res.ok || !payload.ok) {
        console.error(`${res.status} ${payload.error ?? 'unknown_error'}`);
        process.exit(1);
    }
    if (payload.exists === false) {
        console.error(`${payload.path}: absent — ${payload.note ?? 'nothing has written it in this container'}`);
        process.exit(1);
    }
    // Content to stdout so it can be piped/grepped; the summary to stderr so it
    // does not pollute the pipe. Every line is already redacted server-side
    // through `sanitizeErrorMessage` and capped at `maxLineLen` characters.
    console.error(
        `${payload.path} — ${payload.returnedLines}/${payload.totalLines} lines, ${payload.bytes} bytes on disk` +
            `${payload.truncated ? ' (TRUNCATED)' : ''}` +
            `${payload.truncatedLines ? `, ${payload.truncatedLines} long lines shortened to ${payload.maxLineLen} chars` : ''}`,
    );
    console.log(payload.content ?? '');
}
