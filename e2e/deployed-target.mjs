/** Shared target and optional Vercel protection bypass for deployed suites. */
export function deployedTarget(env = process.env) {
  if (env.EZIL_E2E_REQUIRE_TARGET === '1' && !env.EZIL_E2E_APP) {
    throw new Error('EZIL_E2E_APP is required for cloud CI');
  }
  const url = new URL(env.EZIL_E2E_APP ?? 'https://os.ezil.org');
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

export async function configureAppContext(context, { app, headers } = { app: APP, headers: appHeaders }) {
  if (!Object.keys(headers).length) return;
  // Scope the bypass to this deployment. Global context headers would also
  // send it to the Worker, container frames and arbitrary external resources.
  await context.route('**/*', async (route) => {
    const request = route.request();
    try {
      if (new URL(request.url()).origin !== app) return await route.continue();
      // fetch(maxRedirects: 0) prevents custom headers following cross-origin
      // redirects; the browser makes the next request through this route again.
      const response = await route.fetch({
        headers: { ...request.headers(), ...headers }, maxRedirects: 0, timeout: APP_FETCH_TIMEOUT_MS,
      });
      await route.fulfill({ response });
    } catch (error) {
      // A media request can still be in flight when a completed test closes its
      // browser context. Playwright then rejects route.fetch after disposal.
      if (String(error).includes('Request context disposed')) return;
      throw redactedFetchError(error, request);
    }
  });
}
