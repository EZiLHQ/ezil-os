/** Cold startup leaves the iframe blank until its runtime URL is available. */
export function requestViewerProbe() {
  const frame = document.querySelector('.window[data-app="desktop"] iframe');
  if (!frame?.contentWindow || !frame.src) return false;
  let url;
  try { url = new URL(frame.src); } catch { return false; }
  const attempt = url.searchParams.get('ezilAttempt');
  if (!['https:', 'http:'].includes(url.protocol) || !attempt) return false;
  frame.contentWindow.postMessage({ source: 'ezil-shell', type: 'viewer_probe', attempt }, url.origin);
  return true;
}

/** Require two newly received media samples from the current navigation. */
export async function waitForViewerProgress({ sample, afterSequence, timeoutMs = 60000,
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), fallback = false }) {
  const deadline = now() + timeoutMs;
  let baseline, stopped = false, timer;
  const poll = async () => {
    while (!stopped && now() < deadline) {
      const current = await sample();
      if (stopped) return;
      const fresh = current && Number.isSafeInteger(current.sequence) && current.sequence > afterSequence
        && Number.isFinite(current.receivedAt) && now() - current.receivedAt >= 0 && now() - current.receivedAt <= 10000;
      const media = fresh && current.connectionState === 'connected'
        && ['bytesReceived', 'framesDecoded', 'width', 'height'].every(key => Number.isFinite(current[key]) && current[key] > 0);
      if (media) {
        const advanced = baseline && current.sequence > baseline.sequence
          && current.bytesReceived > baseline.bytesReceived && current.framesDecoded > baseline.framesDecoded;
        if (advanced) {
          if (current.localCandidateType !== 'relay' && current.remoteCandidateType !== 'relay') throw new Error('Selected ICE pair does not use TURN');
          if (!['udp', 'tcp', 'tls'].includes(current.relayProtocol)) throw new Error('Selected TURN protocol missing');
          if (fallback && !['tcp', 'tls'].includes(current.relayProtocol)) throw new Error('UDP unavailable test did not select TCP/TLS TURN');
          return current;
        }
        // Reconnect and encoder restarts may reset counters. Only subsequent
        // progress from that new report can establish readiness again.
        if (!baseline || current.sequence > baseline.sequence
            && (current.bytesReceived < baseline.bytesReceived || current.framesDecoded < baseline.framesDecoded)) baseline = current;
      } else if (fresh) baseline = undefined;
      await sleep(100);
    }
    throw new Error('Current viewer frame progression timed out');
  };
  try {
    return await Promise.race([poll(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Current viewer frame progression timed out')), timeoutMs);
    })]);
  } finally { stopped = true; clearTimeout(timer); }
}
