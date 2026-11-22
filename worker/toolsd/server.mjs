#!/usr/bin/env node
/**
 * toolsd — the in-computer daemon for `EZIL-COMPUTER-TOOLS/1` (staging).
 *
 * Binds `0.0.0.0:9224`. The platform reaches a container on `10.0.0.1`, never
 * loopback, and the ONLY caller is the EZiL OS Worker over `containerFetch`,
 * MAC-authenticated per request. There is no health endpoint and no
 * unauthenticated path: section 3.5's checks run in order and the first to fail
 * answers HTTP 401 `tools_unauthorized` with nothing executed. Every reply is
 * JSON with `cache-control: no-store`.
 *
 * `createToolsdServer(options)` builds the server WITHOUT binding, so the HTTP
 * boundary (auth refusals, dispatch, relay) is testable offline. `startServer()`
 * runs only when this file is executed directly: it derives the key from this
 * boot's `EZIL_AI_PROXY_TOKEN` (passed in as `EZIL_TOOLSD_SEED`), DELETES the
 * seed from the environment so no spawned job can read it, prepares the tools
 * directory, and listens.
 */

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { authorize, deriveKey, createReplayCache, MAX_BODY_BYTES } from './auth.mjs';
import { scanCatalog, DEFAULT_WORKSPACE_ROOT } from './manifest.mjs';
import { createJobManager, prepareToolsDir } from './jobs.mjs';

export const DEFAULT_HOST = '0.0.0.0';
export const DEFAULT_PORT = 9224;

/** Map a toolsd op-level error code to its HTTP status. */
const ERROR_STATUS = {
  tools_invalid_request: 400,
  tool_not_found: 404,
  job_not_found: 404,
  terminal_jobs_busy: 429,
};

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const JOB_ID_RE = /^[A-Za-z0-9_-]{22}$/;

/** Read the body, bounded one byte past the limit so an oversize body is detectable. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const ceiling = MAX_BODY_BYTES + 1;
    req.on('data', (chunk) => {
      size += chunk.length;
      chunks.push(chunk);
      if (size > ceiling) {
        // Enough to prove it is over the bound; settle first, then stop reading
        // (a later `error`/`close` from destroy() cannot unsettle the promise).
        resolve(Buffer.concat(chunks).subarray(0, ceiling));
        req.destroy();
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The wire `Catalog` only — the private execution index (`byName`) is dropped. */
function catalogWire(scan) {
  return { catalogDigest: scan.catalogDigest, tools: scan.tools, invalid: scan.invalid };
}

/**
 * Construct the server. `key` is the 32-byte K (`deriveKey`). `jobManager` and
 * `rescan` are injectable for tests; by default a real job manager is built with
 * a `getScan` bound to this server's current catalog.
 */
export function createToolsdServer({
  key,
  workspaceRoot = DEFAULT_WORKSPACE_ROOT,
  now = Date.now,
  replay = createReplayCache(),
  rescan = () => scanCatalog(workspaceRoot),
  jobManager,
} = {}) {
  if (!Buffer.isBuffer(key)) throw new Error('toolsd: server requires a 32-byte derived key');

  let currentScan = rescan();
  const jm = jobManager ?? createJobManager({ workspaceRoot, getScan: () => currentScan });

  function reply(res, status, obj) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'no-store',
    });
    res.end(body);
  }

  const unauthorized = (res) => reply(res, 401, { ok: false, error: 'tools_unauthorized' });
  const invalid = (res) => reply(res, 400, { ok: false, error: 'tools_invalid_request' });
  const opError = (res, error) => reply(res, ERROR_STATUS[error] ?? 500, { ok: false, error });

  async function handle(req, res) {
    const bodyBytes = await readBody(req);
    const auth = authorize({
      method: (req.method || '').toUpperCase(),
      path: req.url || '',
      headers: req.headers,
      bodyBytes,
      now: now(),
      key,
      replay,
    });
    // Every refusal is the same 401; nothing below this line runs for it.
    if (!auth.ok) return unauthorized(res);

    // Parse the op body. An empty body is `{}`.
    let body;
    if (bodyBytes.length === 0) {
      body = {};
    } else {
      try {
        body = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bodyBytes));
      } catch {
        return invalid(res);
      }
    }
    if (!isPlainObject(body)) return invalid(res);

    return dispatch(req, res, auth.op, body);
  }

  async function dispatch(req, res, op, body) {
    switch (op) {
      case 'list': {
        if (Object.keys(body).length !== 0) return invalid(res);
        return reply(res, 200, { ok: true, ...catalogWire(currentScan) });
      }
      case 'refresh': {
        if (Object.keys(body).length !== 0) return invalid(res);
        const previousDigest = currentScan.catalogDigest;
        currentScan = rescan();
        const changed = previousDigest !== currentScan.catalogDigest;
        return reply(res, 200, { ok: true, ...catalogWire(currentScan), previousDigest, changed });
      }
      case 'call': {
        if (!validCallBody(body)) return invalid(res);
        const result = await jm.call({ name: body.name, arguments: body.arguments ?? {}, requestId: body.requestId });
        if (!result.ok) return opError(res, result.error);
        return reply(res, 200, { ok: true, ...result.job, catalogDigest: currentScan.catalogDigest });
      }
      case 'exec': {
        if (!validExecBody(body)) return invalid(res);
        const result = await jm.exec({
          command: body.command,
          cwd: body.cwd,
          timeoutSeconds: body.timeoutSeconds,
          background: body.background,
          requestId: body.requestId,
        });
        if (!result.ok) return opError(res, result.error);
        return reply(res, 200, { ok: true, ...result.job });
      }
      case 'job': {
        if (typeof body.jobId !== 'string' || !JOB_ID_RE.test(body.jobId) || Object.keys(body).length !== 1) return invalid(res);
        const result = jm.job({ jobId: body.jobId });
        if (!result.ok) return opError(res, result.error);
        return reply(res, 200, { ok: true, ...result.job });
      }
      case 'cancel': {
        if (typeof body.jobId !== 'string' || !JOB_ID_RE.test(body.jobId) || typeof body.requestId !== 'string'
          || Object.keys(body).sort().join(',') !== 'jobId,requestId') return invalid(res);
        const result = await jm.cancel({ jobId: body.jobId, requestId: body.requestId });
        if (!result.ok) return opError(res, result.error);
        return reply(res, 200, { ok: true, ...result.job });
      }
      default:
        return unauthorized(res); // unreachable: authorize already constrained op
    }
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      try { reply(res, 500, { ok: false, error: 'internal' }); } catch { /* socket gone */ }
    });
  });
  // Expose seams for tests without widening the wire surface.
  server.ezil = { get scan() { return currentScan; }, jobManager: jm, replay };
  return server;
}

