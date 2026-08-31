/**
 * DUPLICATED copies of three functions from `worker/src/observability.ts`:
 * `safeUserHash`, `sanitizeErrorMessage` and `classifyError`. Logic-identical
 * to the worker's originals; only indentation width differs (this repo's
 * app/ code is 4-space, the worker/ code is 2-space — each project's own
 * pre-existing convention).
 *
 * Why duplicated rather than imported: this app and the Worker are two
 * separate deployables with no shared package/workspace link (no root
 * `package.json`, no path from `app/` into `worker/`), so there is no import
 * that would work in both a Vercel build and a `wrangler deploy`. The
 * telemetry design (`docs/telemetry-design.md` §9) explicitly allows
 * "duplicate it with a test asserting the two are byte-identical" as the
 * alternative to a shared module, IF that identity is actually tested rather
 * than asserted in a comment. `sanitize.test.ts` does that: it reads
 * `worker/src/observability.ts` off disk at test time and asserts each
 * function's source text here matches the worker's, modulo indentation.
 * Edit one, the test goes red until you edit the other.
 *
 * This matters because `fingerprint.ts`'s hash depends on `sanitizeErrorMessage`
 * producing the exact same output regardless of which of the three producers
 * (shell, worker, container-via-worker) generated the original string — a
 * shell `sandbox_start_failed` and a Worker `sandbox_start_failed` at the
 * same site must fingerprint identically.
 */

/**
 * Non-reversible, deterministic, synchronous user hash (FNV-1a, 32-bit) used
 * ONLY for cross-event correlation — never for security. The raw user id never
 * appears in a log. An empty/undefined id yields `u_anon` so events remain
 * correlatable without inventing identity.
 */
