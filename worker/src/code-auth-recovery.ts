/**
 * Code's refused or unreachable DOCUMENT gets a recovery UI; every other request (fetch, asset, WebSocket, POST,
 * another port) keeps its strict JSON answer. No credential is issued here and nothing from the request (its URL,
 * query, headers) is reflected into the page.
 */

/** Message the 401 document posts to the shell (`shell/ezil/apps/code-auth-recovery.js`). */
export const CODE_AUTH_REQUIRED_MESSAGE = 'ezil:code-auth-required';
/** Message the 502 document posts to the shell: the computer's origin (its tunnel) is not up for this epoch. */
export const CODE_ORIGIN_UNAVAILABLE_MESSAGE = 'ezil:code-origin-unavailable';

/** Whether this is a browser navigation that would render Code's workbench document (never a fetch or an asset). */
export function isCodeDocumentNavigation(request: Request, url: URL): boolean {
  const dest = request.headers.get('sec-fetch-dest');
  return request.method === 'GET' && url.pathname === '/' && !request.headers.get('upgrade')
    && (dest === 'iframe' || dest === 'document' || dest === 'frame'
      || (!dest && (request.headers.get('accept') ?? '').includes('text/html')));
}

/** The one shell origin a recovery link may point at: codeShellOriginsFor's fixed mapping, never a request value. */
function trustedShellOrigin(shellOrigins: readonly string[]): string | null {
  return shellOrigins.length === 1 && /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(shellOrigins[0]!)
    ? shellOrigins[0]! : null;
}

function recoveryDocument(status: number, title: string, body: string, script: string): Response {
  const nonce = crypto.randomUUID();
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>`
    + `<body>${body}<script nonce="${nonce}">${script}</script></body></html>`;
  return new Response(html, { status, headers: {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
    'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'`,
  } });
}

/** The expired-cookie document (401): the shell renews the session through the signed-in OS. */
export function codeAuthRecovery(request: Request, shellOrigins: readonly string[] = []): Response | null {
  if (!isCodeDocumentNavigation(request, new URL(request.url))) return null;
  const origin = trustedShellOrigin(shellOrigins);
  const action = origin
    ? `<a id="reload" href="${origin}/app/code" target="_top" rel="noreferrer noopener">Reload EZiL OS</a>`
    : '<p>Reload the EZiL OS tab to reconnect.</p>';
  return recoveryDocument(401, 'Reconnect Code',
    '<p>Your Code connection needs to be renewed.</p>' + action,
    `function recover(){parent.postMessage({type:'${CODE_AUTH_REQUIRED_MESSAGE}'},'*')}recover();document.getElementById('reload')?.addEventListener('click',recover)`);
}

/**
 * The unavailable-origin document (502): the computer's tunnel is absent, fenced or of another epoch, or the
 * origin behind it did not answer. The shell checks the computer and reopens Code once (`code-auth-recovery.js`);
 * "Try again" repeats that ask and never navigates on its own. The fixed OS link is for a shell without the
 * listener, as the 401 document's is.
 */
export function codeOriginRecovery(request: Request, shellOrigins: readonly string[] = []): Response | null {
  if (!isCodeDocumentNavigation(request, new URL(request.url))) return null;
  const origin = trustedShellOrigin(shellOrigins);
  const link = origin
    ? `<p><a id="reload" href="${origin}/app/code" target="_top" rel="noreferrer noopener">Reload EZiL OS</a></p>`
    : '<p>If this keeps showing, reload the EZiL OS tab.</p>';
  return recoveryDocument(502, 'Code unavailable',
    "<p>Code can't reach your computer right now. Your files are safe.</p>"
    + '<p><button id="retry" type="button">Try again</button></p>' + link,
    `function recover(){parent.postMessage({type:'${CODE_ORIGIN_UNAVAILABLE_MESSAGE}'},'*')}recover();document.getElementById('retry')?.addEventListener('click',recover)`);
}
