/**
 * Redirect-target validation for the auth-recovery fixture IdP (shared so it is testable without a browser).
 *
 * A redirect is safe only when it parses as an absolute URL whose origin is EXACTLY the configured local app
 * origin. `new URL(value)` with no base throws on a relative (`/path`), protocol-relative (`//evil`) or
 * backslash (`/\evil`) input, and a foreign or look-alike origin (`http://localhost:3187.evil.example`) fails
 * the strict origin check. Returns the normalized href to redirect to, or null to refuse — the IdP then answers
 * 404 rather than reflecting an attacker-controlled Location (js/server-side-unvalidated-url-redirection).
 */
export function safeLocalRedirect(value, appOrigin) {
    if (typeof value !== 'string' || value === '') return null;
    let url;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    return url.origin === appOrigin ? url.href : null;
}
