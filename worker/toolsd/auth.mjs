/**
 * toolsd request authentication — the frozen contract's section 3.5 listener
 * rules, plus the section 3.4 MAC derivation.
 *
 * 🔴 THE WHOLE SURFACE IS AUTHENTICATED. There is no health check, no
 * unauthenticated endpoint, and no error that distinguishes "wrong method" from
 * "wrong MAC": every refusal is HTTP 401 `tools_unauthorized` with nothing
 * executed, so a caller learns only that it is not the Worker. The checks run in
 * the contract's exact order, and the first to fail answers.
 *
 * The key the MAC is verified under is derived ONCE at boot from this boot's
 * `EZIL_AI_PROXY_TOKEN` (`deriveKey`); the seed is then deleted from the
 * environment by the server, so a spawned job can never read it (contract
 * section 5.1). The Worker re-derives the same key from the same proxy token
 * (`worker/src/computer-tools.ts`), so the two agree without the container ever
 * being told anything new.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** The six ops toolsd serves. A path outside `/v1/<op>` is a 401, not a 404. */
export const TOOLSD_OPS = ['list', 'refresh', 'call', 'exec', 'job', 'cancel'];

const PATH_RE = /^\/v1\/(list|refresh|call|exec|job|cancel)$/;
/** `v1.<ts>.<mac>`: ts = epoch milliseconds (decimal), mac = 64 lowercase hex. */
const HEADER_RE = /^v1\.([0-9]{1,20})\.([0-9a-f]{64})$/;

/**
 * The only acceptable `Host` values. Both the bare name and the `:9224` form
 * are allowed because we cannot yet confirm whether `getTcpPort().fetch()`
 * appends the port, and both are equally safe: a browser can never present an
 * `.invalid` host as an `Origin`, so neither widens the browser-refusal. Any
 * other host (a real IP, `localhost`, a wrong port) is refused.
 */
export const EXPECTED_HOSTS = ['toolsd.ezil.invalid', 'toolsd.ezil.invalid:9224'];
export const EXPECTED_CONTENT_TYPE = 'application/json';
export const MAX_BODY_BYTES = 40_960;
export const TS_WINDOW_MS = 60_000;
export const REPLAY_WINDOW_MS = 120_000;

/**
 * `K = HMAC-SHA256(key = UTF-8(seed), "EZIL-TOOLSD-KEY/1")`, 32 raw bytes. The
 * seed is this boot's `EZIL_AI_PROXY_TOKEN`. Returns a Buffer.
 */
export function deriveKey(seed) {
  if (typeof seed !== 'string' || seed.length === 0) throw new Error('toolsd: empty seed');
  return createHmac('sha256', Buffer.from(seed, 'utf8')).update('EZIL-TOOLSD-KEY/1').digest();
}

/** `HMAC-SHA256(K, "EZIL-TOOLSD/1\n<ts>\nPOST\n/v1/<op>\n<sha256 hex of body>")`, lowercase hex. */
export function expectedMac(key, ts, path, bodyBytes) {
  const bodyHash = createHash('sha256').update(bodyBytes).digest('hex');
  const payload = `EZIL-TOOLSD/1\n${ts}\nPOST\n${path}\n${bodyHash}`;
  return createHmac('sha256', key).update(payload).digest('hex');
}

/**
 * The replay guard: a MAC that verified once may not verify again within 120 s.
 * Entries older than the window are pruned on every check, so the set stays the
 * size of one window's traffic. `check(mac, now)` returns `true` for a replay
 * (already seen) and records a first sighting otherwise.
 */
export function createReplayCache() {
  const seen = new Map(); // mac -> firstSeenMs
  return {
    check(mac, now) {
      for (const [m, at] of seen) {
        if (now - at > REPLAY_WINDOW_MS) seen.delete(m);
      }
      if (seen.has(mac)) return true;
      seen.set(mac, now);
      return false;
    },
    get size() { return seen.size; },
  };
}

/**
 * Apply section 3.5 in order. `headers` is a plain object with LOWERCASE keys
 * (exactly what Node's `req.headers` gives). Returns `{ ok:true, op }` or
 * `{ ok:false, step }` — `step` is a diagnostic for tests and logs only; the
 * client always sees the same 401.
 *
 * `bodyBytes` is the raw request body (a Uint8Array/Buffer). The body is NOT
 * parsed here: its only roles in authentication are its byte length and its
 * sha256 inside the MAC.
 */
export function authorize({ method, path, headers, bodyBytes, now, key, replay }) {
  // 1. POST to /v1/<op>, nothing else.
  if (method !== 'POST') return deny('method');
  const pathMatch = PATH_RE.exec(path);
  if (!pathMatch) return deny('path');
  const op = pathMatch[1];

  // 2. Host is exactly the contract constant (bare or the :9224 form).
  if (!EXPECTED_HOSTS.includes(headers.host)) return deny('host');

  // 3. No browser-shaped request may reach here: an Origin or any Sec-Fetch-*
  //    header means a page's fetch, which the Worker's server-to-server call
  //    never sends. Either is an immediate refusal (a cross-origin text/plain
  //    POST from the in-computer Browser is refused by this plus check 4).
  if (headers.origin !== undefined) return deny('origin');
  for (const name of Object.keys(headers)) {
    if (name.startsWith('sec-fetch-')) return deny('sec-fetch');
  }

  // 4. Content-Type is exactly application/json (no charset, no duplication).
  if (headers['content-type'] !== EXPECTED_CONTENT_TYPE) return deny('content-type');

  // 5. Body within the bound.
  if (bodyBytes.length > MAX_BODY_BYTES) return deny('body-too-large');

  // 6. The auth header is present and well formed.
  const header = headers['x-ezil-toolsd'];
  if (typeof header !== 'string') return deny('header-missing');
  const headerMatch = HEADER_RE.exec(header);
  if (!headerMatch) return deny('header-malformed');
  const ts = headerMatch[1];
  const mac = headerMatch[2];
  const tsNum = Number(ts);
  if (!Number.isSafeInteger(tsNum) || tsNum <= 0) return deny('ts-malformed');

  // 7. Timestamp within +/- 60 s of now.
  if (Math.abs(now - tsNum) > TS_WINDOW_MS) return deny('ts-window');

  // 8. The MAC verifies (constant-time over the 64-hex strings).
  const expected = expectedMac(key, ts, path, bodyBytes);
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return deny('mac');

  // 9. The MAC has not been seen in the last 120 s.
  if (replay.check(mac, now)) return deny('replay');

  return { ok: true, op };
}

function deny(step) {
  return { ok: false, step };
}
