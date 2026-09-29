/** Shared target and optional Vercel protection bypass for deployed suites. */
export function deployedTarget(env = process.env) {
  if (env.EZIL_E2E_REQUIRE_TARGET === '1' && !env.EZIL_E2E_APP) {
    throw new Error('EZIL_E2E_APP is required for cloud CI');
  }
  const url = new URL(env.EZIL_E2E_APP ?? 'https://ezil-os.vercel.app');
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

export async function configureAppContext(context, { app, headers } = { app: APP, headers: appHeaders }) {
  if (!Object.keys(headers).length) return;
  // Scope the bypass to this deployment. Global context headers would also
  // send it to the Worker, container frames and arbitrary external resources.
  await context.route('**/*', async (route) => {
    try {
      const request = route.request();
      if (new URL(request.url()).origin !== app) return await route.continue();
      // fetch(maxRedirects: 0) prevents custom headers following cross-origin
      // redirects; the browser makes the next request through this route again.
      const response = await route.fetch({
        headers: { ...request.headers(), ...headers }, maxRedirects: 0,
      });
      await route.fulfill({ response });
    } catch (error) {
      // A media request can still be in flight when a completed test closes its
      // browser context. Playwright then rejects route.fetch after disposal.
      if (String(error).includes('Request context disposed')) return;
      throw error;
    }
  });
}