/** `{name, arguments?, requestId}` — strict (contract 5.3). */
function validCallBody(body) {
  const keys = Object.keys(body).sort().join(',');
  if (keys !== 'name,requestId' && keys !== 'arguments,name,requestId') return false;
  if (typeof body.name !== 'string' || body.name.length < 1 || body.name.length > 64) return false;
  if ('arguments' in body && !isPlainObject(body.arguments)) return false;
  if (typeof body.requestId !== 'string' || body.requestId.length < 1 || body.requestId.length > 128) return false;
  return true;
}

/** `{command, cwd?, timeoutSeconds, background, requestId}` — strict (contract 5.3 / section 2). */
function validExecBody(body) {
  const required = ['background', 'command', 'requestId', 'timeoutSeconds'];
  const allowed = new Set([...required, 'cwd']);
  const keys = Object.keys(body);
  if (!required.every((k) => keys.includes(k)) || keys.some((k) => !allowed.has(k))) return false;
  if (typeof body.command !== 'string' || body.command.length < 1 || body.command.length > 8000 || body.command.includes('\0')) return false;
  if ('cwd' in body && (typeof body.cwd !== 'string' || body.cwd.length > 512)) return false;
  if (typeof body.background !== 'boolean') return false;
  if (!Number.isInteger(body.timeoutSeconds) || body.timeoutSeconds < 1) return false;
  const max = body.background ? 3600 : 600;
  if (body.timeoutSeconds > max) return false;
  if (typeof body.requestId !== 'string' || body.requestId.length < 1 || body.requestId.length > 128) return false;
  return true;
}

export async function startServer() {
  const seed = process.env.EZIL_TOOLSD_SEED;
  if (!seed) {
    console.error('[toolsd] EZIL_TOOLSD_SEED is not set; refusing to listen (no key to verify with)');
    process.exit(1);
    return;
  }
  const key = deriveKey(seed);
  // 🔴 The seed is this boot's proxy token. Remove it so no spawned job (which
  // is built a fresh environment anyway) can ever read it from toolsd's own.
  delete process.env.EZIL_TOOLSD_SEED;

  const workspaceRoot = process.env.EZIL_TOOLSD_WORKSPACE || DEFAULT_WORKSPACE_ROOT;
  const host = process.env.EZIL_TOOLSD_HOST || DEFAULT_HOST;
  const port = Number.parseInt(process.env.EZIL_TOOLSD_PORT ?? '', 10) || DEFAULT_PORT;

  prepareToolsDir(workspaceRoot);
  const server = createToolsdServer({ key, workspaceRoot });

  server.listen(port, host, () => {
    console.log(`[toolsd] listening on ${host}:${port}, workspace ${workspaceRoot}`);
  });
  server.on('error', (err) => {
    console.error(`[toolsd] listen failed: ${err.message}`);
    process.exit(1);
  });
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      console.log(`[toolsd] ${signal} — closing`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startServer();
}