export function safeUserHash(userId?: string): string {
    if (!userId || !userId.trim()) return 'u_anon';
    let h = 0x811c9dc5;
    for (let i = 0; i < userId.length; i++) {
        h ^= userId.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return 'u_' + (h >>> 0).toString(16).padStart(8, '0');
}

/** Max length any sanitized detail/error string may reach before truncation. */
export const MAX_DETAIL_LEN = 200;

/**
 * Scrub and bound an upstream error/detail string so it is safe to log.
 *
 * Redacts common secret-bearing shapes (HMAC tokens/signatures, bearer/auth
 * headers, cookies, key/secret assignments, IPv4/IPv6 addresses, s3/r2 access
 * keys) AND locations (data:/blob: URIs, full URLs, absolute filesystem
 * paths), then hard-truncates the result. Returns a stable placeholder for
 * empty input.
 *
 * 🔴 The location rules are the ones that make `docs/telemetry.md`'s "workspace
 * file names, paths, or contents are never collected" TRUE OF WHAT IS STORED.
 * `normalizeDetail`'s own path rule (N9) is not enough and never was: its
 * output feeds `ezil_error_fingerprints.normalized_detail` and the hash only,
 * while `ezil_error_events.detail` is written from THIS function's output.
 * Inspecting a fingerprint therefore makes paths look handled when they are
 * not. Anything added here must be added to the worker's twin in the same
 * commit — `sanitize.test.ts` fails otherwise.
 */
export function sanitizeErrorMessage(input: unknown): string {
    let s =
        input instanceof Error ? input.message : typeof input === 'string' ? input : String(input ?? '');
    if (!s) return '';

    s = s
        // HMAC preview tokens `t=<ms>,v1=<hex>` and bare `v1=<hex>` signatures.
        .replace(/t=\d+,v1=[0-9a-f]+/gi, '[redacted-token]')
        .replace(/v1=[0-9a-f]{8,}/gi, 'v1=[redacted-sig]')
        // Authorization / bearer / cookie headers (value may contain spaces — redact
        // to end of line; over-redaction is preferred over leaking credentials).
        .replace(/bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'bearer [redacted]')
        .replace(/(authorization|cookie|set-cookie|x-signature)\s*[:=][^\n]*/gi, '$1=[redacted]')
        // key=... / secret=... / token=... / password=... assignments.
        .replace(
            /\b(secret|access[_-]?key|secret[_-]?key|api[_-]?key|token|password|passwd|pwd|cred|credential)s?\s*[:=]\s*\S+/gi,
            '$1=[redacted]',
        )
        // AWS/R2-style access key ids and long opaque secrets.
        .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted-keyid]')
        // data:/blob: URIs (can carry whole file contents) and full URLs (path
        // segments and query strings carry both workspace paths and tokens).
        .replace(/\b(?:data|blob):[^\s'"]+/gi, '<uri>')
        .replace(/\bhttps?:\/\/[^\s'"<>)\]]+/gi, '<url>')
        // A QUOTED absolute path, whole. Quotes delimit unambiguously, so this
        // is the one case where a path containing spaces can be eaten entirely
        // — `'/home/bob/workspace/my project'` and all. It must run before the
        // unquoted rule below, which would otherwise chew the front of it.
        .replace(/(['"])(~?\/[^'"\n]{0,240})\1/g, '$1<path>$1')
        // Absolute POSIX paths. `/home/<login>/workspace/<project>` is a
        // username and a project name — user data, and the single thing this
        // rule exists for. Anchored on a `/` NOT preceded by a word char,
        // `:`, `/`, `@`, `.`, `~` or `$`, so `and/or`, `1/2`, `08/01/2026`
        // and a URL's own path are all left alone. A segment may contain
        // single spaces only when another `/` follows, so a project directory
        // named `my app` is eaten whole while `expected 200 / got 500` is
        // untouched. `:` is excluded from the segment class ON PURPOSE:
        // `file.js:12:34` keeps its line/column and `port :8444` keeps its
        // port. Those, durations, correlation ids and error codes are what
        // make a record actionable, and none of them begin with a slash.
        //
        // KNOWN RESIDUAL, stated in `docs/telemetry.md` rather than papered
        // over: an UNQUOTED path whose LAST segment contains a space
        // (`/home/u/workspace/my project failed`) is redacted only up to that
        // space, leaving `<path> project failed`. Nothing can decide where
        // such a path ends — absorbing the rest would eat the diagnosis
        // instead, which is its own failure. Interior segments and any quoted
        // path are handled above; this is the only shape left.
        .replace(/(?<![\w:/@.~$-])~?(?:\/[\w.@%+~-]+(?: [\w.@%+~-]+)*(?=\/))*\/[\w.@%+~-]+\/?/g, '<path>')
        // Windows drive paths, same shape. UNC (`\\host\share`) is NOT matched
        // on purpose — `\\n` in a JSON-escaped message would false-positive.
        .replace(/\b[a-z]:\\(?:[\w.@%+~-]+(?: [\w.@%+~-]+)*\\)*[\w.@%+~-]*/gi, '<path>')
        // IPv4 addresses (ICE candidate leakage). AFTER the path rules, so a
        // path containing an address collapses to one `<path>` rather than
        // `<path>[redacted-ip].sock`.
        .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[redacted-ip]')
        // IPv6 addresses.
        .replace(/\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi, '[redacted-ip]')
        .replace(/\s+/g, ' ')
        .trim();

    if (s.length > MAX_DETAIL_LEN) s = s.slice(0, MAX_DETAIL_LEN - 1) + '\u2026';
    return s;
}

/**
 * Map an arbitrary error into a stable, low-cardinality typed error code.
 * Falls back to `unexpected_error` so every error path is still typed.
 */
export function classifyError(input: unknown): string {
    const raw =
        input instanceof Error ? input.message : typeof input === 'string' ? input : String(input ?? '');
    const trimmed = raw.trim();
    // Special container/runtime shapes take precedence over a generic prefix so
    // e.g. `fuse: device not found` maps to a meaningful code, not just `fuse`.
    if (/fuse|device not found/i.test(trimmed)) return 'workspace_fuse_unavailable';
    if (/already (mounted|in use)/i.test(trimmed)) return 'mount_already_present';
    const m = /^([a-z][a-z0-9_]{2,64}):/i.exec(trimmed);
    if (m) return m[1].toLowerCase();
    // A bare snake_case token with no trailing message is itself a typed code.
    const bare = /^([a-z][a-z0-9_]{2,64})$/i.exec(trimmed);
    if (bare) return bare[1].toLowerCase();
    if (/timeout|timed out/i.test(trimmed)) return 'timeout';
    if (/not (found|configured)/i.test(trimmed)) return 'not_configured';
    return 'unexpected_error';
}
