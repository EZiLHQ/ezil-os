// Full-bleed precedes the debounced screen POST and its encoder restart.
// Observe that contract before testing geometry; never wait for a geometry
// assertion itself to turn green, or issue a resize on the application's behalf.
export function observeScreenResizes(page, app) {
  const entries = new Map();
  const onRequest = request => {
    const url = new URL(request.url());
    if (url.origin !== new URL(app).origin || url.pathname !== '/api/shell/screen' || request.method() !== 'POST') return;
    try {
      const {computerId, width, height} = request.postDataJSON();
      entries.set(request, {computerId, width, height, status:'pending'});
    } catch { /* An invalid ask cannot satisfy readiness. */ }
  };
  const onResponse = async response => {
    const entry = entries.get(response.request());
    if (!entry) return;
    try {
      const body = await response.json();
      if (!response.ok() || body.ok !== true || !Number.isInteger(body.width) || body.width <= 0
          || !Number.isInteger(body.height) || body.height <= 0) {
        entry.status = 'failed';
      } else {
        entry.applied = {width:body.width, height:body.height};
        entry.status = 'applied';
      }
    } catch { entry.status = 'failed'; }
  };
  const onFailed = request => {
    const entry = entries.get(request);
    if (entry) entry.status = 'failed';
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfailed', onFailed);
  return {
    matching: want => [...entries.values()].reverse().find(e => e.computerId === want.computerId
      && e.width === want.width && e.height === want.height),
    dispose() {
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfailed', onFailed);
    },
  };
}

export async function readDesktopReadiness(page) {
  const want = await page.evaluate(() => {
    const win = document.querySelector('.window[data-app="desktop"]');
    const body = win?.querySelector('.window-body');
    if (!win?.classList.contains('ezil-fullbleed') || !body?.clientWidth || !body?.clientHeight) return null;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    return {computerId:win.getAttribute('data-ezil-computer-id'),
      width:Math.round(body.clientWidth * dpr), height:Math.round(body.clientHeight * dpr)};
  });
  const iframe = await page.$('.window[data-app="desktop"] iframe.window-app-iframe');
  let frame;
  try { frame = await iframe?.contentFrame(); }
  finally { await iframe?.dispose(); }
  // Playwright can inspect the cross-origin child; application JS cannot.
  const video = frame ? await frame.evaluate(() => {
    const v = document.querySelector('video');
    return v && {width:v.videoWidth, height:v.videoHeight, playing:!v.paused && v.readyState >= 2};
  }).catch(() => null) : null;
  return {want, video};
}

export async function waitForDesktopResize(page, observer, {
  // The shell serializes requests, each bounded at 25s. Allow an older request
  // plus this resize, both debounce intervals, and delivery of decoded pixels.
  timeoutMs = 60000, pollMs = 100, read = () => readDesktopReadiness(page),
} = {}) {
  let stopped = false, timer, detail = 'no full-bleed measurement';
  const poll = async () => {
    while (!stopped) {
      const {want, video} = await read();
      const resize = want && observer.matching(want);
      detail = want ? `request=${want.width}x${want.height} resize=${resize?.status ?? 'missing'}` : 'not full-bleed';
      if (resize?.status === 'failed') throw new Error(`Desktop resize failed: ${detail}`);
      if (resize?.applied) {
        const applied = resize.applied;
        detail += ` applied=${applied.width}x${applied.height} video=${video?.width ?? 0}x${video?.height ?? 0}`;
        if (video?.playing && video.width === applied.width && video.height === applied.height) return detail;
      }
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
  };
  try {
    return await Promise.race([poll(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Desktop resize readiness timed out after ${timeoutMs}ms: ${detail}`)), timeoutMs);
    })]);
  } finally { stopped = true; clearTimeout(timer); }
}
