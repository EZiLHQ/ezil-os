/**
 * Turning the SDK's stale-runtime 410 into something a person never sees as raw
 * JSON. Its own module because the Worker's entry module (`./index.ts`) may only
 * export handlers and classes — workerd refuses to start otherwise.
 */
/** What a stale-runtime page tells the shell around it (`apps/desktop-window.js` listens for it). */
export const PREVIEW_RUNTIME_STALE_MESSAGE = 'ezil:preview-runtime-stale';

/**
 * The SDK answers a preview URL whose container runtime is gone (an image
 * rollout, a crash, an idle-stop the user comes back to) with
 * `410 {"error":"Preview URL is stale because the sandbox runtime is not
 * active","code":"STALE_PREVIEW_URL"}`. For a NAVIGATION — the desktop iframe
 * loading or reloading — that JSON became the page the user saw (founder
 * screenshots, 2026-10-04). A navigation now gets a small page instead that
 * says so in words and tells the shell around it to mint a fresh URL against
 * the active runtime (`apps/desktop-window.js`). Still a 410, never cached,
 * and every non-navigation answer (XHR, WebSocket, `fetch`) is untouched.
 */
export async function recoverableStalePreview(request: Request, response: Response): Promise<Response> {
  if (response.status !== 410 || request.method !== 'GET') return response;
  const dest = request.headers.get('sec-fetch-dest');
  const wantsPage = dest === 'iframe' || dest === 'document' || dest === 'frame'
    || (!dest && (request.headers.get('accept') ?? '').includes('text/html'));
  if (!wantsPage) return response;
  const body = await response.clone().text();
  if (!body.includes('STALE_PREVIEW_URL')) return response;
  const attempt = new URL(request.url).searchParams.get('ezilAttempt');
  // Observable: the SDK's own "Stale preview URL blocked" warning is not logged
  // on every stale path (its running/healthy pre-check returns silently).
  console.warn(`[ezil-boot] phase=preview_stale event=recovery_page host=${new URL(request.url).hostname.split('.')[0]}`);
  const page = `<!doctype html><html><head><meta charset="utf-8"><title>Reconnecting</title>`
    + `<style>html,body{height:100%;margin:0;background:#161616;color:#d6d6d4;font:15px system-ui,sans-serif;`
    + `display:flex;align-items:center;justify-content:center}</style></head>`
    + `<body><p data-ezil-stale-runtime>Reconnecting to your computer…</p>`
    + `<script>try{parent.postMessage({type:${JSON.stringify(PREVIEW_RUNTIME_STALE_MESSAGE)},attempt:${JSON.stringify(attempt).replace(/</g, '\\u003c')}},'*')}catch(e){}</script>`
    + `</body></html>`;
  return new Response(page, {
    status: 410,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Ezil-Preview': 'runtime-stale' },
  });
}
