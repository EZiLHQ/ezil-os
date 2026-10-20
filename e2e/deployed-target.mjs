/** Shared target and optional Vercel protection bypass for deployed suites. */
import http from 'node:http';
import https from 'node:https';

export function deployedTarget(env = process.env) {
  if (env.EZIL_E2E_REQUIRE_TARGET === '1' && !env.EZIL_E2E_APP) {
    throw new Error('EZIL_E2E_APP is required for cloud CI');
  }
  const url = new URL(env.EZIL_E2E_APP ?? 'https://os.ezil.work');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('EZIL_E2E_APP must be an HTTPS origin (HTTP is allowed only on loopback)');
  }
  const headers = env.VERCEL_AUTOMATION_BYPASS_SECRET
    ? { 'x-vercel-protection-bypass': env.VERCEL_AUTOMATION_BYPASS_SECRET }
    : {};
  return { app: url.origin, headers };
}

export const { app: APP, headers: appHeaders } = deployedTarget();

// The app's own budget for a request that may wait on a container cold start
// (`maxDuration` on the tRPC and shell routes is 300 s; the client gives up at
// ~210 s). Playwright's 30 s default would cut a cold `/api/shell/desktop` off
// mid-boot and report the harness, not the app.
export const APP_FETCH_TIMEOUT_MS = 240_000;
// Final checkpoint + teardown has a 270 s forwarding budget, inside the
// 300 s shell route. Its harness must leave room for the response afterward.
export const APP_STOP_FETCH_TIMEOUT_MS = 290_000;

export function appFetchTimeout(request) {
  return request.method() === 'POST' && new URL(request.url()).pathname === '/api/shell/stop'
    ? APP_STOP_FETCH_TIMEOUT_MS : APP_FETCH_TIMEOUT_MS;
}

/**
 * 🔴 Playwright's route.fetch errors carry a "Call log" that prints EVERY
 * request header — the session cookie (access AND refresh token) and the
 * protection-bypass secret included. CI logs on this public repository are
 * world-readable, so the original error must never reach stdout. Keep the
 * first line of the message (the reason, e.g. "Timeout 240000ms exceeded."),
 * the method and the path; drop everything else.
 */
export function redactedFetchError(error, request) {
  const reason = String(error?.message ?? error).split('\n')[0]
    .replace(/(cookie|authorization|x-vercel-protection-bypass)\s*[:=].*$/i, '$1: [redacted]');
  let where = '';
  try { where = ` ${request.method()} ${new URL(request.url()).pathname}`; } catch { /* keep the reason */ }
  const redacted = new Error(`bypass fetch failed${where}: ${reason}`);
  redacted.name = error?.name ?? 'Error';
  return redacted;
}

// Hop-by-hop and transport headers the transport below sets itself.
const OWN_HEADERS = new Set(['host', 'connection', 'keep-alive', 'content-length', 'transfer-encoding', 'accept-encoding', 'cookie']);

/**
 * Playwright's request client pools sockets with TCP keep-alive probes every
 * second and fails the request with `read ETIMEDOUT` after ten unanswered
 * probes. A network path that drops probes for ten seconds then fails a
 * healthy request whose response is still being prepared: a cold desktop
 * start or a final checkpoint can hold the connection silent for minutes.
 * App API calls therefore use a fresh connection without probes. Redirects
 * are returned, never followed; errors carry no request headers.
 */
export function appRequest(url, { method = 'GET', headers = {}, body, timeout = APP_FETCH_TIMEOUT_MS, signal } = {}) {
  const target = new URL(url);
  const client = target.protocol === 'https:' ? https : http;
  const sent = Object.fromEntries(Object.entries(headers)
    .filter(([name]) => !name.startsWith(':') && !OWN_HEADERS.has(name.toLowerCase())));
  if (headers.cookie) sent.cookie = headers.cookie;
  sent['accept-encoding'] = 'identity';
  return new Promise((resolve, reject) => {
    const request = client.request(target, { method, headers: sent, agent: false,
      signal: signal ? AbortSignal.any([AbortSignal.timeout(timeout), signal]) : AbortSignal.timeout(timeout) }, (response) => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('socket', socket => socket.setKeepAlive(false));
    request.on('error', reject);
    request.end(body);
  });
}

export function cookieHeader(cookies) {
  return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

// The shape route.fulfill expects: one string per header, Set-Cookie lines
// separated by newlines as Playwright's own APIResponse.headers() returns them.
function fulfillHeaders(headers) {
  return Object.fromEntries(Object.entries(headers)
    .filter(([name]) => !['connection', 'keep-alive', 'content-length', 'transfer-encoding'].includes(name))
    .map(([name, value]) => [name, Array.isArray(value) ? value.join(name === 'set-cookie' ? '\n' : ', ') : String(value)]));
}

export async function configureAppContext(context, { app = APP, headers = appHeaders, send = appRequest } = {}) {
  const bypass = Object.keys(headers).length > 0;
  // A closed context cannot cancel the standalone API requests below; abort them.
  const closed = new AbortController();
  context.on?.('close', () => closed.abort());
  // Scope the bypass to this deployment. Global context headers would also
  // send it to the Worker, container frames and arbitrary external resources.
  // The route is installed without a bypass too: API calls still need the
  // probe-free transport on a public target.
  await context.route('**/*', async (route) => {
    const request = route.request();
    try {
      const url = new URL(request.url());
      if (url.origin !== app) return await route.continue();
      if (url.pathname.startsWith('/api/')) {
        // Intercepted requests carry no Cookie header; route.fetch reads the
        // context jar, and so does this.
        const cookies = await context.cookies(request.url());
        const response = await send(request.url(), {
          method: request.method(),
          headers: { ...request.headers(), ...headers, ...(cookies.length ? { cookie: cookieHeader(cookies) } : {}) },
          body: request.postDataBuffer() ?? undefined,
          timeout: appFetchTimeout(request),
          signal: closed.signal,
        });
        return await route.fulfill({ status: response.status, headers: fulfillHeaders(response.headers), body: response.body });
      }
      if (!bypass) return await route.continue();
      // fetch(maxRedirects: 0) prevents custom headers following cross-origin
      // redirects; the browser makes the next request through this route again.
      const response = await route.fetch({
        headers: { ...request.headers(), ...headers }, maxRedirects: 0, timeout: appFetchTimeout(request),
      });
      await route.fulfill({ response });
    } catch (error) {
      // A request can still be in flight when a completed test closes its
      // browser context. Playwright then rejects route.fetch after disposal,
      // and the API transport is aborted with the context.
      if (closed.signal.aborted || String(error).includes('Request context disposed')) return;
      throw redactedFetchError(error, request);
    }
  });
}
