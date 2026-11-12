/** No credential is issued here: only Code's refused document gets a recovery UI. */
export function codeAuthRecovery(request: Request, shellOrigins: readonly string[] = []): Response | null {
  const url = new URL(request.url);
  const dest = request.headers.get('sec-fetch-dest');
  if (request.method !== 'GET' || url.pathname !== '/' || request.headers.get('upgrade')
    || !(dest === 'iframe' || dest === 'document' || dest === 'frame'
      || (!dest && (request.headers.get('accept') ?? '').includes('text/html')))) return null;
  // Supplied only by codeShellOriginsFor's fixed environment mapping, never a request URL/header.
  const origin = shellOrigins.length === 1 && /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(shellOrigins[0]!)
    ? shellOrigins[0] : null;
  const action = origin
    ? `<a id="reload" href="${origin}/app/code" target="_top" rel="noreferrer noopener">Reload EZiL OS</a>`
    : '<p>Reload the EZiL OS tab to reconnect.</p>';
  const nonce = crypto.randomUUID();
  const html = '<!doctype html><html><head><meta charset="utf-8"><title>Reconnect Code</title></head>'
    + '<body><p>Your Code connection needs to be renewed.</p>' + action
    + `<script nonce="${nonce}">function recover(){parent.postMessage({type:'ezil:code-auth-required'},'*')}recover();document.getElementById('reload')?.addEventListener('click',recover)</script>`
    + '</body></html>';
  return new Response(html, { status: 401, headers: {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
    'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'`,
  } });
}
